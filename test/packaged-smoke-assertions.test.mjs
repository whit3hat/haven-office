import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  DEGRADED_PLUGIN_STATUSES,
  assertBundledPluginsInstalled,
  findPluginRecord,
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
