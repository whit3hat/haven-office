/**
 * Staging checks for the plugins preinstalled into the bundled local server.
 *
 * The layout assertions run against fixtures. One test downloads the real
 * pinned package from npm and stages it, which is the furthest a Linux runner
 * can go — the packaged .app itself needs macOS (H5's smoke run). Set
 * `HAVEN_OFFICE_SKIP_NETWORK_TESTS=1` to skip that one offline.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  bundledPluginVersions,
  fetchBundledPluginPackages,
  stageBundledPlugins,
} from "../scripts/stage-plugins.mjs";

const tempRoots = [];

after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** Writes a fake already-downloaded plugin package to act as a staging source. */
function fakeSource(name, pkg, files = []) {
  const sourceDir = tempDir("haven-plugin-src-");
  const dir = path.join(sourceDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const file of files) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
  }
  return sourceDir;
}

const manifest = {
  name: "demo-plugin",
  version: "1.2.3",
  paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js", ui: "./dist/ui" },
};
const manifestFiles = ["dist/manifest.js", "dist/worker.js", "dist/ui/index.js"];
const pinned = [{ name: "demo-plugin", version: "1.2.3" }];

test("the pinned list is what the provisioning contract documents", () => {
  assert.deepEqual(bundledPluginVersions, [{ name: "paperclip-office", version: "0.1.2" }]);
});

test("staging copies the package under <bundle>/plugins/<name>", () => {
  const sourceDir = fakeSource("demo-plugin", manifest, manifestFiles);
  const bundleDir = tempDir("haven-bundle-");

  const staged = stageBundledPlugins({ bundleDir, sourceDir, plugins: pinned, log: () => {} });

  assert.deepEqual(staged, [{
    name: "demo-plugin",
    version: "1.2.3",
    path: path.join(bundleDir, "plugins", "demo-plugin"),
    entrypoints: ["manifest", "ui", "worker"],
  }]);
  for (const file of ["package.json", ...manifestFiles]) {
    assert.ok(
      fs.existsSync(path.join(bundleDir, "plugins", "demo-plugin", file)),
      `expected ${file} in the staged bundle`,
    );
  }
});

test("an empty plugin list stages nothing and creates no directory", () => {
  const bundleDir = tempDir("haven-bundle-");
  const staged = stageBundledPlugins({
    bundleDir,
    sourceDir: tempDir("haven-plugin-src-"),
    plugins: [],
    log: () => {},
  });

  assert.deepEqual(staged, []);
  assert.equal(fs.existsSync(path.join(bundleDir, "plugins")), false);
});

test("a package that drifts from the pinned version fails the build", () => {
  const sourceDir = fakeSource("demo-plugin", { ...manifest, version: "1.2.4" }, manifestFiles);
  assert.throws(
    () => stageBundledPlugins({ bundleDir: tempDir("haven-bundle-"), sourceDir, plugins: pinned, log: () => {} }),
    /staged version 1\.2\.4 does not match the pinned 1\.2\.3/,
  );
});

test("a missing entrypoint fails the build rather than the first launch", () => {
  const sourceDir = fakeSource("demo-plugin", manifest, ["dist/manifest.js", "dist/ui/index.js"]);
  assert.throws(
    () => stageBundledPlugins({ bundleDir: tempDir("haven-bundle-"), sourceDir, plugins: pinned, log: () => {} }),
    /entrypoint "worker" \(\.\/dist\/worker\.js\) is missing/,
  );
});

test("a package with no paperclipPlugin entrypoints fails the build", () => {
  for (const entrypoints of [undefined, {}, null, "./dist"]) {
    const sourceDir = fakeSource("demo-plugin", { ...manifest, paperclipPlugin: entrypoints }, manifestFiles);
    assert.throws(
      () => stageBundledPlugins({ bundleDir: tempDir("haven-bundle-"), sourceDir, plugins: pinned, log: () => {} }),
      /declares no "paperclipPlugin" entrypoints/,
      `expected ${JSON.stringify(entrypoints)} to be rejected`,
    );
  }
});

test(
  "the real pinned package downloads and stages with every entrypoint present",
  { skip: process.env.HAVEN_OFFICE_SKIP_NETWORK_TESTS === "1" ? "network tests disabled" : false },
  () => {
    const downloadDir = path.join(tempDir("haven-plugin-pack-"), "plugins");
    const bundleDir = tempDir("haven-bundle-");

    fetchBundledPluginPackages({ downloadDir, cwd: process.cwd(), log: () => {} });
    const staged = stageBundledPlugins({ bundleDir, sourceDir: downloadDir, log: () => {} });

    assert.equal(staged.length, bundledPluginVersions.length);
    for (const plugin of staged) {
      assert.deepEqual(
        { name: plugin.name, version: plugin.version },
        bundledPluginVersions.find((pinned) => pinned.name === plugin.name),
      );
      assert.ok(plugin.entrypoints.length > 0, `${plugin.name} staged with no entrypoints`);
      // No node_modules: `npm pack` ships the files whitelist, nothing resolved.
      assert.equal(fs.existsSync(path.join(plugin.path, "node_modules")), false);
    }
  },
);
