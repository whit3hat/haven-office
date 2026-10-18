/**
 * Persists `TraySettings` next to `connections.json`, the same "read once,
 * cache, write through" shape `ConnectionStore` uses — see
 * `src/connection/profiles.ts`. A corrupt or missing file is not an error;
 * it is the first run, so it resolves to the shipped defaults.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TRAY_SETTINGS, type TraySettings } from "./menu-model";

export const TRAY_SETTINGS_FILE_NAME = "tray-settings.json";

export function getTraySettingsFilePath(userDataPath: string): string {
  return path.join(userDataPath, TRAY_SETTINGS_FILE_NAME);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitize(raw: unknown): TraySettings {
  if (!isObject(raw)) {
    return { ...DEFAULT_TRAY_SETTINGS };
  }

  return {
    notificationsEnabled:
      typeof raw.notificationsEnabled === "boolean"
        ? raw.notificationsEnabled
        : DEFAULT_TRAY_SETTINGS.notificationsEnabled,
    keepRunningInMenuBar:
      typeof raw.keepRunningInMenuBar === "boolean"
        ? raw.keepRunningInMenuBar
        : DEFAULT_TRAY_SETTINGS.keepRunningInMenuBar,
  };
}

export class TraySettingsStore {
  readonly filePath: string;
  private cache: TraySettings;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.cache = readSettingsFile(filePath);
  }

  get(): TraySettings {
    return { ...this.cache };
  }

  set(next: Partial<TraySettings>): TraySettings {
    this.cache = sanitize({ ...this.cache, ...next });
    this.write();
    return this.get();
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), "utf8");
  }
}

function readSettingsFile(filePath: string): TraySettings {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TRAY_SETTINGS };
  }
}
