import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  PREINSTALL_ENV_VAR,
  findInstalledPlugin,
  isPreinstallEnabled,
  provisionBundledPlugins,
  readStagedPlugins,
  resolveProvisioningAction,
} from "../dist/connection/plugin-provisioning.js";

const tempRoots = [];

after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function stagePluginsRoot(packages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haven-plugins-"));
  tempRoots.push(root);

  for (const [dirName, pkg] of Object.entries(packages)) {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    if (pkg !== null) {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    }
  }

  return root;
}

const officePackage = {
  name: "paperclip-office",
  version: "0.1.2",
  paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js", ui: "./dist/ui/" },
};

const staged = { packageName: "paperclip-office", version: "0.1.2", localPath: "/bundle/plugins/paperclip-office" };

function record(overrides = {}) {
  return {
    id: "plugin-1",
    pluginKey: "paperclip-office",
    packageName: "paperclip-office",
    version: "0.1.2",
    status: "ready",
    ...overrides,
  };
}

test("preinstall is on by default and off only for an explicit falsey value", () => {
  assert.equal(isPreinstallEnabled({}), true);
  assert.equal(isPreinstallEnabled({ [PREINSTALL_ENV_VAR]: "" }), true);
  assert.equal(isPreinstallEnabled({ [PREINSTALL_ENV_VAR]: "1" }), true);
  assert.equal(isPreinstallEnabled({ [PREINSTALL_ENV_VAR]: "0" }), false);
  assert.equal(isPreinstallEnabled({ [PREINSTALL_ENV_VAR]: "FALSE" }), false);
});

test("a plugin the server has never seen is installed from the bundle", () => {
  assert.deepEqual(resolveProvisioningAction(staged, null), {
    kind: "install",
    localPath: staged.localPath,
  });
});

test("a matching installed version is left alone", () => {
  const action = resolveProvisioningAction(staged, record());
  assert.equal(action.kind, "skip");
  assert.match(action.reason, /already at 0\.1\.2/);
});

test("a stale installed version is upgraded from the bundle", () => {
  assert.deepEqual(resolveProvisioningAction(staged, record({ version: "0.1.1" })), {
    kind: "upgrade",
    pluginId: "plugin-1",
    fromVersion: "0.1.1",
    toVersion: "0.1.2",
  });
});

test("operator-owned statuses are never overridden by a relaunch", () => {
  for (const status of ["uninstalled", "disabled", "upgrade_pending", "error"]) {
    const action = resolveProvisioningAction(staged, record({ status, version: "0.1.1" }));
    assert.equal(action.kind, "skip", `expected ${status} to be skipped`);
  }
});

test("an installed plugin is matched by package name, then by plugin key", () => {
  assert.equal(findInstalledPlugin(staged, [record({ id: "by-name" })])?.id, "by-name");
  assert.equal(
    findInstalledPlugin(staged, [record({ id: "by-key", packageName: "something-else" })])?.id,
    "by-key",
  );
  assert.equal(findInstalledPlugin(staged, [record({ pluginKey: "other", packageName: "other" })]), null);
});

test("staged plugins are read from package.json without importing plugin code", () => {
  const root = stagePluginsRoot({
    "paperclip-office": officePackage,
    "not-a-plugin": { name: "not-a-plugin", version: "1.0.0" },
    unreadable: null,
  });

  const result = readStagedPlugins(root);
  assert.equal(result.length, 1);
  assert.equal(result[0].packageName, "paperclip-office");
  assert.equal(result[0].version, "0.1.2");
  assert.equal(result[0].localPath, path.join(root, "paperclip-office"));
});

test("a missing plugins directory yields no work", () => {
  assert.deepEqual(readStagedPlugins(path.join(os.tmpdir(), "haven-plugins-absent-xyz")), []);
});

test("nothing staged is said out loud, not passed over in silence", async () => {
  // This exact branch is what a build packaged without its plugins directory
  // hit, and it used to return with no log line at all — so an app with no
  // office was indistinguishable in the log from an app with nothing to
  // install, and the only symptom was a 404 on the view it opens on.
  const absent = path.join(os.tmpdir(), "haven-plugins-absent-xyz");
  const logs = [];
  const outcomes = await provisionBundledPlugins({
    origin: "http://127.0.0.1:3100",
    pluginsRoot: absent,
    fetchImpl: () => {
      throw new Error("no request should be made when nothing is staged");
    },
    env: {},
    log: (message) => logs.push(message),
  });

  assert.deepEqual(outcomes, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /No bundled plugins found/);
  assert.ok(logs[0].includes(absent), `the log should name the path it looked in: ${logs[0]}`);
});

test("provisioning installs a staged plugin over the local server's own API", async () => {
  const root = stagePluginsRoot({ "paperclip-office": officePackage });
  const calls = [];

  const outcomes = await provisionBundledPlugins({
    origin: "http://localhost:4321",
    pluginsRoot: root,
    log: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), method: init?.method ?? "GET", body: init?.body ?? null });
      if (url.toString().endsWith("/api/plugins")) {
        return new Response("[]", { status: 200 });
      }
      return new Response(JSON.stringify({ id: "plugin-1" }), { status: 200 });
    },
  });

  assert.deepEqual(outcomes, [
    { packageName: "paperclip-office", action: "install", detail: "installed 0.1.2", ok: true },
  ]);
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    "GET /api/plugins",
    "POST /api/plugins/install",
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), {
    packageName: path.join(root, "paperclip-office"),
    isLocalPath: true,
  });
});

test("provisioning upgrades in place when the bundle ships a newer version", async () => {
  const root = stagePluginsRoot({ "paperclip-office": officePackage });
  const calls = [];

  const outcomes = await provisionBundledPlugins({
    origin: "http://localhost:4321",
    pluginsRoot: root,
    log: () => {},
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url.toString()).pathname}`);
      if (url.toString().endsWith("/api/plugins")) {
        return new Response(JSON.stringify([record({ version: "0.1.1" })]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  });

  assert.deepEqual(outcomes, [
    { packageName: "paperclip-office", action: "upgrade", detail: "upgraded to 0.1.2", ok: true },
  ]);
  assert.deepEqual(calls, ["GET /api/plugins", "POST /api/plugins/plugin-1/upgrade"]);
});

test("a failed install is reported but never thrown, so the app still opens", async () => {
  const root = stagePluginsRoot({ "paperclip-office": officePackage });

  const outcomes = await provisionBundledPlugins({
    origin: "http://localhost:4321",
    pluginsRoot: root,
    log: () => {},
    fetchImpl: async (url) =>
      url.toString().endsWith("/api/plugins")
        ? new Response("[]", { status: 200 })
        : new Response(JSON.stringify({ error: "bad manifest" }), { status: 400 }),
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].detail, /HTTP 400/);
  assert.match(outcomes[0].detail, /bad manifest/);
});

test("an unreadable plugin list degrades instead of installing blindly", async () => {
  const root = stagePluginsRoot({ "paperclip-office": officePackage });
  let installCalled = false;

  const outcomes = await provisionBundledPlugins({
    origin: "http://localhost:4321",
    pluginsRoot: root,
    log: () => {},
    fetchImpl: async (url) => {
      if (url.toString().endsWith("/api/plugins")) {
        throw new Error("connection refused");
      }
      installCalled = true;
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(installCalled, false);
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].detail, /connection refused/);
});

test("the preinstall switch short-circuits every request", async () => {
  const root = stagePluginsRoot({ "paperclip-office": officePackage });
  let fetched = false;

  const outcomes = await provisionBundledPlugins({
    origin: "http://localhost:4321",
    pluginsRoot: root,
    env: { [PREINSTALL_ENV_VAR]: "0" },
    log: () => {},
    fetchImpl: async () => {
      fetched = true;
      return new Response("[]", { status: 200 });
    },
  });

  assert.deepEqual(outcomes, []);
  assert.equal(fetched, false);
});
