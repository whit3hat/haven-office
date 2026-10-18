import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

// node-gyp compiles native addons in place and leaves the whole intermediate
// tree behind next to the addon it produced: relocatable objects, static
// archives, dependency lists and the generated makefiles. Only the linked
// `*.node` is ever loaded at runtime, so everything else is dead weight that
// rides along inside the app bundle.
//
// On macOS it is worse than dead weight. A `*.o` is a Mach-O file, so
// `@electron/osx-sign` hands it to `codesign`, which cannot sign a
// relocatable object — the file stays unsigned and
// `codesign --verify --strict` later reports "code object is not signed at
// all". That is what failed `Release Desktop` #6 on
// cpu-features/build/Release/obj.target/cpu_features/deps/cpu_features/src/
// filesystem.o. Pruning is the fix on both signing paths; see
// scripts/verify-macos-release.mjs for why the verifier also stops demanding a
// signature on a relocatable object.
//
// Deliberately conservative on two axes. It only descends into a `build`
// directory node-gyp demonstrably wrote — plenty of pure-JavaScript packages
// ship a `build/` of compiled JavaScript, so the directory name alone is not
// the signal (see GYP_BUILD_DIR_MARKERS) — and within one it only removes
// intermediates it can name. Every `*.node` addon and every `*.dylib`/`*.so`
// shared library is left alone, because those are load-bearing outputs rather
// than intermediates.
const INTERMEDIATE_EXTENSIONS = new Set([
  ".o", // relocatable object
  ".obj", // relocatable object (MSVC naming)
  ".a", // static archive
  ".d", // gcc/clang dependency list
  ".lib", // import/static library (Windows)
  ".pdb", // debug database (Windows)
  ".ilk", // incremental link state (Windows)
  ".exp", // export file (Windows)
  ".tlog", // MSBuild log
]);

const INTERMEDIATE_FILENAMES = new Set([
  "Makefile",
  "makefile",
  "config.gypi",
  "gyp-mac-tool",
  "binding.Makefile",
  ".ninja_deps",
  ".ninja_log",
  "build.ninja",
  "rules.ninja",
]);

const INTERMEDIATE_DIRNAMES = new Set([
  ".deps", // gcc/clang dependency lists
]);

// Entries node-gyp writes into its output directory and a JavaScript `build/`
// never has. Measured against the real cross-installed @paperclipai/server
// tree: of its 15 `build` directories, only ssh2's native sshcrypto binding
// carries any of these, and all 14 JavaScript ones (three, pino, yargs,
// @grpc/grpc-js, @opentelemetry/api, …) carry none.
const GYP_BUILD_DIR_MARKERS = ["config.gypi", "binding.Makefile", "Release", "Debug"];

function isGypBuildDir(buildDir) {
  return GYP_BUILD_DIR_MARKERS.some((marker) => existsSync(path.join(buildDir, marker)));
}

function isIntermediateFile(filePath) {
  const base = path.basename(filePath);
  if (INTERMEDIATE_FILENAMES.has(base)) return true;
  if (base.endsWith(".target.mk") || base.endsWith(".mk")) return true;
  if (base.endsWith(".ninja")) return true;
  return INTERMEDIATE_EXTENSIONS.has(path.extname(base));
}

function isIntermediateDir(dirPath) {
  const base = path.basename(dirPath);
  return INTERMEDIATE_DIRNAMES.has(base) || base.endsWith(".dSYM");
}

/**
 * Removes intermediates under one `build` directory and reports what went.
 * Returns the removed paths plus whether the directory still holds anything.
 */
function pruneBuildDir(buildDir, removed) {
  let keptEntries = 0;

  for (const entry of readdirSync(buildDir)) {
    const full = path.join(buildDir, entry);

    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      keptEntries += 1;
      continue;
    }

    // Never follow a symlink out of the tree we were asked to prune.
    if (stat.isSymbolicLink()) {
      keptEntries += 1;
      continue;
    }

    if (stat.isDirectory()) {
      if (isIntermediateDir(full)) {
        rmSync(full, { recursive: true, force: true });
        removed.push(full);
        continue;
      }

      const childKept = pruneBuildDir(full, removed);
      if (childKept === 0) {
        // An intermediate directory such as `obj.target` that held nothing but
        // intermediates. Drop the now-empty shell too.
        rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } else {
        keptEntries += 1;
      }
      continue;
    }

    if (isIntermediateFile(full)) {
      rmSync(full, { force: true });
      removed.push(full);
      continue;
    }

    keptEntries += 1;
  }

  return keptEntries;
}

function collectBuildDirs(rootDir, buildDirs = []) {
  if (!existsSync(rootDir)) return buildDirs;

  for (const entry of readdirSync(rootDir)) {
    const full = path.join(rootDir, entry);

    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;

    // `<package>/build` is node-gyp's output directory — but only when node-gyp
    // actually wrote it. Record those and stop descending, since anything below
    // is handled by pruneBuildDir. A JavaScript `build/` is walked past
    // untouched, in case a native package sits somewhere beneath it.
    if (entry === "build" && isGypBuildDir(full)) {
      buildDirs.push(full);
      continue;
    }

    collectBuildDirs(full, buildDirs);
  }

  return buildDirs;
}

/**
 * Prunes node-gyp build intermediates from an assembled server bundle.
 *
 * @param {object} options
 * @param {string} options.bundleServerDir Assembled bundle's `server` directory.
 * @returns {{ removed: string[], buildDirs: string[] }}
 */
export function pruneNativeBuildIntermediates({ bundleServerDir }) {
  if (!bundleServerDir) {
    throw new Error("pruneNativeBuildIntermediates requires a bundleServerDir.");
  }

  const nodeModulesDir = path.join(bundleServerDir, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    throw new Error(
      `Cannot prune native build intermediates: ${nodeModulesDir} does not exist.`,
    );
  }

  const buildDirs = collectBuildDirs(nodeModulesDir);
  const removed = [];

  for (const buildDir of buildDirs) {
    pruneBuildDir(buildDir, removed);
  }

  return { removed, buildDirs };
}

export const nativeBuildIntermediateMatchers = {
  isIntermediateFile,
  isIntermediateDir,
};
