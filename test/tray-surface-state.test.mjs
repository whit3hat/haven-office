import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifySurfaceState, describeBadge } = require("../dist/tray/surface-state.js");

test("a successful result classifies as ok", () => {
  const state = classifySurfaceState({ ok: true, data: {}, status: 200 });
  assert.equal(state.kind, "ok");
});

test("signed_out, no_credential and forbidden all surface as the signed-out state", () => {
  for (const reason of ["signed_out", "no_credential", "forbidden"]) {
    const state = classifySurfaceState({ ok: false, reason, detail: "x" });
    assert.equal(state.kind, "signed_out");
  }
});

test("blocked_by_os gets its own distinct state and wording", () => {
  const state = classifySurfaceState({ ok: false, reason: "blocked_by_os", detail: "x" });
  assert.equal(state.kind, "os_blocked");
  assert.match(state.message, /macOS/);
});

test("unreachable and tls_error both surface as unreachable", () => {
  for (const reason of ["unreachable", "tls_error"]) {
    const state = classifySurfaceState({ ok: false, reason, detail: "x" });
    assert.equal(state.kind, "unreachable");
  }
});

test("the three required states (signed out, unreachable, os-blocked) all have distinct wording", () => {
  const signedOut = classifySurfaceState({ ok: false, reason: "signed_out", detail: "x" });
  const unreachable = classifySurfaceState({ ok: false, reason: "unreachable", detail: "x" });
  const osBlocked = classifySurfaceState({ ok: false, reason: "blocked_by_os", detail: "x" });
  const messages = new Set([signedOut.message, unreachable.message, osBlocked.message]);
  assert.equal(messages.size, 3);
});

test("an unclassified failure falls back to the client's own detail text", () => {
  const state = classifySurfaceState({ ok: false, reason: "server_error", detail: "Something specific broke" });
  assert.equal(state.kind, "error");
  assert.equal(state.message, "Something specific broke");
});

test("describeBadge never shows a live-looking count while degraded", () => {
  const ok = { kind: "ok", message: "Connected" };
  const degraded = { kind: "unreachable", message: "Server unreachable." };

  assert.equal(describeBadge(ok, 3), "3");
  assert.equal(describeBadge(ok, null), "");
  assert.equal(describeBadge(degraded, 3), "3?");
  assert.notEqual(describeBadge(degraded, 3), describeBadge(ok, 3));
  assert.equal(describeBadge(degraded, null), "");
});
