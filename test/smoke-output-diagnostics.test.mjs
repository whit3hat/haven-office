import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectDiagnosticLines,
  formatFailureDetail,
  tailLines,
} from "../scripts/smoke-output-diagnostics.mjs";

/**
 * Reproduces the shape of the output that defeated the old 80-line tail: one
 * `[plugins]` line at boot, then minutes of the server's own per-request
 * logging. The whole point is that the diagnosis survives the flood.
 */
function outputWithBuriedProvisioningLine(noiseLines, pluginLine) {
  const lines = ["[local-server] Server listening on http://127.0.0.1:3100", pluginLine];
  for (let index = 0; index < noiseLines; index += 1) {
    lines.push(`{"level":30,"msg":"GET /plugins 200","req":{"id":${index}}}`);
  }
  return lines.join("\n");
}

test("keeps a provisioning line the tail window would have dropped", () => {
  const pluginLine = "[plugins] paperclip-office could not be provisioned: HTTP 500: boom";
  const output = outputWithBuriedProvisioningLine(500, pluginLine);

  assert.ok(
    !tailLines(output, 80).some((line) => line.includes("[plugins]")),
    "precondition: the plugin line must be outside the tail window",
  );

  const detail = formatFailureDetail(output);
  assert.ok(detail.includes(pluginLine), "the provisioning line must survive into the failure detail");
});

test("reports the absence of provisioning lines as a finding, not as silence", () => {
  const detail = formatFailureDetail('{"level":30,"msg":"GET /plugins 200"}');

  assert.ok(detail.includes("never reached"));
  assert.deepEqual(
    collectDiagnosticLines('{"level":30,"msg":"GET /plugins 200"}'),
    [],
    "must not invent a provisioning line",
  );
});

test("collects marker lines in written order and keeps both markers", () => {
  const output = [
    "[local-server] Server listening on http://127.0.0.1:3100",
    "noise",
    "[plugins] Installing paperclip-office@0.1.2 from the app bundle...",
    "[plugins] paperclip-office: already at 0.1.2",
  ].join("\n");

  assert.deepEqual(collectDiagnosticLines(output), [
    "[local-server] Server listening on http://127.0.0.1:3100",
    "[plugins] Installing paperclip-office@0.1.2 from the app bundle...",
    "[plugins] paperclip-office: already at 0.1.2",
  ]);
});

test("caps a looping diagnostic flood and says how many it dropped", () => {
  const output = Array.from({ length: 120 }, (_, index) => `[plugins] attempt ${index}`).join("\n");

  const collected = collectDiagnosticLines(output, { limit: 40 });
  assert.equal(collected.length, 41);
  assert.equal(collected[0], "[plugins] attempt 0");
  assert.ok(collected[40].includes("80 further diagnostic lines omitted"));
});

test("still includes the tail, and names the uploaded log when given one", () => {
  const output = ["[plugins] fine", "first", "second", "third"].join("\n");

  const detail = formatFailureDetail(output, { count: 2, logPath: "/tmp/smoke-app-output.log" });
  assert.ok(detail.includes("third"), "the tail must still be reported");
  assert.ok(detail.includes("/tmp/smoke-app-output.log"));
});
