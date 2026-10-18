/**
 * Assertions the packaged-app smoke test makes against the bundled server it
 * just started.
 *
 * Split out of smoke-test-packaged-macos.mjs so they can be exercised on a
 * Linux runner. The smoke script itself only runs on macOS against a real
 * `.app`, which is how the office-plugin check below stayed unwritten until a
 * human install was the first thing to look for it: the old smoke test proved
 * the server answered `/get-session`, which a server with no office plugin
 * does just as happily.
 *
 * See docs/local-mode-plugin.md for the provisioning path these assert on.
 */

/**
 * Statuses src/connection/plugin-provisioning.ts deliberately leaves alone,
 * mirrored here. Each is a decision by the operator or the server rather than
 * a step still in flight, so observing one is a result, not something to wait
 * out. A fresh isolated profile — which is all the smoke test ever runs
 * against — should never reach any of them.
 */
export const DEGRADED_PLUGIN_STATUSES = Object.freeze([
  "uninstalled",
  "disabled",
  "upgrade_pending",
  "error",
]);

export function findPluginRecord(records, packageName) {
  return (
    records.find((record) => record.packageName === packageName)
    ?? records.find((record) => record.pluginKey === packageName)
    ?? null
  );
}

function normalizeRecords(body) {
  if (!Array.isArray(body)) {
    return [];
  }

  return body.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const pluginKey = typeof entry.pluginKey === "string" ? entry.pluginKey : null;
    const version = typeof entry.version === "string" ? entry.version : null;
    const status = typeof entry.status === "string" ? entry.status : null;
    if (!pluginKey || !version || !status) {
      return [];
    }
    return [{
      pluginKey,
      version,
      status,
      packageName: typeof entry.packageName === "string" ? entry.packageName : pluginKey,
    }];
  });
}

function summarize(records) {
  if (records.length === 0) {
    return "none";
  }
  return records.map((r) => `${r.packageName}@${r.version} (${r.status})`).join(", ");
}

/**
 * Wait until every plugin staged into the bundle is installed in the running
 * server at its pinned version.
 *
 * Polls rather than reads once: provisioning runs in the main process after
 * the server reports healthy, so the "Server listening on" line the smoke test
 * waits for can be printed before the install has been posted. A degraded
 * status fails immediately — it will not resolve by waiting.
 */
export async function assertBundledPluginsInstalled({
  origin,
  plugins,
  fetchImpl = fetch,
  timeoutMs = 120_000,
  pollIntervalMs = 2_000,
  requestTimeoutMs = 10_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
  if (plugins.length === 0) {
    return [];
  }

  const url = new URL("/api/plugins", origin);
  const deadline = now() + timeoutMs;
  let lastSeen = "nothing — /api/plugins was never read successfully";
  let lastError = null;

  for (;;) {
    let records = null;
    try {
      records = normalizeRecords(await requestJson(fetchImpl, url, requestTimeoutMs));
      lastSeen = summarize(records);
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (records) {
      const resolved = [];
      let pending = null;

      for (const { name, version } of plugins) {
        const record = findPluginRecord(records, name);
        if (!record) {
          pending = `${name} is not installed`;
          break;
        }
        if (DEGRADED_PLUGIN_STATUSES.includes(record.status)) {
          throw new Error(
            `Bundled plugin ${name} is present but its status is "${record.status}". `
              + "A fresh isolated profile should never reach that status; the packaged app's "
              + "plugin provisioning failed. Look for '[plugins]' lines in the output above.",
          );
        }
        if (record.version !== version) {
          pending = `${name} is installed at ${record.version}, not the staged ${version}`;
          break;
        }
        resolved.push(record);
      }

      if (!pending) {
        for (const record of resolved) {
          log(
            `[smoke-macos] Bundled plugin ${record.packageName}@${record.version} installed (status ${record.status}).`,
          );
        }
        return resolved;
      }

      lastSeen = `${lastSeen} — ${pending}`;
    }

    if (now() >= deadline) {
      const reason = lastError ? `last error: ${lastError}` : `installed plugins: ${lastSeen}`;
      throw new Error(
        `Bundled plugins were not installed within ${timeoutMs}ms (${reason}). `
          + "The packaged app opens anyway when provisioning fails, so this is the closest "
          + "automated proxy for the office view not 404ing — it proves the plugin installed, "
          + "not that the route answers; nothing fetches it. See docs/local-mode-plugin.md.",
      );
    }

    await sleep(pollIntervalMs);
  }
}

async function requestJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return body.length === 0 ? null : JSON.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}
