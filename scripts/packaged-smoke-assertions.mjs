/**
 * Assertions the packaged-app smoke test makes against the `.app` it just
 * unpacked and the app it just started.
 *
 * Split out of smoke-test-packaged-macos.mjs so they can be exercised on a
 * Linux runner. The smoke script itself only runs on macOS against a real
 * `.app`, which is how the office-plugin check below stayed unwritten until a
 * human install was the first thing to look for it: the old smoke test proved
 * the server answered `/get-session`, which a server with no office plugin
 * does just as happily.
 *
 * Every assertion here exists because something present in the source was
 * absent from the bundle and nothing noticed. That was the office plugin in
 * v2026.10.6/.7 (staged, never copied into the `.app`) and in v2026.10.10/.11
 * (copied, never installed). The menu-bar item is the same class of thing, so
 * it is asserted rather than assumed — see assertTrayAssetsStaged and
 * assertTrayReady below.
 *
 * See docs/local-mode-plugin.md for the provisioning path these assert on, and
 * docs/install-runbook.md § 4d for the menu-bar surface.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

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

// ---------------------------------------------------------------------------
// The menu-bar item (HAV-43/HAV-44)
// ---------------------------------------------------------------------------

/**
 * The template image the tray is built from, as electron-builder stages it.
 *
 * `extraResources` in electron-builder.yml puts both files at the resources
 * root — not under `app-server` — and `src/main.ts`'s `trayIconPath()` resolves
 * `process.resourcesPath/trayTemplate.png` to match. macOS picks the `@2x`
 * variant up implicitly by filename, so it is never referenced in code and a
 * build that dropped it would be caught by nobody.
 */
export const TRAY_TEMPLATE_ASSETS = Object.freeze(["trayTemplate.png", "trayTemplate@2x.png"]);

/** Must stay identical to TRAY_READY_PREFIX in src/tray/tray-controller.ts. */
export const TRAY_READY_PREFIX = "[tray] menu-bar item created";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function resourcesDirForApp(appPath) {
  return path.join(appPath, "Contents", "Resources");
}

/**
 * Width and height out of a PNG's IHDR, or null if this is not a PNG.
 *
 * Deliberately not an image library: the only question is whether the `@2x`
 * asset is really twice the `@1x` one, and the IHDR is the first chunk, at a
 * fixed offset, in every valid PNG.
 */
function readPngSize(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Assert the packaged `.app` actually contains the tray's template image.
 *
 * A bundle check, not a runtime one, and it runs before the app is launched:
 * `nativeImage.createFromPath()` on a missing file returns an *empty* image
 * rather than throwing, and `new Tray(emptyImage)` renders an invisible
 * menu-bar item. So the absent-asset failure is silent at every layer above
 * this one.
 */
export function assertTrayAssetsStaged({ appPath, log = console.log }) {
  if (!appPath.endsWith(".app")) {
    throw new Error(
      `Cannot check the tray assets: --app must point at the .app bundle, got ${appPath}. `
        + "The menu-bar template image is staged into Contents/Resources, which only exists "
        + "inside the bundle.",
    );
  }

  const resourcesDir = resourcesDirForApp(appPath);
  const sizes = {};

  for (const name of TRAY_TEMPLATE_ASSETS) {
    const assetPath = path.join(resourcesDir, name);

    let stats;
    try {
      stats = statSync(assetPath);
    } catch {
      throw new Error(
        `The packaged app has no menu-bar icon at ${assetPath}. electron-builder.yml stages `
          + `build/${name} into the resources root and src/main.ts resolves it from there; a `
          + "bundle without it shows an invisible menu-bar item and reports no error. "
          + "See docs/install-runbook.md § 4d.",
      );
    }

    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`The menu-bar icon ${assetPath} is empty or not a file (${stats.size} bytes).`);
    }

    const size = readPngSize(readFileSync(assetPath));
    if (!size) {
      throw new Error(
        `The menu-bar icon ${assetPath} is not a PNG. macOS will not draw it, and `
          + "nativeImage reports no error for a file it cannot decode.",
      );
    }
    sizes[name] = size;
  }

  const [oneX, twoX] = TRAY_TEMPLATE_ASSETS.map((name) => sizes[name]);
  if (twoX.width !== oneX.width * 2 || twoX.height !== oneX.height * 2) {
    throw new Error(
      `trayTemplate@2x.png is ${twoX.width}x${twoX.height}, not twice `
        + `trayTemplate.png's ${oneX.width}x${oneX.height}. macOS selects the @2x file by `
        + "filename for Retina menu bars, so a mismatch ships a blurry or wrongly scaled icon "
        + "on every modern Mac.",
    );
  }

  log(
    `[smoke-macos] Menu-bar template icon staged (${oneX.width}x${oneX.height} + `
      + `${twoX.width}x${twoX.height}) in ${resourcesDir}.`,
  );
  return sizes;
}

/**
 * The tray's own startup line, parsed out of everything the app has printed.
 *
 * Returns `null` while the line has not been printed yet — which is an ordinary
 * state, not a failure: the tray is built on the connection-boot path, after
 * the server reports healthy, so it legitimately lands later than the
 * "Server listening on" line the smoke test resolves its startup race on.
 */
export function readTrayReadyLine(output) {
  const match = output.match(
    new RegExp(`${TRAY_READY_PREFIX.replace(/[[\]]/g, "\\$&")} icon=(\\w+) path=(.*)`),
  );
  if (!match) {
    return null;
  }
  return { icon: match[1], iconPath: match[2].trim() };
}

/**
 * Wait until the running app reports that it built its menu-bar item.
 *
 * The bundle check above proves the asset shipped; this proves the wiring ran.
 * They fail for different reasons — a staged icon with `syncTrayController()`
 * never reached is still no menu-bar item — so both are asserted.
 *
 * `icon=empty` fails immediately rather than at the deadline: the app has
 * already looked for the file and not found it, and that verdict will not
 * change by waiting.
 */
export async function assertTrayReady({
  readOutput,
  timeoutMs = 60_000,
  pollIntervalMs = 1_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
  const deadline = now() + timeoutMs;

  for (;;) {
    const line = readTrayReadyLine(readOutput());

    if (line && line.icon === "empty") {
      throw new Error(
        `The packaged app created its menu-bar item with an empty icon image `
          + `(looked for ${line.iconPath}). The Tray exists but draws nothing, so the menu bar `
          + "looks identical to an app that never started one. The asset is staged by "
          + "electron-builder.yml's extraResources.",
      );
    }

    if (line) {
      log(`[smoke-macos] Menu-bar item created with a loaded icon (${line.iconPath}).`);
      return line;
    }

    if (now() >= deadline) {
      throw new Error(
        `The packaged app never reported a menu-bar item within ${timeoutMs}ms. Expected a `
          + `"${TRAY_READY_PREFIX}" line from src/tray/tray-controller.ts, which src/main.ts's `
          + "syncTrayController() calls on every boot path. Either the tray wiring did not run "
          + "or the app never finished connecting — the output above says which.",
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
