/**
 * Builds an Electron-free description of the tray menu.
 *
 * `tray-controller.ts` turns this into a real `Menu`; everything here is a
 * plain object so "does the right row appear, in the right order, pointing at
 * the right thing" is a `node:test` question, not a thing you discover by
 * opening the menu bar.
 */

import { DESKTOP_VIEWS } from "../connection/start-path";
import type { AttentionItem } from "../paperclip";
import type { SurfaceState } from "./surface-state";

export interface TraySettings {
  notificationsEnabled: boolean;
  /** If true, closing the last window leaves Haven Office running in the tray. */
  keepRunningInMenuBar: boolean;
}

export const DEFAULT_TRAY_SETTINGS: TraySettings = {
  notificationsEnabled: true,
  keepRunningInMenuBar: true,
};

export type MenuAction =
  | { kind: "open-item"; href: string }
  | { kind: "open-view"; viewKey: string }
  | { kind: "toggle-notifications" }
  | { kind: "toggle-keep-running" }
  | { kind: "quit" };

export interface MenuEntry {
  id: string;
  label: string;
  kind: "label" | "action" | "separator" | "checkbox";
  enabled: boolean;
  checked?: boolean;
  accelerator?: string;
  action?: MenuAction;
}

export interface MenuModelInput {
  surfaceState: SurfaceState;
  /** Active items, newest first. Pass an empty array for "nothing to show", not a degraded state. */
  items: readonly AttentionItem[];
  connectionName: string | null;
  settings: TraySettings;
  maxVisibleItems?: number;
}

const DEFAULT_MAX_VISIBLE_ITEMS = 8;

function separator(index: number): MenuEntry {
  return { id: `separator-${index}`, label: "", kind: "separator", enabled: false };
}

function itemLabel(item: AttentionItem): string {
  const subject = item.subject.identifier ?? item.subject.title ?? "Item";
  return `${subject} — ${item.whyNow}`;
}

function itemHref(item: AttentionItem): string | null {
  return item.subject.href ?? item.relatedIssue?.href ?? null;
}

export function buildMenuModel(input: MenuModelInput): MenuEntry[] {
  const maxVisible = input.maxVisibleItems ?? DEFAULT_MAX_VISIBLE_ITEMS;
  const entries: MenuEntry[] = [];

  if (input.surfaceState.kind !== "ok") {
    entries.push({
      id: "surface-state",
      label: input.surfaceState.message,
      kind: "label",
      enabled: false,
    });
  } else if (input.items.length === 0) {
    entries.push({
      id: "empty",
      label: "Nothing needs attention",
      kind: "label",
      enabled: false,
    });
  } else {
    const visible = input.items.slice(0, maxVisible);
    for (const item of visible) {
      const href = itemHref(item);
      entries.push({
        id: `item-${item.dedupKey}`,
        label: itemLabel(item),
        kind: "action",
        enabled: href !== null,
        action: href !== null ? { kind: "open-item", href } : undefined,
      });
    }

    const hidden = input.items.length - visible.length;
    if (hidden > 0) {
      entries.push({
        id: "more",
        label: `+${hidden} more`,
        kind: "label",
        enabled: false,
      });
    }
  }

  entries.push(separator(1));

  for (const view of DESKTOP_VIEWS) {
    entries.push({
      id: `open-view-${view.key}`,
      label: `Open ${view.label}`,
      kind: "action",
      enabled: true,
      accelerator: view.accelerator,
      action: { kind: "open-view", viewKey: view.key },
    });
  }

  entries.push(separator(2));
  entries.push({
    id: "connection-name",
    label: input.connectionName ?? "Not connected",
    kind: "label",
    enabled: false,
  });

  entries.push(separator(3));
  entries.push({
    id: "toggle-notifications",
    label: "Notifications",
    kind: "checkbox",
    enabled: true,
    checked: input.settings.notificationsEnabled,
    action: { kind: "toggle-notifications" },
  });
  entries.push({
    id: "toggle-keep-running",
    label: "Keep running in the menu bar",
    kind: "checkbox",
    enabled: true,
    checked: input.settings.keepRunningInMenuBar,
    action: { kind: "toggle-keep-running" },
  });

  entries.push(separator(4));
  entries.push({
    id: "quit",
    label: "Quit Haven Office",
    kind: "action",
    enabled: true,
    action: { kind: "quit" },
  });

  return entries;
}
