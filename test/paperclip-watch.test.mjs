import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { watch, WATCH_INTERVALS } = require("../dist/paperclip/watch.js");

/**
 * A controllable clock.
 *
 * `watch` takes its timer functions as options precisely so this suite can
 * assert the chosen delay instead of waiting it out — a backoff test that
 * really slept would take 15 minutes.
 */
function fakeTimers() {
  const scheduled = [];
  let nextId = 1;
  return {
    setTimeoutImpl(callback, ms) {
      const id = nextId++;
      scheduled.push({ id, callback, ms });
      return id;
    },
    clearTimeoutImpl(id) {
      const index = scheduled.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        scheduled.splice(index, 1);
      }
    },
    /** The delay chosen for the next tick. */
    get pendingDelay() {
      return scheduled.length > 0 ? scheduled[scheduled.length - 1].ms : null;
    },
    get pendingCount() {
      return scheduled.length;
    },
    /** Run the pending tick and wait for the async poll inside it to settle. */
    async fire() {
      const entry = scheduled.pop();
      assert.ok(entry, "expected a scheduled tick");
      entry.callback();
      await settle();
    },
  };
}

/** Let the in-flight promise chain inside a tick finish. */
async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function ok(data) {
  return { ok: true, data, status: 200 };
}

function err(reason, detail = reason) {
  return { ok: false, reason, detail };
}

test("a watch polls immediately rather than waiting out the first interval", async () => {
  const timers = fakeTimers();
  const changes = [];
  let polls = 0;

  watch({
    poll: async () => {
      polls += 1;
      return ok({ count: 1 });
    },
    onChange: (result) => changes.push(result),
    ...timers,
  });
  await settle();

  assert.equal(polls, 1);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].data, { count: 1 });
});

test("unchanged data backs off to the idle interval and does not re-notify", async () => {
  const timers = fakeTimers();
  const changes = [];

  watch({
    poll: async () => ok({ count: 1 }),
    onChange: (result) => changes.push(result),
    ...timers,
  });
  await settle();

  assert.equal(timers.pendingDelay, WATCH_INTERVALS.activeMs);

  await timers.fire();

  // Same payload: the surface is already correct, so there is nothing to tell
  // it, and the next poll can wait longer.
  assert.equal(changes.length, 1);
  assert.equal(timers.pendingDelay, WATCH_INTERVALS.idleMs);
});

test("changed data notifies and returns to the active interval", async () => {
  const timers = fakeTimers();
  const changes = [];
  let count = 0;

  watch({
    poll: async () => ok({ count: (count += 1) }),
    onChange: (result) => changes.push(result),
    ...timers,
  });
  await settle();
  await timers.fire();

  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].data, { count: 2 });
  assert.equal(timers.pendingDelay, WATCH_INTERVALS.activeMs);
});

test("an unfocused app polls far less often even when the data is changing", async () => {
  const timers = fakeTimers();
  let count = 0;

  watch({
    poll: async () => ok({ count: (count += 1) }),
    onChange: () => {},
    isFocused: () => false,
    ...timers,
  });
  await settle();

  assert.equal(timers.pendingDelay, WATCH_INTERVALS.unfocusedMs);
});

test("errors back off exponentially and are capped", async () => {
  const timers = fakeTimers();
  const changes = [];

  watch({
    poll: async () => err("server_error"),
    onChange: (result) => changes.push(result),
    ...timers,
  });
  await settle();

  assert.equal(timers.pendingDelay, WATCH_INTERVALS.errorBaseMs);

  await timers.fire();
  assert.equal(timers.pendingDelay, WATCH_INTERVALS.errorBaseMs * 2);

  await timers.fire();
  assert.equal(timers.pendingDelay, WATCH_INTERVALS.errorBaseMs * 4);

  for (let i = 0; i < 10; i += 1) {
    await timers.fire();
  }
  assert.equal(timers.pendingDelay, WATCH_INTERVALS.errorMaxMs);

  // Unlike unchanged success, every failure is delivered: the surface has to
  // be able to stop showing a stale count as if it were live.
  assert.equal(changes.length, 13);
  assert.equal(changes.every((change) => change.ok === false), true);
});

test("a rate limit uses the server's slower floor instead of the error floor", async () => {
  const timers = fakeTimers();

  watch({ poll: async () => err("rate_limited"), onChange: () => {}, ...timers });
  await settle();

  assert.equal(timers.pendingDelay, WATCH_INTERVALS.rateLimitedMs);
});

test("recovering from an error resets the backoff", async () => {
  const timers = fakeTimers();
  let failing = true;

  watch({
    poll: async () => (failing ? err("server_error") : ok({ fine: true })),
    onChange: () => {},
    ...timers,
  });
  await settle();
  await timers.fire();
  assert.equal(timers.pendingDelay, WATCH_INTERVALS.errorBaseMs * 2);

  failing = false;
  await timers.fire();
  assert.equal(timers.pendingDelay, WATCH_INTERVALS.activeMs);
});

test("stop() cancels the pending tick and never polls again", async () => {
  const timers = fakeTimers();
  let polls = 0;

  const handle = watch({
    poll: async () => {
      polls += 1;
      return ok({ count: polls });
    },
    onChange: () => {},
    ...timers,
  });
  await settle();
  assert.equal(timers.pendingCount, 1);

  handle.stop();

  assert.equal(handle.stopped, true);
  assert.equal(timers.pendingCount, 0);
  assert.equal(polls, 1);
});

test("a result arriving after stop() is discarded, not delivered", async () => {
  const timers = fakeTimers();
  const changes = [];
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });

  const handle = watch({
    poll: async () => {
      await blocked;
      return ok({ count: 1 });
    },
    onChange: (result) => changes.push(result),
    ...timers,
  });

  // Stop while the very first poll is still in flight. Delivering into a
  // destroyed Tray is how this turns into a crash.
  handle.stop();
  release();
  await settle();

  assert.equal(changes.length, 0);
  assert.equal(timers.pendingCount, 0);
});

test("a watch with nothing listening stops itself", async () => {
  const timers = fakeTimers();
  let listening = true;
  let polls = 0;

  const handle = watch({
    poll: async () => {
      polls += 1;
      return ok({ count: polls });
    },
    onChange: () => {},
    hasListeners: () => listening,
    ...timers,
  });
  await settle();
  assert.equal(polls, 1);

  listening = false;
  await timers.fire();

  assert.equal(polls, 1);
  assert.equal(handle.stopped, true);
  assert.equal(timers.pendingCount, 0);
});

test("refreshNow polls at once and clears any backoff", async () => {
  const timers = fakeTimers();
  let failing = true;
  let polls = 0;

  const handle = watch({
    poll: async () => {
      polls += 1;
      return failing ? err("server_error") : ok({ fine: true });
    },
    onChange: () => {},
    ...timers,
  });
  await settle();
  await timers.fire();
  assert.equal(timers.pendingDelay, WATCH_INTERVALS.errorBaseMs * 2);

  // The window just got focus, or the menu was opened: a stale tray is worst
  // exactly when someone is looking at it.
  failing = false;
  handle.refreshNow();
  await settle();

  assert.equal(polls, 3);
  assert.equal(timers.pendingDelay, WATCH_INTERVALS.activeMs);
});

test("refreshNow on a stopped watch does nothing", async () => {
  const timers = fakeTimers();
  let polls = 0;

  const handle = watch({
    poll: async () => {
      polls += 1;
      return ok({ count: polls });
    },
    onChange: () => {},
    ...timers,
  });
  await settle();
  handle.stop();
  handle.refreshNow();
  await settle();

  assert.equal(polls, 1);
  assert.equal(timers.pendingCount, 0);
});

test("the published intervals are ordered the way the comments claim", () => {
  // A reordering here would silently invert the whole point of the backoff, and
  // the numbers are a product decision worth pinning.
  assert.ok(WATCH_INTERVALS.activeMs < WATCH_INTERVALS.idleMs);
  assert.ok(WATCH_INTERVALS.idleMs < WATCH_INTERVALS.unfocusedMs);
  assert.ok(WATCH_INTERVALS.errorBaseMs < WATCH_INTERVALS.rateLimitedMs);
  assert.ok(WATCH_INTERVALS.rateLimitedMs < WATCH_INTERVALS.errorMaxMs);
});
