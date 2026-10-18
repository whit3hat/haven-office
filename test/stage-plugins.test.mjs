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
  assertBundledPluginsPresent,
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
  // migrationsDir is pinned here rather than read from the plugin's manifest
  // module on purpose: nothing in this repo imports plugin code, in the build
  // or in the main process. v2026.10.10 shipped without this directory and
  // failed to install the office at runtime.
  assert.deepEqual(bundledPluginVersions, [
    { name: "paperclip-office", version: "0.1.2", migrationsDir: "migrations" },
  ]);
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
      const pin = bundledPluginVersions.find((entry) => entry.name === plugin.name);
      assert.deepEqual({ name: plugin.name, version: plugin.version }, {
        name: pin.name,
        version: pin.version,
      });
      // The directory the server readdirs during install has to be in the
      // staged copy, whatever the published tarball chose to keep it with.
      if (pin.migrationsDir) {
        assert.ok(
          fs.statSync(path.join(plugin.path, pin.migrationsDir)).isDirectory(),
          `${plugin.name} staged without its ${pin.migrationsDir} directory`,
        );
      }
      assert.ok(plugin.entrypoints.length > 0, `${plugin.name} staged with no entrypoints`);
      // No node_modules: `npm pack` ships the files whitelist, nothing resolved.
      assert.equal(fs.existsSync(path.join(plugin.path, "node_modules")), false);
    }
  },
);

// ---------------------------------------------------------------------------
// Shipping the staged directory is a separate thing from staging it, and
// v2026.10.6 and v2026.10.7 shipped without it: the staged macOS build
// generates its own electron-builder config and that config had no
// app-server/plugins mapping. These cover the guard that now catches it.
// ---------------------------------------------------------------------------

/** Writes a plugin directory straight into a `plugins` root, as the packed .app has it. */
function fakePluginsRoot(packages) {
  const root = tempDir("haven-plugins-root-");
  for (const [name, { pkg, files = [] }] of Object.entries(packages)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    for (const file of files) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "");
    }
  }
  return root;
}

test("a packed app with no plugins directory at all fails, naming the 404", () => {
  assert.throws(
    () =>
      assertBundledPluginsPresent({
        pluginsRoot: path.join(os.tmpdir(), "haven-plugins-never-packed-xyz"),
        plugins: pinned,
      }),
    /does not exist.*demo-plugin.*office route 404s/s,
  );
});

test("a packed app missing one pinned plugin fails", () => {
  const root = fakePluginsRoot({ "other-plugin": { pkg: manifest, files: manifestFiles } });

  assert.throws(
    () => assertBundledPluginsPresent({ pluginsRoot: root, plugins: pinned }),
    /demo-plugin is missing its package.json/,
  );
});

test("a packed app whose plugin lost an entrypoint fails", () => {
  const root = fakePluginsRoot({
    "demo-plugin": { pkg: manifest, files: ["dist/manifest.js", "dist/worker.js"] },
  });

  assert.throws(
    () => assertBundledPluginsPresent({ pluginsRoot: root, plugins: pinned }),
    /entrypoint "ui" \(\.\/dist\/ui\) is missing/,
  );
});

test("a correctly packed app reports the plugin, its version and its entrypoints", () => {
  const root = fakePluginsRoot({ "demo-plugin": { pkg: manifest, files: manifestFiles } });

  assert.deepEqual(assertBundledPluginsPresent({ pluginsRoot: root, plugins: pinned }), [{
    name: "demo-plugin",
    version: "1.2.3",
    path: path.join(root, "demo-plugin"),
    entrypoints: ["manifest", "ui", "worker"],
  }]);
});

test("a directory whose package.json names a different plugin is not accepted", () => {
  const root = fakePluginsRoot({
    "demo-plugin": { pkg: { ...manifest, name: "something-else" }, files: manifestFiles },
  });

  assert.throws(
    () => assertBundledPluginsPresent({ pluginsRoot: root, plugins: pinned }),
    /declares name something-else, expected demo-plugin/,
  );
});

test("an empty pinned list has nothing to ship and nothing to assert", () => {
  assert.deepEqual(
    assertBundledPluginsPresent({
      pluginsRoot: path.join(os.tmpdir(), "haven-plugins-absent-xyz"),
      plugins: [],
    }),
    [],
  );
});

/**
 * The v2026.10.10 regression, in the shape it actually shipped.
 *
 * That release passed verify-macos-release and then failed its own smoke test
 * with `ENOENT: no such file or directory, scandir .../paperclip-office/
 * migrations`. The verifier only checked entrypoints, so a packed .app missing
 * the directory the server readdirs during install was publishable.
 */
const pinnedWithMigrations = [
  { name: "demo-plugin", version: "1.2.3", migrationsDir: "migrations" },
];

test("a packed app missing the declared migrations directory is rejected", () => {
  const root = fakePluginsRoot({ "demo-plugin": { pkg: manifest, files: manifestFiles } });

  assert.throws(
    () => assertBundledPluginsPresent({ pluginsRoot: root, plugins: pinnedWithMigrations }),
    /declares a migrations directory "migrations" that is missing/,
  );
});

test("a migrations path that is a file, not a directory, is rejected", () => {
  const root = fakePluginsRoot({
    "demo-plugin": { pkg: manifest, files: [...manifestFiles, "migrations"] },
  });

  assert.throws(
    () => assertBundledPluginsPresent({ pluginsRoot: root, plugins: pinnedWithMigrations }),
    /declares a migrations directory "migrations" that is missing/,
  );
});

test("staging gives an otherwise-empty migrations directory a member that survives packaging", () => {
  // Upstream keeps it with `.gitkeep` alone, which is what did not survive.
  const sourceDir = fakeSource("demo-plugin", manifest, [...manifestFiles, "migrations/.gitkeep"]);
  const bundleDir = tempDir("haven-bundle-migrations-");

  stageBundledPlugins({ bundleDir, sourceDir, plugins: pinnedWithMigrations, log: () => {} });

  const migrationsDir = path.join(bundleDir, "plugins", "demo-plugin", "migrations");
  const kept = fs.readdirSync(migrationsDir).filter((entry) => !entry.startsWith("."));
  assert.ok(kept.length > 0, "the directory must hold a non-dotfile member");
  assert.ok(
    kept.every((entry) => !entry.endsWith(".sql")),
    "the placeholder must not look like a migration the server would run",
  );
});

test("staging never overwrites real migrations with a placeholder", () => {
  const sourceDir = fakeSource("demo-plugin", manifest, [
    ...manifestFiles,
    "migrations/0001_init.sql",
  ]);
  const bundleDir = tempDir("haven-bundle-real-migrations-");

  stageBundledPlugins({ bundleDir, sourceDir, plugins: pinnedWithMigrations, log: () => {} });

  assert.deepEqual(
    fs.readdirSync(path.join(bundleDir, "plugins", "demo-plugin", "migrations")).sort(),
    ["0001_init.sql"],
  );
});

test("staging creates the migrations directory even when the source omits it entirely", () => {
  const sourceDir = fakeSource("demo-plugin", manifest, manifestFiles);
  const bundleDir = tempDir("haven-bundle-no-migrations-");

  const staged = stageBundledPlugins({
    bundleDir,
    sourceDir,
    plugins: pinnedWithMigrations,
    log: () => {},
  });

  assert.equal(staged.length, 1);
  assert.ok(fs.statSync(path.join(bundleDir, "plugins", "demo-plugin", "migrations")).isDirectory());
});
