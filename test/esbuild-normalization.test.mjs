import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeDarwinEsbuildBinaries } from "../scripts/esbuild-normalization.mjs";

// Mirrors a real cross-installed bundle: the `esbuild` wrapper, its sibling
// `@esbuild/darwin-<arch>` platform package (what the runtime actually
// resolves), and any host-arch leftovers esbuild's postinstall dropped in lib/.
function writeEsbuildFixture(
  rootDir,
  relativeDir,
  version,
  contents = "wrong-architecture",
  { platformArch = "arm64", downloaded = [] } = {},
) {
  const nodeModulesDir = join(rootDir, relativeDir, "node_modules");
  const packageDir = join(nodeModulesDir, "esbuild");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name: "esbuild", version })}\n`, "utf8");
  writeFileSync(join(packageDir, "bin", "esbuild"), contents, "utf8");

  if (platformArch) {
    const platformBinDir = join(nodeModulesDir, "@esbuild", `darwin-${platformArch}`, "bin");
    mkdirSync(platformBinDir, { recursive: true });
    writeFileSync(join(platformBinDir, "esbuild"), `darwin-${platformArch}-platform-package`, "utf8");
  }

  if (downloaded.length > 0) {
    mkdirSync(join(packageDir, "lib"), { recursive: true });
    for (const name of downloaded) {
      writeFileSync(join(packageDir, "lib", name), `payload-${name}`, "utf8");
    }
  }

  return join(packageDir, "bin", "esbuild");
}

test("normalizeDarwinEsbuildBinaries replaces every nested esbuild binary with the target architecture", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "paperclip-esbuild-normalization-test-"));

  try {
    const firstTarget = writeEsbuildFixture(tempRoot, "", "0.28.2");
    const secondTarget = writeEsbuildFixture(tempRoot, "node_modules/@paperclipai/adapter-utils", "0.28.2");
    const thirdTarget = writeEsbuildFixture(tempRoot, "node_modules/example", "0.27.0");
    const sourceByVersion = new Map();
    const resolveCalls = [];

    for (const version of ["0.28.2", "0.27.0"]) {
      const source = join(tempRoot, "platform-binaries", version, "esbuild");
      mkdirSync(join(tempRoot, "platform-binaries", version), { recursive: true });
      writeFileSync(source, `darwin-arm64-${version}`, "utf8");
      sourceByVersion.set(version, source);
    }

    const targets = normalizeDarwinEsbuildBinaries({
      bundleServerDir: tempRoot,
      arch: "arm64",
      resolvePlatformBinary: ({ arch, version }) => {
        resolveCalls.push({ arch, version });
        return sourceByVersion.get(version);
      },
    });

    assert.equal(targets.length, 3);
    assert.deepEqual(resolveCalls, [
      { arch: "arm64", version: "0.28.2" },
      { arch: "arm64", version: "0.27.0" },
    ]);
    assert.equal(readFileSync(firstTarget, "utf8"), "darwin-arm64-0.28.2");
    assert.equal(readFileSync(secondTarget, "utf8"), "darwin-arm64-0.28.2");
    assert.equal(readFileSync(thirdTarget, "utf8"), "darwin-arm64-0.27.0");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// Regression: Release Desktop #4 packaged an x64 bundle on an arm64 runner and
// verify-macos-release rejected it — the nested esbuild copies still carried
// `lib/downloaded-@esbuild-darwin-arm64-esbuild`, a Mach-O arm64 binary inside
// an x86_64 app. Normalizing bin/esbuild alone was not enough.
test("normalizeDarwinEsbuildBinaries prunes host-arch downloaded binaries from a cross-installed bundle", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "paperclip-esbuild-prune-test-"));

  try {
    writeEsbuildFixture(tempRoot, "", "0.28.2", "wrong-architecture", {
      platformArch: "x64",
      downloaded: ["downloaded-@esbuild-darwin-arm64-esbuild", "downloaded-@esbuild-darwin-x64-esbuild"],
    });
    writeEsbuildFixture(tempRoot, "node_modules/@paperclipai/adapter-utils", "0.28.2", "wrong-architecture", {
      platformArch: "x64",
      downloaded: ["downloaded-@esbuild-darwin-arm64-esbuild"],
    });

    const source = join(tempRoot, "platform-binaries", "esbuild");
    mkdirSync(join(tempRoot, "platform-binaries"), { recursive: true });
    writeFileSync(source, "darwin-x64-0.28.2", "utf8");

    const targets = normalizeDarwinEsbuildBinaries({
      bundleServerDir: tempRoot,
      arch: "x64",
      resolvePlatformBinary: () => source,
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
      targets.flatMap((target) => (target.prunedDownloads ?? []).map((entry) => entry.endsWith("arm64-esbuild"))),
      [true, true],
      "both pruned paths should be reported back to the caller",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("normalizeDarwinEsbuildBinaries refuses to prune when the target platform package is missing", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "paperclip-esbuild-prune-guard-test-"));

  try {
    // No sibling @esbuild/darwin-x64: pruning here would leave the packaged app
    // with no esbuild binary it can load at all, so this must fail the build.
    writeEsbuildFixture(tempRoot, "", "0.28.2", "wrong-architecture", {
      platformArch: null,
      downloaded: ["downloaded-@esbuild-darwin-arm64-esbuild"],
    });

    const source = join(tempRoot, "platform-binaries", "esbuild");
    mkdirSync(join(tempRoot, "platform-binaries"), { recursive: true });
    writeFileSync(source, "darwin-x64-0.28.2", "utf8");

    assert.throws(
      () =>
        normalizeDarwinEsbuildBinaries({
          bundleServerDir: tempRoot,
          arch: "x64",
          resolvePlatformBinary: () => source,
        }),
      /Refusing to prune downloaded esbuild binaries/,
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

test("normalizeDarwinEsbuildBinaries rejects unsupported architectures", () => {
  assert.throws(
    () =>
      normalizeDarwinEsbuildBinaries({
        bundleServerDir: "/unused",
        arch: "ia32",
        resolvePlatformBinary: () => "/unused",
      }),
    /Unsupported Darwin esbuild architecture/,
  );
});
