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

// esbuild's postinstall runs on the *build host*, not the target. When we
// cross-install (`npm install --cpu=x64` on an arm64 runner) it leaves two
// host-arch artifacts behind: it overwrites `<pkg>/bin/esbuild`, which
// normalizeDarwinEsbuildBinaries rewrites below, and it downloads a second copy
// to `<pkg>/lib/downloaded-@esbuild-<host-platform>-esbuild`, which nothing used
// to clean up. The latter is unreachable on the target — generateBinPath() keys
// the lookup off the *running* platform, so an Intel Mac only ever resolves
// `@esbuild/darwin-x64/bin/esbuild` (present) or a `downloaded-…-darwin-x64-…`
// name that never matches the stray arm64 file. It is dead weight, but it is
// still a Mach-O binary of the wrong arch inside the app, so
// verify-macos-release's architecture check rejects the bundle.
//
// Prune it rather than rewriting it: the filename encodes the platform it is
// for, so copying an x64 binary into a file named `…darwin-arm64…` would just be
// a differently-shaped lie.
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

// Only safe to prune once we know the target-arch package the runtime actually
// resolves is really there. Each nested `esbuild` copy has its sibling
// `@esbuild/<platform>` in the same `node_modules` directory, so this is a
// direct check rather than a re-implementation of node resolution. Failing here
// turns a silently-broken bundle into a build failure.
function assertPlatformPackagePresent(packageDir, arch) {
  const nodeModulesDir = path.dirname(packageDir);
  const platformBinary = path.join(nodeModulesDir, "@esbuild", `darwin-${arch}`, "bin", "esbuild");
  if (!existsSync(platformBinary)) {
    throw new Error(
      `Refusing to prune downloaded esbuild binaries: ${path.relative(nodeModulesDir, packageDir)} has no ` +
      `sibling @esbuild/darwin-${arch} at ${platformBinary}. The packaged app would have no esbuild binary to load.`,
    );
  }
}

export function normalizeDarwinEsbuildBinaries({ bundleServerDir, arch, resolvePlatformBinary }) {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported Darwin esbuild architecture '${arch}'.`);
  }

  const targets = collectEsbuildBinaryTargets(bundleServerDir);
  const sourceByVersion = new Map();

  for (const target of targets) {
    let sourceBinary = sourceByVersion.get(target.version);
    if (!sourceBinary) {
      sourceBinary = resolvePlatformBinary({ arch, version: target.version });
      if (!sourceBinary || !existsSync(sourceBinary)) {
        throw new Error(`Darwin ${arch} esbuild ${target.version} binary not found: ${sourceBinary ?? "unknown"}`);
      }
      sourceByVersion.set(target.version, sourceBinary);
    }

    cpSync(sourceBinary, target.binaryPath);

    assertPlatformPackagePresent(target.packageDir, arch);
    target.prunedDownloads = pruneForeignDownloadedEsbuildBinaries(target.packageDir, arch);
  }

  return targets;
}

export function installDarwinEsbuildBinary({ arch, version, cacheRootDir, execFileSync }) {
  const packageName = `@esbuild/darwin-${arch}`;
  const installDir = path.join(cacheRootDir, `${arch}-${version}`);
  const binaryPath = path.join(installDir, "package", "bin", "esbuild");

  if (existsSync(binaryPath)) return binaryPath;

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

  return binaryPath;
}
