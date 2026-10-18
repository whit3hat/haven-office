import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isDismissed,
  activeDismissalKeys,
  activeItems,
  sortNewestFirst,
  newlyAppearingItems,
  dedupKeySet,
} = require("../dist/tray/attention-items.js");

function item(overrides = {}) {
  return {
    id: overrides.id ?? "row-1",
    companyId: "company-1",
    sourceKind: "decision",
    subject: { kind: "decision", id: "d1", companyId: "company-1", title: "Thing", identifier: "HAV-1", status: null, href: "/HAV/issues/HAV-1" },
    whyNow: "Needs a decision",
    decisionVerbs: [],
    inlineResolvable: false,
    dedupKey: overrides.dedupKey ?? "dedup-1",
    dismissalKey: overrides.dismissalKey ?? "attention:dedup-1",
    dismissal: overrides.dismissal ?? null,
    severity: "medium",
    rank: 0,
    activityAt: overrides.activityAt ?? "2026-10-18T12:00:00.000Z",
    createdAt: "2026-10-18T12:00:00.000Z",
    updatedAt: "2026-10-18T12:00:00.000Z",
    relatedIssue: null,
    project: null,
    queues: [],
    expiresAt: null,
    decideBy: null,
    snoozedUntil: null,
    originAgentName: null,
    ...overrides,
  };
}

test("isDismissed honours an active inline dismissal on the item itself", () => {
  const dismissed = item({ dismissal: { kind: "dismiss", dismissedAt: "2026-10-18T00:00:00.000Z", snoozedUntil: null, isActive: true } });
  assert.equal(isDismissed(dismissed, new Set()), true);
});

test("isDismissed falls back to the inbox-dismissals set", () => {
  const plain = item({ dismissalKey: "attention:x" });
  assert.equal(isDismissed(plain, new Set(["attention:x"])), true);
  assert.equal(isDismissed(plain, new Set(["attention:other"])), false);
});

test("activeDismissalKeys drops a snooze whose time has already elapsed", () => {
  const dismissals = [
    { id: "1", companyId: "c", userId: "u", itemKey: "a", kind: "snooze", dismissedAt: "x", snoozedUntil: "2000-01-01T00:00:00.000Z" },
    { id: "2", companyId: "c", userId: "u", itemKey: "b", kind: "dismiss", dismissedAt: "x", snoozedUntil: null },
  ];
  const keys = activeDismissalKeys(dismissals);
  assert.equal(keys.has("a"), false);
  assert.equal(keys.has("b"), true);
});

test("activeItems filters out dismissed items only", () => {
  const kept = item({ dedupKey: "keep", dismissalKey: "attention:keep" });
  const dropped = item({ dedupKey: "drop", dismissalKey: "attention:drop" });
  const result = activeItems([kept, dropped], new Set(["attention:drop"]));
  assert.deepEqual(result.map((i) => i.dedupKey), ["keep"]);
});

test("sortNewestFirst orders by activityAt descending", () => {
  const older = item({ dedupKey: "older", activityAt: "2026-10-01T00:00:00.000Z" });
  const newer = item({ dedupKey: "newer", activityAt: "2026-10-18T00:00:00.000Z" });
  const sorted = sortNewestFirst([older, newer]);
  assert.deepEqual(sorted.map((i) => i.dedupKey), ["newer", "older"]);
});

test("newlyAppearingItems returns only items absent from the previously-seen set, newest first", () => {
  const seenBefore = item({ dedupKey: "seen", activityAt: "2026-10-01T00:00:00.000Z" });
  const freshA = item({ dedupKey: "fresh-a", activityAt: "2026-10-18T00:00:00.000Z" });
  const freshB = item({ dedupKey: "fresh-b", activityAt: "2026-10-19T00:00:00.000Z" });

  const result = newlyAppearingItems([seenBefore, freshA, freshB], new Set(["seen"]));
  assert.deepEqual(result.map((i) => i.dedupKey), ["fresh-b", "fresh-a"]);
});

test("dedupKeySet captures the dedupKey of every item", () => {
  const keys = dedupKeySet([item({ dedupKey: "a" }), item({ dedupKey: "b" })]);
  assert.deepEqual([...keys].sort(), ["a", "b"]);
});
