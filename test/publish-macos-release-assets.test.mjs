import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishMacosReleaseAssets } from "../scripts/publish-macos-release-assets.mjs";

// electron-builder names its artifacts from `productName`, which is
// "Haven Office" — with a space. prepare-macos-release-assets.mjs rewrites
// `[ _]+` to `-` before the publish step ever sees them, so these are the names
// that actually reach collectAssets. Keeping the spaced originals here next to
// the rewrite is the point of the fixture: if either side's naming drifts, the
// publish step stops finding its assets, and it is the only step in the release
// chain that cannot be exercised before a release exists.
const BUILDER_ARTIFACT_NAMES = [
  "Haven Office-2026.10.6.dmg",
  "Haven Office-2026.10.6-arm64.dmg",
  "Haven Office-2026.10.6-mac.zip",
  "Haven Office-2026.10.6-arm64-mac.zip",
  "Haven Office-2026.10.6.dmg.blockmap",
  "Haven Office-2026.10.6-arm64.dmg.blockmap",
  "Haven Office-2026.10.6-mac.zip.blockmap",
  "Haven Office-2026.10.6-arm64-mac.zip.blockmap",
];

function normalizeFileName(name) {
  return name.replace(/[ _]+/g, "-");
}

function makeAssetDir({ omit = [], includeLatestManifest = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "publish-mac-assets-"));
  mkdirSync(dir, { recursive: true });

  const names = BUILDER_ARTIFACT_NAMES.map(normalizeFileName).filter(
    (name) => !omit.includes(name),
  );
  if (includeLatestManifest) {
    names.push("latest-mac.yml");
  }

  for (const name of names) {
    writeFileSync(join(dir, name), "");
  }

  return dir;
}

// collectAssets runs before any `gh` call, so "got past asset collection" is
// observable as the absence of its own error. `gh` is unavailable here by
// design, which is what every call below ends up failing on instead.
function collectAssetsOutcome(mode, dir) {
  try {
    publishMacosReleaseAssets({ mode, tag: "v2026.10.6", inputDir: dir });
    return { collected: true, message: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { collected: !/Expected exactly one/.test(message), message };
  }
}

test("staging collects every renamed macOS artifact", () => {
  const dir = makeAssetDir();

  try {
    const outcome = collectAssetsOutcome("staging", dir);
    assert.equal(outcome.collected, true, `asset collection failed: ${outcome.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("final mode additionally requires latest-mac.yml", () => {
  const withManifest = makeAssetDir();
  const withoutManifest = makeAssetDir({ includeLatestManifest: false });

  try {
    assert.equal(
      collectAssetsOutcome("final", withManifest).collected,
      true,
      "final mode should accept a complete asset set",
    );

    const missing = collectAssetsOutcome("final", withoutManifest);
    assert.equal(missing.collected, false);
    assert.match(missing.message, /latest-mac\.yml/u);

    // The updater feed is only required by the final pass, so a staging upload
    // of the same directory must still succeed.
    assert.equal(
      collectAssetsOutcome("staging", withoutManifest).collected,
      true,
      "staging should not require latest-mac.yml",
    );
  } finally {
    rmSync(withManifest, { recursive: true, force: true });
    rmSync(withoutManifest, { recursive: true, force: true });
  }
});

// The x64 patterns select by a negative lookbehind on `arm64` rather than by
// listing an architecture, so "exactly one match" is not enough on its own:
// a pattern that matched both files would also have to be wrong about which.
// These assert the pairing, not just the count.
test("x64 patterns never select the arm64 artifact", () => {
  const cases = [
    ["x64 DMG", "Haven-Office-2026.10.6-arm64.dmg", "Haven-Office-2026.10.6.dmg"],
    ["x64 ZIP", "Haven-Office-2026.10.6-arm64-mac.zip", "Haven-Office-2026.10.6-mac.zip"],
    [
      "x64 DMG blockmap",
      "Haven-Office-2026.10.6-arm64.dmg.blockmap",
      "Haven-Office-2026.10.6.dmg.blockmap",
    ],
    [
      "x64 ZIP blockmap",
      "Haven-Office-2026.10.6-arm64-mac.zip.blockmap",
      "Haven-Office-2026.10.6-mac.zip.blockmap",
    ],
  ];

  for (const [label, arm64Name, x64Name] of cases) {
    // Dropping the x64 file must fail rather than silently fall back to the
    // arm64 one, which is exactly the mix-up that would publish a DMG whose
    // name promises Intel and whose contents are Apple Silicon.
    const dir = makeAssetDir({ omit: [x64Name] });

    try {
      const outcome = collectAssetsOutcome("staging", dir);
      assert.equal(outcome.collected, false, `${label}: arm64 artifact matched the x64 pattern`);
      assert.match(outcome.message, /Expected exactly one/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // And the reverse: the arm64 artifact alone must not satisfy the x64 slot.
    const arm64Only = makeAssetDir({ omit: [arm64Name] });

    try {
      assert.equal(
        collectAssetsOutcome("staging", arm64Only).collected,
        false,
        `${label}: missing arm64 artifact was not detected`,
      );
    } finally {
      rmSync(arm64Only, { recursive: true, force: true });
    }
  }
});

test("a rejected mode is refused before anything is uploaded", () => {
  const dir = makeAssetDir();

  try {
    assert.throws(
      () => publishMacosReleaseAssets({ mode: "publish", tag: "v2026.10.6", inputDir: dir }),
      /--mode must be staging or final/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
