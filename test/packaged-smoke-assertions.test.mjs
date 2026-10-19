import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEGRADED_PLUGIN_STATUSES,
  TRAY_READY_PREFIX,
  TRAY_TEMPLATE_ASSETS,
  assertBundledPluginsInstalled,
  assertTrayAssetsStaged,
  assertTrayReady,
  findPluginRecord,
  readTrayReadyLine,
  resourcesDirForApp,
} from "../scripts/packaged-smoke-assertions.mjs";
import { bundledPluginVersions } from "../scripts/stage-plugins.mjs";

const PINNED = [{ name: "paperclip-office", version: "0.1.2" }];

function installedRecord(overrides = {}) {
  return {
    id: "plg_1",
    pluginKey: "paperclip-office",
    packageName: "paperclip-office",
    version: "0.1.2",
    status: "installed",
    ...overrides,
  };
}

/** A fetch stub that walks a scripted list of `/api/plugins` bodies. */
function scriptedFetch(bodies) {
  let call = 0;
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    if (body instanceof Error) {
      throw body;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  impl.calls = calls;
  return impl;
}

/** Deterministic clock: every sleep advances it by the requested amount. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

test("resolves against a real server that reports the plugin installed", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/api/plugins");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([installedRecord()]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const resolved = await assertBundledPluginsInstalled({
      origin,
      plugins: PINNED,
      log: () => {},
    });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].packageName, "paperclip-office");
    assert.equal(resolved[0].version, "0.1.2");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("waits for provisioning that has not posted its install yet", async () => {
  const clock = fakeClock();
  const fetchImpl = scriptedFetch([[], [], [installedRecord()]]);

  const resolved = await assertBundledPluginsInstalled({
    origin: "http://127.0.0.1:1/",
    plugins: PINNED,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
  });

  assert.equal(resolved.length, 1);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(fetchImpl.calls[0], "http://127.0.0.1:1/api/plugins");
});

test("retries a server that is not answering /api/plugins yet", async () => {
  const clock = fakeClock();
  const fetchImpl = scriptedFetch([new Error("ECONNREFUSED"), [installedRecord()]]);

  const resolved = await assertBundledPluginsInstalled({
    origin: "http://127.0.0.1:1/",
    plugins: PINNED,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
  });

  assert.equal(resolved.length, 1);
});

for (const status of DEGRADED_PLUGIN_STATUSES) {
  test(`fails immediately on status "${status}" instead of waiting it out`, async () => {
    const clock = fakeClock();
    const fetchImpl = scriptedFetch([[installedRecord({ status })]]);

    await assert.rejects(
      assertBundledPluginsInstalled({
        origin: "http://127.0.0.1:1/",
        plugins: PINNED,
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        log: () => {},
      }),
      (error) => {
        assert.match(error.message, new RegExp(`status is "${status}"`));
        assert.match(error.message, /paperclip-office/);
        return true;
      },
    );

    // One read, no polling: a decided status does not become undecided.
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(clock.now(), 0);
  });
}

test("fails at the deadline when the plugin never appears", async () => {
  const clock = fakeClock();
  const fetchImpl = scriptedFetch([[]]);

  await assert.rejects(
    assertBundledPluginsInstalled({
      origin: "http://127.0.0.1:1/",
      plugins: PINNED,
      fetchImpl,
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
    }),
    (error) => {
      assert.match(error.message, /were not installed within 10000ms/);
      assert.match(error.message, /paperclip-office is not installed/);
      return true;
    },
  );

  assert.ok(clock.now() >= 10_000, "polled until the deadline");
});

test("fails at the deadline on a version the bundle did not stage", async () => {
  const clock = fakeClock();
  const fetchImpl = scriptedFetch([[installedRecord({ version: "0.1.1" })]]);

  await assert.rejects(
    assertBundledPluginsInstalled({
      origin: "http://127.0.0.1:1/",
      plugins: PINNED,
      fetchImpl,
      timeoutMs: 4_000,
      pollIntervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
    }),
    /installed at 0\.1\.1, not the staged 0\.1\.2/,
  );
});

test("matches on pluginKey when the server omits packageName", () => {
  const records = [{ pluginKey: "paperclip-office", version: "0.1.2", status: "installed" }];
  assert.equal(findPluginRecord(records, "paperclip-office").pluginKey, "paperclip-office");
  assert.equal(findPluginRecord(records, "something-else"), null);
});

// ---------------------------------------------------------------------------
// The menu-bar item
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * A PNG header only — signature plus IHDR, which is all readPngSize reads.
 * Enough to exercise the size check without committing binary fixtures.
 */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A throwaway `Foo.app/Contents/Resources` tree. Pass `null` to omit an asset. */
function fakeApp(assets) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-assets-"));
  const appPath = path.join(root, "Haven Office.app");
  const resourcesDir = resourcesDirForApp(appPath);
  mkdirSync(resourcesDir, { recursive: true });

  for (const [name, contents] of Object.entries(assets)) {
    if (contents === null) continue;
    writeFileSync(path.join(resourcesDir, name), contents);
  }

  return { root, appPath };
}

test("accepts the tray assets the repo actually ships", () => {
  // Staged the way electron-builder.yml stages them: build/<name> → resources
  // root. This is the guard against the committed icons drifting out of the
  // shape the packaged app needs, independent of any build running.
  const { root, appPath } = fakeApp(
    Object.fromEntries(
      TRAY_TEMPLATE_ASSETS.map((name) => [name, readFileSync(path.join(REPO_ROOT, "build", name))]),
    ),
  );

  try {
    const sizes = assertTrayAssetsStaged({ appPath, log: () => {} });
    const [oneX, twoX] = TRAY_TEMPLATE_ASSETS.map((name) => sizes[name]);
    assert.equal(twoX.width, oneX.width * 2);
    assert.equal(twoX.height, oneX.height * 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when the bundle has no menu-bar icon at all", () => {
  const { root, appPath } = fakeApp({});
  try {
    assert.throws(
      () => assertTrayAssetsStaged({ appPath, log: () => {} }),
      /has no menu-bar icon at .*trayTemplate\.png/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when only the @1x icon was staged", () => {
  // The @2x file is never named in code — macOS resolves it by filename — so
  // dropping it breaks no import and raises no error at runtime.
  const { root, appPath } = fakeApp({ "trayTemplate.png": pngHeader(16, 16) });
  try {
    assert.throws(
      () => assertTrayAssetsStaged({ appPath, log: () => {} }),
      /has no menu-bar icon at .*trayTemplate@2x\.png/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails on a zero-byte icon", () => {
  const { root, appPath } = fakeApp({
    "trayTemplate.png": Buffer.alloc(0),
    "trayTemplate@2x.png": pngHeader(32, 32),
  });
  try {
    assert.throws(() => assertTrayAssetsStaged({ appPath, log: () => {} }), /is empty or not a file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails on an icon that is not a PNG", () => {
  const { root, appPath } = fakeApp({
    "trayTemplate.png": Buffer.from("not a png at all, but definitely long enough to pass a length check"),
    "trayTemplate@2x.png": pngHeader(32, 32),
  });
  try {
    assert.throws(() => assertTrayAssetsStaged({ appPath, log: () => {} }), /is not a PNG/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when @2x is not twice @1x — e.g. the same file staged twice", () => {
  const { root, appPath } = fakeApp({
    "trayTemplate.png": pngHeader(16, 16),
    "trayTemplate@2x.png": pngHeader(16, 16),
  });
  try {
    assert.throws(
      () => assertTrayAssetsStaged({ appPath, log: () => {} }),
      /trayTemplate@2x\.png is 16x16, not twice trayTemplate\.png's 16x16/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to pretend it checked anything when given a bare executable", () => {
  assert.throws(
    () => assertTrayAssetsStaged({ appPath: "/tmp/Haven Office", log: () => {} }),
    /--app must point at the \.app bundle/,
  );
});

test("reads the tray's startup line out of interleaved app output", () => {
  const output = [
    "Server listening on http://127.0.0.1:51789\n",
    "[plugins] installing paperclip-office\n",
    `${TRAY_READY_PREFIX} icon=loaded path=/Applications/Haven Office.app/Contents/Resources/trayTemplate.png\n`,
    "some later line\n",
  ].join("");

  assert.deepEqual(readTrayReadyLine(output), {
    icon: "loaded",
    iconPath: "/Applications/Haven Office.app/Contents/Resources/trayTemplate.png",
  });
  assert.equal(readTrayReadyLine("Server listening on http://127.0.0.1:51789\n"), null);
});

test("waits for a tray line that lands after the server line", async () => {
  const clock = fakeClock();
  let output = "Server listening on http://127.0.0.1:1\n";
  let reads = 0;

  const line = await assertTrayReady({
    readOutput: () => {
      reads += 1;
      if (reads === 3) {
        output += `${TRAY_READY_PREFIX} icon=loaded path=/x/trayTemplate.png\n`;
      }
      return output;
    },
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
  });

  assert.equal(line.icon, "loaded");
  assert.equal(reads, 3);
});

test("fails immediately on icon=empty instead of waiting out the deadline", async () => {
  const clock = fakeClock();

  await assert.rejects(
    assertTrayReady({
      readOutput: () => `${TRAY_READY_PREFIX} icon=empty path=/x/trayTemplate.png\n`,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
    }),
    (error) => {
      assert.match(error.message, /empty icon image/);
      assert.match(error.message, /\/x\/trayTemplate\.png/);
      return true;
    },
  );

  // A decided verdict does not become undecided: no polling at all.
  assert.equal(clock.now(), 0);
});

test("fails at the deadline when the tray never reports in", async () => {
  const clock = fakeClock();

  await assert.rejects(
    assertTrayReady({
      readOutput: () => "Server listening on http://127.0.0.1:1\n",
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
    }),
    /never reported a menu-bar item within 5000ms/,
  );

  assert.ok(clock.now() >= 5_000, "polled until the deadline");
});

test("the line the smoke test waits for is the line the app prints", () => {
  // The smoke workflow runs scripts/ straight from a checkout with no build,
  // so the prefix cannot be imported from dist and is duplicated instead. This
  // is what keeps the copies honest; test:release-safety builds first.
  const compiled = readFileSync(path.join(REPO_ROOT, "dist", "tray", "tray-controller.js"), "utf8");
  assert.ok(
    compiled.includes(TRAY_READY_PREFIX),
    `dist/tray/tray-controller.js no longer contains "${TRAY_READY_PREFIX}" — the smoke test `
      + "would wait for a line nothing prints.",
  );
});

test("the tray assets the smoke test asserts are the ones the build stages", () => {
  // Same guard as the plugin pins below: an empty or renamed list would make
  // the whole bundle check pass without looking at anything.
  const config = readFileSync(path.join(REPO_ROOT, "electron-builder.yml"), "utf8");
  assert.equal(TRAY_TEMPLATE_ASSETS.length, 2);
  for (const name of TRAY_TEMPLATE_ASSETS) {
    assert.ok(config.includes(`from: build/${name}`), `electron-builder.yml does not stage build/${name}`);
    assert.ok(config.includes(`to: ${name}`), `electron-builder.yml does not stage ${name} at the resources root`);
  }
});

test("the pins the smoke test asserts are the pins the build stages", () => {
  // The smoke script passes bundledPluginVersions straight through, so this is
  // the guard against asserting a plugin set nothing ships: an empty list would
  // make the whole check silently pass.
  assert.ok(bundledPluginVersions.length > 0);
  for (const { name, version } of bundledPluginVersions) {
    assert.equal(typeof name, "string");
    assert.match(version, /^\d+\.\d+\.\d+/);
  }
});
