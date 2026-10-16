/**
 * Preinstalls the plugins staged into the app bundle into the local server, so
 * a fresh install lands on the office with no terminal step.
 *
 * The local server runs in `local_trusted` deployment mode, where every
 * request on the loopback port is an implicit instance-admin board actor. That
 * makes the server's own public install API usable before anyone has signed
 * in, which is why this provisions over HTTP instead of reaching into the
 * server's database or its boot-time bundled-plugin path. See
 * docs/local-mode-plugin.md for why the alternatives were rejected.
 *
 * Two properties this module deliberately keeps:
 *
 * 1. **Plugin code never runs in the main process.** Identity comes from the
 *    staged `package.json` (`name`, `version`), never from importing the
 *    plugin's manifest module.
 * 2. **Failure is never fatal.** A plugin that cannot be provisioned is logged
 *    and skipped; the app still opens. The office route 404s, which is a
 *    strictly better outcome than refusing to launch.
 */

import fs from "node:fs";
import path from "node:path";

export const PREINSTALL_ENV_VAR = "HAVEN_OFFICE_PREINSTALL_PLUGINS";

/** A plugin package found in the app bundle's `plugins` directory. */
export interface StagedPlugin {
  /** Package name from package.json; matched against the server's `packageName`. */
  packageName: string;
  version: string;
  /** Absolute path handed to the server as a local install source. */
  localPath: string;
}

/** The subset of the server's plugin record this module reasons about. */
export interface InstalledPluginRecord {
  id: string;
  pluginKey: string;
  packageName: string;
  version: string;
  status: string;
}

export type ProvisioningAction =
  | { kind: "install"; localPath: string }
  | { kind: "upgrade"; pluginId: string; fromVersion: string; toVersion: string }
  | { kind: "skip"; reason: string };

export interface ProvisioningOutcome {
  packageName: string;
  action: ProvisioningAction["kind"];
  detail: string;
  ok: boolean;
}

/**
 * Preinstalling is on by default and switched off by setting the environment
 * variable to `0` or `false`. The rollback for a bad plugin build is therefore
 * a single variable, with no reinstall and no code change.
 */
export function isPreinstallEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[PREINSTALL_ENV_VAR]?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

/**
 * The decision for one staged plugin. Statuses the owner or the server owns are
 * left alone: an uninstall or a disable is a deliberate choice that a relaunch
 * must not silently undo, and `upgrade_pending` is waiting on a capability
 * decision only a person can make.
 */
export function resolveProvisioningAction(
  staged: StagedPlugin,
  installed: InstalledPluginRecord | null,
): ProvisioningAction {
  if (!installed) {
    return { kind: "install", localPath: staged.localPath };
  }

  switch (installed.status) {
    case "uninstalled":
      return { kind: "skip", reason: "removed by the operator" };
    case "disabled":
      return { kind: "skip", reason: "disabled by the operator" };
    case "upgrade_pending":
      return { kind: "skip", reason: "awaiting an operator capability decision" };
    case "error":
      return { kind: "skip", reason: "in error status; enable it from Settings to retry" };
    default:
      break;
  }

  if (installed.version === staged.version) {
    return { kind: "skip", reason: `already at ${staged.version}` };
  }

  return {
    kind: "upgrade",
    pluginId: installed.id,
    fromVersion: installed.version,
    toVersion: staged.version,
  };
}

export function findInstalledPlugin(
  staged: StagedPlugin,
  installed: readonly InstalledPluginRecord[],
): InstalledPluginRecord | null {
  return (
    installed.find((record) => record.packageName === staged.packageName)
    ?? installed.find((record) => record.pluginKey === staged.packageName)
    ?? null
  );
}

/**
 * Reads the staged plugin packages out of the bundle. A directory without a
 * readable package.json, a name, a version, or declared `paperclipPlugin`
 * entrypoints is not a plugin and is ignored rather than reported — the build
 * already fails on a malformed staged package (see scripts/prepare-server.mjs).
 */
export function readStagedPlugins(pluginsRoot: string): StagedPlugin[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const staged: StagedPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const localPath = path.join(pluginsRoot, entry.name);
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(localPath, "package.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }

    const packageName = typeof pkg.name === "string" ? pkg.name : null;
    const version = typeof pkg.version === "string" ? pkg.version : null;
    const entrypoints = pkg.paperclipPlugin;
    if (!packageName || !version || typeof entrypoints !== "object" || entrypoints === null) {
      continue;
    }

    staged.push({ packageName, version, localPath });
  }

  return staged.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export interface ProvisionBundledPluginsOptions {
  /** Loopback origin of the running local server. */
  origin: string;
  /** Bundle directory holding the staged plugin packages. */
  pluginsRoot: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export async function provisionBundledPlugins(
  options: ProvisionBundledPluginsOptions,
): Promise<ProvisioningOutcome[]> {
  const log = options.log ?? ((message: string) => console.log(message));

  if (!isPreinstallEnabled(options.env ?? process.env)) {
    log(`[plugins] Preinstall disabled by ${PREINSTALL_ENV_VAR}; skipping.`);
    return [];
  }

  const staged = readStagedPlugins(options.pluginsRoot);
  if (staged.length === 0) {
    return [];
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const request = (urlPath: string, init?: RequestInit) =>
    requestJson(fetchImpl, new URL(urlPath, options.origin), timeoutMs, init);

  let installed: InstalledPluginRecord[];
  try {
    installed = asInstalledRecords(await request("/api/plugins"));
  } catch (error) {
    log(`[plugins] Could not read the installed plugin list: ${describe(error)}`);
    return staged.map((plugin) => ({
      packageName: plugin.packageName,
      action: "skip" as const,
      detail: `could not read the installed plugin list: ${describe(error)}`,
      ok: false,
    }));
  }

  const outcomes: ProvisioningOutcome[] = [];
  for (const plugin of staged) {
    const action = resolveProvisioningAction(plugin, findInstalledPlugin(plugin, installed));

    if (action.kind === "skip") {
      log(`[plugins] ${plugin.packageName}: ${action.reason}`);
      outcomes.push({ packageName: plugin.packageName, action: "skip", detail: action.reason, ok: true });
      continue;
    }

    try {
      if (action.kind === "install") {
        log(`[plugins] Installing ${plugin.packageName}@${plugin.version} from the app bundle...`);
        await request("/api/plugins/install", {
          method: "POST",
          body: JSON.stringify({ packageName: action.localPath, isLocalPath: true }),
        });
        outcomes.push({
          packageName: plugin.packageName,
          action: "install",
          detail: `installed ${plugin.version}`,
          ok: true,
        });
      } else {
        log(
          `[plugins] Upgrading ${plugin.packageName} ${action.fromVersion} -> ${action.toVersion} from the app bundle...`,
        );
        await request(`/api/plugins/${encodeURIComponent(action.pluginId)}/upgrade`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        outcomes.push({
          packageName: plugin.packageName,
          action: "upgrade",
          detail: `upgraded to ${action.toVersion}`,
          ok: true,
        });
      }
    } catch (error) {
      // Degraded, never fatal: the app opens and the office route 404s.
      log(`[plugins] ${plugin.packageName} could not be provisioned: ${describe(error)}`);
      outcomes.push({
        packageName: plugin.packageName,
        action: action.kind,
        detail: describe(error),
        ok: false,
      });
    }
  }

  return outcomes;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
      redirect: "manual",
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }

    return body.length === 0 ? null : JSON.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}

function asInstalledRecords(body: unknown): InstalledPluginRecord[] {
  if (!Array.isArray(body)) {
    return [];
  }

  return body.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string"
      || typeof record.pluginKey !== "string"
      || typeof record.version !== "string"
      || typeof record.status !== "string"
    ) {
      return [];
    }

    return [{
      id: record.id,
      pluginKey: record.pluginKey,
      packageName: typeof record.packageName === "string" ? record.packageName : record.pluginKey,
      version: record.version,
      status: record.status,
    }];
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
