import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeDarwinEsbuildBinaries } from "../scripts/esbuild-normalization.mjs";

// Mirrors a real cross-installed bundle, measured 2026-10-18 from `npm install
// --production --os=darwin --cpu=x64 --arch=x64` of @paperclipai/server on a
// non-darwin-x64 host: the nested `esbuild` wrapper with a host-arch
// `bin/esbuild`, a `@esbuild/<host-platform>` package npm installed instead of
// the target's, and whatever esbuild's postinstall downloaded for the host.
function writeEsbuildFixture(
  rootDir,
  relativeDir,
  version,
  contents = "wrong-architecture",
  { platformPackages = ["darwin-arm64"], downloaded = [] } = {},
) {
  const nodeModulesDir = join(rootDir, relativeDir, "node_modules");
  const packageDir = join(nodeModulesDir, "esbuild");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name: "esbuild", version })}\n`, "utf8");
  writeFileSync(join(packageDir, "bin", "esbuild"), contents, "utf8");

  for (const platform of platformPackages) {
    const platformBinDir = join(nodeModulesDir, "@esbuild", platform, "bin");
    mkdirSync(platformBinDir, { recursive: true });
    writeFileSync(join(platformBinDir, "esbuild"), `${platform}-platform-package`, "utf8");
  }

  if (downloaded.length > 0) {
    mkdirSync(join(packageDir, "lib"), { recursive: true });
    for (const name of downloaded) {
      writeFileSync(join(packageDir, "lib", name), `payload-${name}`, "utf8");
    }
  }

  return join(packageDir, "bin", "esbuild");
}

// Stands in for installDarwinEsbuildPackage: the extracted `package/` directory
// of an `npm pack @esbuild/darwin-<arch>@<version>` tarball.
function writePlatformPackageSource(rootDir, arch, version) {
  const sourceDir = join(rootDir, "platform-packages", `${arch}-${version}`, "package");
  mkdirSync(join(sourceDir, "bin"), { recursive: true });
  writeFileSync(
    join(sourceDir, "package.json"),
    `${JSON.stringify({ name: `@esbuild/darwin-${arch}`, version })}\n`,
    "utf8",
  );
  writeFileSync(join(sourceDir, "bin", "esbuild"), `darwin-${arch}-${version}`, "utf8");
  return sourceDir;
}

test("normalizeDarwinEsbuildBinaries replaces every nested esbuild binary with the target architecture", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "paperclip-esbuild-normalization-test-"));

  try {
    const firstTarget = writeEsbuildFixture(tempRoot, "", "0.28.2");
    const secondTarget = writeEsbuildFixture(tempRoot, "node_modules/@paperclipai/adapter-utils", "0.28.2");
    const thirdTarget = writeEsbuildFixture(tempRoot, "node_modules/example", "0.27.0");
    const resolveCalls = [];

    const { targets } = normalizeDarwinEsbuildBinaries({
      bundleServerDir: tempRoot,
      arch: "arm64",
      resolvePlatformPackage: ({ arch, version }) => {
        resolveCalls.push({ arch, version });
        return writePlatformPackageSource(tempRoot, arch, version);
      },
    });

    assert.equal(targets.length, 3);
    assert.deepEqual(
      resolveCalls,
      [
        { arch: "arm64", version: "0.28.2" },
        { arch: "arm64", version: "0.27.0" },
      ],
      "each esbuild version should be packed once and reused across copies",
    );
    assert.equal(readFileSync(firstTarget, "utf8"), "darwin-arm64-0.28.2");
    assert.equal(readFileSync(secondTarget, "utf8"), "darwin-arm64-0.28.2");
    assert.equal(readFileSync(thirdTarget, "utf8"), "darwin-arm64-0.27.0");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// Regression: Release Desktop #5 failed in prepare-server because the previous
// version of this module asserted the target platform package was already a
// sibling of each nested esbuild copy. It is not. A cross-install installs the
// *build host's* platform package, so the target's has to be materialized.
test("normalizeDarwinEsbuildBinaries materializes the platform package the runtime resolves", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "paperclip-esbuild-materialize-test-"));

  try {
    writeEsbuildFixture(tempRoot, "node_modules/@paperclipai/adapter-utils", "0.28.2", "wrong-architecture", {
      // What npm actually produced on the arm64 runner: only the host's package.
      platformPackages: ["darwin-arm64"],
      downloaded: ["downloaded-@esbuild-darwin-arm64-esbuild"],
    });

    const { targets } = normalizeDarwinEsbuildBinaries({
      bundleServerDir: tempRoot,
      arch: "x64",
      resolvePlatformPackage: ({ arch, version }) => writePlatformPackageSource(tempRoot, arch, version),
    });

    const nodeModulesDir = join(tempRoot, "node_modules/@paperclipai/adapter-utils/node_modules");
    assert.equal(targets[0].platformPackageDir, join(nodeModulesDir, "@esbuild", "darwin-x64"));
    assert.equal(
      readFileSync(join(nodeModulesDir, "@esbuild/darwin-x64/bin/esbuild"), "utf8"),
      "darwin-x64-0.28.2",
    );

    // The check that matters: this is the exact lookup esbuild's generateBinPath
    // performs from inside lib/main.js.
    const libDir = join(nodeModulesDir, "esbuild", "lib");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(libDir, "main.js"), "", "utf8");
    assert.equal(
      createRequire(join(libDir, "main.js")).resolve("@esbuild/darwin-x64/bin/esbuild"),
      join(nodeModulesDir, "@esbuild/darwin-x64/bin/esbuild"),
      "the materialized package must be what node resolves from the esbuild copy",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// Regression: Release Desktop #4 built both DMGs and then verify-macos-release
// rejected the x64 bundle — it still carried host-arch Mach-O binaries, both as
// `lib/downloaded-@esbuild-darwin-arm64-esbuild` and as the whole
// `@esbuild/darwin-arm64` package npm installed for the runner.
test("normalizeDarwinEsbuildBinaries prunes every host-arch leftover from a cross-installed bundle", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "paperclip-esbuild-prune-test-"));

  try {
    writeEsbuildFixture(tempRoot, "", "0.28.2", "wrong-architecture", {
      platformPackages: ["darwin-arm64", "darwin-x64"],
      downloaded: ["downloaded-@esbuild-darwin-arm64-esbuild", "downloaded-@esbuild-darwin-x64-esbuild"],
    });
    writeEsbuildFixture(tempRoot, "node_modules/@paperclipai/adapter-utils", "0.28.2", "wrong-architecture", {
      platformPackages: ["darwin-arm64"],
      downloaded: ["downloaded-@esbuild-darwin-arm64-esbuild"],
    });

    const { targets, prunedPlatformPackages } = normalizeDarwinEsbuildBinaries({
      bundleServerDir: tempRoot,
      arch: "x64",
      resolvePlatformPackage: ({ arch, version }) => writePlatformPackageSource(tempRoot, arch, version),
    });

    const libDir = join(tempRoot, "node_modules", "esbuild", "lib");
    assert.equal(
      existsSync(join(libDir, "downloaded-@esbuild-darwin-arm64-esbuild")),
      false,
      "the foreign arm64 download should be gone",
    );
    assert.equal(
      existsSync(join(libDir, "downloaded-@esbuild-darwin-x64-esbuild")),
      true,
      "a download already matching the target arch should be left alone",
    );
    assert.equal(
      existsSync(
        join(
          tempRoot,
          "node_modules/@paperclipai/adapter-utils/node_modules/esbuild/lib",
          "downloaded-@esbuild-darwin-arm64-esbuild",
        ),
      ),
      false,
      "nested copies should be pruned too",
    );

    assert.deepEqual(
      prunedPlatformPackages.map((entry) => entry.endsWith("darwin-arm64")),
      [true, true],
      "every foreign platform package should be pruned and reported",
    );
    for (const target of targets) {
      assert.deepEqual(
        readdirSync(join(target.packageDir, "..", "@esbuild")),
        ["darwin-x64"],
        "only the target platform package should survive beside each copy",
      );
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("normalizeDarwinEsbuildBinaries fails when the packed platform package has no binary", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "paperclip-esbuild-source-guard-test-"));

  try {
    writeEsbuildFixture(tempRoot, "", "0.28.2", "wrong-architecture", {
      platformPackages: ["darwin-arm64"],
      downloaded: ["downloaded-@esbuild-darwin-arm64-esbuild"],
    });

    const emptySource = join(tempRoot, "platform-packages", "empty");
    mkdirSync(emptySource, { recursive: true });

    assert.throws(
      () =>
        normalizeDarwinEsbuildBinaries({
          bundleServerDir: tempRoot,
          arch: "x64",
          resolvePlatformPackage: () => emptySource,
        }),
      /Darwin x64 esbuild 0\.28\.2 package not found/,
    );

    assert.equal(
      existsSync(join(tempRoot, "node_modules", "esbuild", "lib", "downloaded-@esbuild-darwin-arm64-esbuild")),
      true,
      "nothing should have been deleted before the guard fired",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("normalizeDarwinEsbuildBinaries rejects a bundle directory that is not there", () => {
  assert.throws(
    () =>
      normalizeDarwinEsbuildBinaries({
        bundleServerDir: join(tmpdir(), "paperclip-esbuild-absent-bundle"),
        arch: "x64",
        resolvePlatformPackage: () => "/unused",
      }),
    /Bundle server directory to normalize does not exist/,
  );
});

test("normalizeDarwinEsbuildBinaries rejects unsupported architectures", () => {
  assert.throws(
    () =>
      normalizeDarwinEsbuildBinaries({
        bundleServerDir: "/unused",
        arch: "ia32",
        resolvePlatformPackage: () => "/unused",
      }),
    /Unsupported Darwin esbuild architecture/,
  );
});
