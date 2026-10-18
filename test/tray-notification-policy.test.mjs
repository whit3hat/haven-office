import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { NotificationGate } = require("../dist/tray/notification-policy.js");

function item(dedupKey) {
  return { dedupKey, subject: { identifier: dedupKey }, whyNow: "Needs a decision" };
}

test("dedupe: a dedupKey that has already notified never notifies again", () => {
  let now = 0;
  const gate = new NotificationGate({ burstThreshold: 10, intervalMs: 60_000, maxPerInterval: 10 }, () => now);

  const first = gate.plan([item("a")]);
  assert.equal(first.notifications.length, 1);

  now += 1_000;
  const second = gate.plan([item("a")]);
  assert.deepEqual(second, { notifications: [], suppressedCount: 0 });
});

test("a seeded gate treats restored keys as already notified", () => {
  const gate = new NotificationGate({ burstThreshold: 10, intervalMs: 60_000, maxPerInterval: 10 }, Date.now, ["a"]);
  assert.equal(gate.hasNotified("a"), true);
  const plan = gate.plan([item("a")]);
  assert.deepEqual(plan, { notifications: [], suppressedCount: 0 });
});

test("debounce bursts: more new items than the threshold collapse into one notification", () => {
  let now = 0;
  const gate = new NotificationGate({ burstThreshold: 3, intervalMs: 60_000, maxPerInterval: 10 }, () => now);

  const plan = gate.plan([item("a"), item("b"), item("c"), item("d")]);
  assert.equal(plan.notifications.length, 1);
  assert.equal(plan.notifications[0].kind, "burst");
  assert.equal(plan.notifications[0].items.length, 4);
  assert.equal(plan.suppressedCount, 0);

  // Every item in the burst is now permanently dedup'd, individually.
  now += 1_000;
  const next = gate.plan([item("a"), item("e")]);
  assert.equal(next.notifications.length, 1);
  assert.equal(next.notifications[0].kind, "item");
  assert.equal(next.notifications[0].item.dedupKey, "e");
});

test("a batch at or below the threshold fires one notification per item", () => {
  let now = 0;
  const gate = new NotificationGate({ burstThreshold: 3, intervalMs: 60_000, maxPerInterval: 10 }, () => now);
  const plan = gate.plan([item("a"), item("b")]);
  assert.equal(plan.notifications.length, 2);
  assert.ok(plan.notifications.every((n) => n.kind === "item"));
});

test("cap per interval: items beyond the budget are held, not dropped", () => {
  let now = 0;
  const gate = new NotificationGate({ burstThreshold: 10, intervalMs: 60_000, maxPerInterval: 2 }, () => now);

  const first = gate.plan([item("a"), item("b"), item("c")]);
  assert.equal(first.notifications.length, 2);
  assert.equal(first.suppressedCount, 1);
  assert.equal(gate.hasNotified("c"), false);

  // Still within the window: no budget left, "c" stays held rather than firing.
  now += 1_000;
  const second = gate.plan([item("c")]);
  assert.deepEqual(second, { notifications: [], suppressedCount: 1 });

  // The window has rolled past the first two fires: "c" gets its turn.
  now += 60_000;
  const third = gate.plan([item("c")]);
  assert.equal(third.notifications.length, 1);
  assert.equal(third.notifications[0].item.dedupKey, "c");
});
