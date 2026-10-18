import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

function collectEsbuildBinaryTargets(rootDir, targets = []) {
  if (!existsSync(rootDir)) return targets;

  for (const entry of readdirSync(rootDir)) {
    const full = path.join(rootDir, entry);

    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;

    if (entry === "esbuild" && path.basename(path.dirname(full)) === "node_modules") {
      const packageJsonPath = path.join(full, "package.json");
      const binaryPath = path.join(full, "bin", "esbuild");
      if (!existsSync(packageJsonPath) || !existsSync(binaryPath)) continue;

      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (typeof packageJson.version !== "string" || !packageJson.version) {
        throw new Error(`Unable to determine esbuild version from ${packageJsonPath}.`);
      }

      targets.push({
        packageDir: full,
        binaryPath,
        version: packageJson.version,
      });
      continue;
    }

    collectEsbuildBinaryTargets(full, targets);
  }

  return targets;
}

function collectEsbuildScopeDirs(rootDir, scopes = []) {
  if (!existsSync(rootDir)) return scopes;

  for (const entry of readdirSync(rootDir)) {
    const full = path.join(rootDir, entry);

    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;

    if (entry === "@esbuild" && path.basename(path.dirname(full)) === "node_modules") {
      scopes.push(full);
      continue;
    }

    collectEsbuildScopeDirs(full, scopes);
  }

  return scopes;
}

// esbuild resolves its native binary at runtime through
// `require.resolve("@esbuild/darwin-<arch>/bin/esbuild")` from inside
// `esbuild/lib/main.js` (generateBinPath, main.js:1974). Node's lookup walks
// `<esbuild>/node_modules`, then the `node_modules` directory holding the
// esbuild copy, so a platform package placed beside the copy is exactly what the
// runtime finds. Materialize it from the packed tarball rather than hoping the
// install produced it: a cross-install does not.
//
// Measured, 2026-10-18, `npm install --production --os=darwin --cpu=x64
// --arch=x64` of @paperclipai/server@2026.1001.0 on a linux-x64 host with npm
// 11.19.0: the only platform package installed is the *host's*
// (`@esbuild/linux-x64`), not the target's. `--os`/`--cpu` do not reach these
// optional platform dependencies. On GitHub's arm64 `macos-latest` runner the
// same install is what left Release Desktop #5 with no
// `@esbuild/darwin-x64` to find.
function materializePlatformPackage(packageDir, arch, sourcePackageDir) {
  const nodeModulesDir = path.dirname(packageDir);
  const targetDir = path.join(nodeModulesDir, "@esbuild", `darwin-${arch}`);

  mkdirSync(path.dirname(targetDir), { recursive: true });
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourcePackageDir, targetDir, { recursive: true });

  const platformBinary = path.join(targetDir, "bin", "esbuild");
  if (!existsSync(platformBinary)) {
    throw new Error(
      `Materialized @esbuild/darwin-${arch} at ${targetDir} but it has no bin/esbuild. ` +
      "The packaged app would have no esbuild binary to load.",
    );
  }

  return targetDir;
}

// Two kinds of host-arch leftover ride along in a cross-installed bundle, and
// both are Mach-O binaries of the wrong architecture inside the app, which
// verify-macos-release rejects (correctly — see Release Desktop #4):
//
//   1. `@esbuild/<host-platform>`, the platform package npm installed for the
//      build host instead of the target.
//   2. `<esbuild>/lib/downloaded-@esbuild-<host-platform>-esbuild`, downloaded
//      by esbuild's postinstall when it could not resolve (1) for the host.
//
// Neither is reachable on the target: generateBinPath keys both names off the
// *running* platform, so a darwin-x64 app only ever looks for
// `@esbuild/darwin-x64` or `downloaded-@esbuild-darwin-x64-esbuild`. Prune them
// rather than rewriting them in place — the names encode the platform they are
// for, so writing an x64 binary into a file named `…darwin-arm64…` would just be
// a differently-shaped lie.
function pruneForeignPlatformPackages(bundleServerDir, arch) {
  const keep = `darwin-${arch}`;
  const pruned = [];

  for (const scopeDir of collectEsbuildScopeDirs(bundleServerDir)) {
    for (const entry of readdirSync(scopeDir)) {
      if (entry === keep) continue;
      const full = path.join(scopeDir, entry);
      rmSync(full, { recursive: true, force: true });
      pruned.push(full);
    }
  }

  return pruned;
}

function pruneForeignDownloadedEsbuildBinaries(packageDir, arch) {
  const libDir = path.join(packageDir, "lib");
  if (!existsSync(libDir)) return [];

  const keep = `downloaded-@esbuild-darwin-${arch}-esbuild`;
  const pruned = [];

  for (const entry of readdirSync(libDir)) {
    if (!entry.startsWith("downloaded-@esbuild-") || entry === keep) continue;
    const full = path.join(libDir, entry);
    rmSync(full, { force: true });
    pruned.push(full);
  }

  return pruned;
}

export function normalizeDarwinEsbuildBinaries({ bundleServerDir, arch, resolvePlatformPackage }) {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported Darwin esbuild architecture '${arch}'.`);
  }
  // A mistyped bundle path otherwise normalizes nothing and reports success,
  // which is the failure mode that is hardest to notice.
  if (!bundleServerDir || !existsSync(bundleServerDir)) {
    throw new Error(`Bundle server directory to normalize does not exist: ${bundleServerDir ?? "unknown"}`);
  }

  const targets = collectEsbuildBinaryTargets(bundleServerDir);
  const sourceByVersion = new Map();

  for (const target of targets) {
    let sourcePackageDir = sourceByVersion.get(target.version);
    if (!sourcePackageDir) {
      sourcePackageDir = resolvePlatformPackage({ arch, version: target.version });
      const sourceBinary = sourcePackageDir
        ? path.join(sourcePackageDir, "bin", "esbuild")
        : null;
      if (!sourceBinary || !existsSync(sourceBinary)) {
        throw new Error(
          `Darwin ${arch} esbuild ${target.version} package not found: ${sourcePackageDir ?? "unknown"}`,
        );
      }
      sourceByVersion.set(target.version, sourcePackageDir);
    }

    // The CLI entry point: esbuild's postinstall overwrites bin/esbuild with the
    // host binary so direct invocations skip the JS shim.
    cpSync(path.join(sourcePackageDir, "bin", "esbuild"), target.binaryPath);

    // The JS API entry point, which is what the server actually uses.
    target.platformPackageDir = materializePlatformPackage(target.packageDir, arch, sourcePackageDir);
    target.prunedDownloads = pruneForeignDownloadedEsbuildBinaries(target.packageDir, arch);
  }

  const prunedPlatformPackages = pruneForeignPlatformPackages(bundleServerDir, arch);

  return { targets, prunedPlatformPackages };
}

export function installDarwinEsbuildPackage({ arch, version, cacheRootDir, execFileSync }) {
  const packageName = `@esbuild/darwin-${arch}`;
  const installDir = path.join(cacheRootDir, `${arch}-${version}`);
  const packageDir = path.join(installDir, "package");
  const binaryPath = path.join(packageDir, "bin", "esbuild");

  if (existsSync(binaryPath)) return packageDir;

  mkdirSync(installDir, { recursive: true });
  const packOutput = execFileSync(
    "npm",
    ["pack", `${packageName}@${version}`, "--pack-destination", installDir, "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const packResult = JSON.parse(packOutput);
  const archiveName = packResult?.[0]?.filename;
  if (typeof archiveName !== "string" || !archiveName) {
    throw new Error(`npm pack did not return an archive for ${packageName}@${version}.`);
  }
  execFileSync(
    "tar",
    ["-xzf", path.join(installDir, archiveName), "-C", installDir],
    { stdio: "inherit" },
  );

  if (!existsSync(binaryPath)) {
    throw new Error(`npm pack did not contain ${packageName}@${version} at ${binaryPath}.`);
  }

  return packageDir;
}
