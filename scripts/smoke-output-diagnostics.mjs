/**
 * Builds the failure detail the packaged-app smoke test prints when something
 * goes wrong, out of everything the app wrote to stdout and stderr.
 *
 * This exists because of a failure it could not explain. The smoke test against
 * v2026.10.10 reported only `installed plugins: none — paperclip-office is not
 * installed`, and the lines that would have said *why* — the `[plugins]` lines
 * the main process writes while provisioning — had already been pushed out of
 * the 80-line tail by three minutes of the server's own per-request logging.
 * The diagnosis and the evidence were in the same buffer; only the evidence was
 * thrown away.
 *
 * So the tail is no longer the whole report. Provisioning lines are pulled out
 * of the *entire* buffer by marker, independent of how much unrelated output
 * came after them, and the full buffer is written to a file the workflow
 * uploads as an artifact. Split into its own module so a Linux runner can test
 * it; the smoke script itself only runs on macOS against a real `.app`.
 */

/** Markers whose lines are diagnosis rather than noise, wherever they appear. */
export const DIAGNOSTIC_MARKERS = Object.freeze(["[plugins]", "[local-server]"]);

const DEFAULT_TAIL_LINES = 80;
/**
 * A cap, not a budget. Provisioning writes one line per plugin plus at most a
 * couple of lifecycle lines, so a buffer offering hundreds of matches means
 * something is looping, and the first few are the ones that explain it.
 */
const MAX_DIAGNOSTIC_LINES = 40;

function splitLines(output) {
  return output.split(/\r?\n/);
}

/**
 * Every line carrying a diagnostic marker, in the order the app wrote them.
 *
 * Deliberately scans the whole buffer: these lines are written at boot, and the
 * failures worth diagnosing are detected minutes later.
 */
export function collectDiagnosticLines(output, { markers = DIAGNOSTIC_MARKERS, limit = MAX_DIAGNOSTIC_LINES } = {}) {
  const matched = [];
  for (const line of splitLines(output)) {
    if (markers.some((marker) => line.includes(marker))) {
      matched.push(line.trimEnd());
    }
  }

  if (matched.length <= limit) {
    return matched;
  }

  const kept = matched.slice(0, limit);
  kept.push(`[smoke-macos] ... ${matched.length - limit} further diagnostic lines omitted; see the uploaded output log.`);
  return kept;
}

export function tailLines(output, count = DEFAULT_TAIL_LINES) {
  return splitLines(output).slice(-count);
}

/**
 * The detail block appended to a smoke failure: the marker lines first, because
 * they name the cause, then the tail, which shows what the app was doing when
 * the check gave up.
 *
 * When no marker line is present that is itself a finding, and it is stated
 * rather than left as an empty section — an app whose provisioning never ran
 * and an app whose provisioning failed are different bugs, and silence used to
 * look the same as both.
 */
export function formatFailureDetail(output, { count = DEFAULT_TAIL_LINES, markers = DIAGNOSTIC_MARKERS, logPath = null } = {}) {
  const diagnostics = collectDiagnosticLines(output, { markers });
  const sections = [];

  if (diagnostics.length > 0) {
    sections.push(`--- provisioning and local-server lines (${diagnostics.length}, from the whole run) ---`);
    sections.push(diagnostics.join("\n"));
  } else {
    sections.push(
      `--- no ${markers.join(" / ")} lines in the app's output at all ---\n`
        + "Plugin provisioning logs unconditionally once it runs, so its total absence means the\n"
        + "provisioning step was never reached rather than that it failed. Check whether boot\n"
        + "restarted before provisioning (src/main.ts bootId guard) or the output was not captured.",
    );
  }

  sections.push(`--- last ${count} lines of app output ---`);
  sections.push(tailLines(output, count).join("\n"));

  if (logPath) {
    sections.push(`--- full app output written to ${logPath} ---`);
  }

  return sections.join("\n");
}
