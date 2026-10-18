import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildMenuModel, DEFAULT_TRAY_SETTINGS } = require("../dist/tray/menu-model.js");

const OK = { kind: "ok", message: "Connected" };

function item(overrides = {}) {
  return {
    dedupKey: overrides.dedupKey ?? "dedup-1",
    subject: { identifier: "HAV-1", title: "Thing", href: "/HAV/issues/HAV-1" },
    whyNow: "Needs a decision",
    relatedIssue: null,
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    surfaceState: OK,
    items: [],
    connectionName: "havenCo lab",
    settings: DEFAULT_TRAY_SETTINGS,
    ...overrides,
  };
}

test("a degraded surface state renders as a single disabled label, no items", () => {
  const entries = buildMenuModel(baseInput({
    surfaceState: { kind: "signed_out", message: "Signed out — open Haven Office to sign in." },
    items: [item()],
  }));
  const labelRow = entries.find((e) => e.id === "surface-state");
  assert.ok(labelRow);
  assert.equal(labelRow.enabled, false);
  assert.equal(labelRow.label, "Signed out — open Haven Office to sign in.");
  assert.equal(entries.some((e) => e.kind === "action" && e.action?.kind === "open-item"), false);
});

test("an ok surface with no items shows an explicit empty state, not a blank menu", () => {
  const entries = buildMenuModel(baseInput());
  assert.ok(entries.find((e) => e.id === "empty"));
});

test("items render newest-first order as given, each pointing at its own href", () => {
  const a = item({ dedupKey: "a" });
  const b = item({ dedupKey: "b", subject: { identifier: "HAV-2", href: "/HAV/issues/HAV-2" } });
  const entries = buildMenuModel(baseInput({ items: [a, b] }));

  const itemRows = entries.filter((e) => e.id.startsWith("item-"));
  assert.deepEqual(itemRows.map((e) => e.id), ["item-a", "item-b"]);
  assert.equal(itemRows[0].action.kind, "open-item");
  assert.equal(itemRows[0].action.href, "/HAV/issues/HAV-1");
  assert.equal(itemRows[1].action.href, "/HAV/issues/HAV-2");
});

test("an item with no resolvable href renders disabled rather than a dead click", () => {
  const noHref = item({ dedupKey: "no-href", subject: { identifier: "HAV-3", href: null }, relatedIssue: null });
  const entries = buildMenuModel(baseInput({ items: [noHref] }));
  const row = entries.find((e) => e.id === "item-no-href");
  assert.equal(row.enabled, false);
  assert.equal(row.action, undefined);
});

test("more items than the visible cap collapse into a '+N more' row", () => {
  const items = Array.from({ length: 5 }, (_, i) => item({ dedupKey: `k${i}` }));
  const entries = buildMenuModel(baseInput({ items, maxVisibleItems: 3 }));
  assert.equal(entries.filter((e) => e.id.startsWith("item-")).length, 3);
  const more = entries.find((e) => e.id === "more");
  assert.equal(more.label, "+2 more");
});

test("the menu always offers Open Office and Open Board, and a quit action", () => {
  const entries = buildMenuModel(baseInput());
  const office = entries.find((e) => e.action?.kind === "open-view" && e.action.viewKey === "office");
  const board = entries.find((e) => e.action?.kind === "open-view" && e.action.viewKey === "board");
  const quit = entries.find((e) => e.action?.kind === "quit");
  assert.ok(office && office.accelerator);
  assert.ok(board);
  assert.ok(quit);
});

test("the connection name and both settings toggles are reflected in the model", () => {
  const entries = buildMenuModel(baseInput({
    connectionName: "My Lab",
    settings: { notificationsEnabled: false, keepRunningInMenuBar: true },
  }));
  assert.ok(entries.find((e) => e.id === "connection-name" && e.label === "My Lab"));
  const notifToggle = entries.find((e) => e.id === "toggle-notifications");
  assert.equal(notifToggle.kind, "checkbox");
  assert.equal(notifToggle.checked, false);
  const keepRunning = entries.find((e) => e.id === "toggle-keep-running");
  assert.equal(keepRunning.checked, true);
});

test("no connection name falls back to an explicit 'not connected' label", () => {
  const entries = buildMenuModel(baseInput({ connectionName: null }));
  assert.ok(entries.find((e) => e.id === "connection-name" && e.label === "Not connected"));
});
