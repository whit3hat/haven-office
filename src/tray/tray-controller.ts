/**
 * The menu-bar surface: the Electron wiring around the pure modules in this
 * directory. Everything that can be tested without a Mac lives in
 * `attention-items.ts`, `notification-policy.ts`, `surface-state.ts` and
 * `menu-model.ts`; this file's only job is turning their output into a real
 * `Tray`/`Menu`/`Notification` and feeding them the poll loop.
 *
 * Wired into `src/main.ts` by `syncTrayController()`, which rebuilds the
 * controller after every assignment to `currentConnection` and tears it down
 * in `before-quit`.
 */

import { Menu, Notification, Tray, app, nativeImage } from "electron";
import type { MenuItemConstructorOptions, NativeImage } from "electron";

import { resolveDesktopViewUrl, resolveWithinOrigin } from "../connection/start-path";
import {
  activeDismissalKeys,
  activeItems,
  dedupKeySet,
  newlyAppearingItems,
  sortNewestFirst,
} from "./attention-items";
import { buildMenuModel, type MenuAction, type MenuEntry } from "./menu-model";
import { DEFAULT_NOTIFICATION_POLICY, NotificationGate, type NotificationAnnouncement } from "./notification-policy";
import { classifySurfaceState, describeBadge, type SurfaceState } from "./surface-state";
import { getTraySettingsFilePath, TraySettingsStore } from "./settings-store";
import { watch, type WatchHandle } from "../paperclip";
import type { AttentionItem, InboxDismissal, PaperclipClient, PaperclipResult } from "../paperclip";
import { success } from "../paperclip";

/**
 * The line the packaged smoke test waits for.
 *
 * Deliberately duplicated in `scripts/packaged-smoke-assertions.mjs` rather
 * than imported: the smoke workflow checks the repo out and runs the script
 * straight from `scripts/`, with no `pnpm install` and no build, so there is no
 * `dist/` for it to import from. `test/packaged-smoke-assertions.test.mjs`
 * asserts the two strings are still the same one.
 */
const TRAY_READY_PREFIX = "[tray] menu-bar item created";

export interface TrayControllerDeps {
  client: PaperclipClient;
  userDataPath: string;
  allowedOrigin: string;
  companyPrefix: string;
  connectionName: string | null;
  /** Focus or open the main window at this absolute URL. */
  onOpenUrl: (url: string) => void;
  /** A template image (macOS: drawn in both light and dark menu bars). */
  iconPath: string;
  isFocused?: () => boolean;
}

export interface TrayController {
  stop(): void;
  refreshNow(): void;
  /** Exposed for `main.ts`'s window-close handler; not enforced here. */
  shouldKeepRunningInMenuBar(): boolean;
}

interface PollData {
  feed: { deskBadgeCount: number; items: AttentionItem[] };
  dismissals: InboxDismissal[];
}

export function createTrayController(deps: TrayControllerDeps): TrayController {
  const settingsStore = new TraySettingsStore(getTraySettingsFilePath(deps.userDataPath));
  const notificationGate = new NotificationGate(DEFAULT_NOTIFICATION_POLICY);

  const icon = trayIcon(deps.iconPath);
  const tray = new Tray(icon);
  tray.setToolTip("Haven Office");
  // The packaged smoke test's only runtime handle on "is there a menu-bar
  // item". `new Tray(image)` succeeds even when `image` is empty, and an empty
  // template image draws nothing at all, so a bundle missing the asset looks
  // exactly like a working app from the outside — the same shape of failure as
  // the three releases that shipped with no office in them. Reporting whether
  // the image loaded, not just that the Tray was constructed, is what makes it
  // assertable. See scripts/packaged-smoke-assertions.mjs.
  console.log(
    `${TRAY_READY_PREFIX} icon=${icon.isEmpty() ? "empty" : "loaded"} path=${deps.iconPath}`,
  );

  let surfaceState: SurfaceState = { kind: "unreachable", message: "Connecting…" };
  let currentItems: AttentionItem[] = [];
  let lastKnownCount: number | null = null;
  let previouslySeenKeys: Set<string> | null = null;

  async function poll(): Promise<PaperclipResult<PollData>> {
    const feedResult = await deps.client.getAttention({ all: true });
    if (!feedResult.ok) {
      return feedResult;
    }

    const dismissalsResult = await deps.client.listInboxDismissals();
    const dismissals = dismissalsResult.ok ? dismissalsResult.data : [];
    return success({ feed: feedResult.data, dismissals }, feedResult.status);
  }

  function handleResult(result: PaperclipResult<PollData>): void {
    surfaceState = classifySurfaceState(result);

    if (!result.ok) {
      render();
      return;
    }

    const { feed, dismissals } = result.data;
    lastKnownCount = feed.deskBadgeCount;

    const dismissedKeys = activeDismissalKeys(dismissals);
    currentItems = sortNewestFirst(activeItems(feed.items, dismissedKeys));

    if (previouslySeenKeys === null) {
      // First successful poll: establish the baseline silently. Every item
      // already on the server when the app opens is not "new".
      previouslySeenKeys = dedupKeySet(currentItems);
    } else {
      const freshlyNew = newlyAppearingItems(currentItems, previouslySeenKeys);
      previouslySeenKeys = dedupKeySet(currentItems);

      if (settingsStore.get().notificationsEnabled && freshlyNew.length > 0) {
        const plan = notificationGate.plan(freshlyNew);
        for (const announcement of plan.notifications) {
          fireNotification(announcement);
        }
      }
    }

    render();
  }

  function fireNotification(announcement: NotificationAnnouncement): void {
    if (!Notification.isSupported()) {
      return;
    }

    if (announcement.kind === "item") {
      const item = announcement.item;
      const notification = new Notification({
        title: item.subject.identifier ?? item.subject.title ?? "Haven Office",
        body: item.whyNow,
      });
      notification.on("click", () => openItem(item));
      notification.show();
      return;
    }

    const titles = announcement.items
      .slice(0, 3)
      .map((item) => item.subject.identifier ?? item.subject.title)
      .filter((value): value is string => Boolean(value));
    const notification = new Notification({
      title: `${announcement.items.length} new attention items`,
      body: titles.join(", "),
    });
    notification.on("click", () => openView("board"));
    notification.show();
  }

  function openItem(item: AttentionItem): void {
    const href = item.subject.href ?? item.relatedIssue?.href;
    if (!href) {
      return;
    }
    const resolved = resolveWithinOrigin(href, deps.allowedOrigin);
    if (resolved) {
      deps.onOpenUrl(resolved);
    }
  }

  function openView(viewKey: string): void {
    const resolved = resolveDesktopViewUrl({
      allowedOrigin: deps.allowedOrigin,
      prefix: deps.companyPrefix,
      viewKey,
    });
    if (resolved) {
      deps.onOpenUrl(resolved);
    }
  }

  function handleAction(action: MenuAction | undefined): void {
    if (!action) {
      return;
    }
    switch (action.kind) {
      case "open-item": {
        const resolved = resolveWithinOrigin(action.href, deps.allowedOrigin);
        if (resolved) {
          deps.onOpenUrl(resolved);
        }
        return;
      }
      case "open-view":
        openView(action.viewKey);
        return;
      case "toggle-notifications":
        settingsStore.set({ notificationsEnabled: !settingsStore.get().notificationsEnabled });
        render();
        return;
      case "toggle-keep-running":
        settingsStore.set({ keepRunningInMenuBar: !settingsStore.get().keepRunningInMenuBar });
        render();
        return;
      case "quit":
        app.quit();
        return;
    }
  }

  function toMenuTemplate(entries: readonly MenuEntry[]): MenuItemConstructorOptions[] {
    return entries.map((entry) => {
      if (entry.kind === "separator") {
        return { type: "separator" };
      }
      if (entry.kind === "checkbox") {
        return {
          label: entry.label,
          type: "checkbox",
          checked: entry.checked ?? false,
          enabled: entry.enabled,
          click: () => handleAction(entry.action),
        };
      }
      if (entry.kind === "action") {
        return {
          label: entry.label,
          enabled: entry.enabled,
          accelerator: entry.accelerator,
          click: () => handleAction(entry.action),
        };
      }
      return { label: entry.label, enabled: false };
    });
  }

  function render(): void {
    const entries = buildMenuModel({
      surfaceState,
      items: currentItems,
      connectionName: deps.connectionName,
      settings: settingsStore.get(),
    });
    tray.setContextMenu(Menu.buildFromTemplate(toMenuTemplate(entries)));
    tray.setTitle(describeBadge(surfaceState, lastKnownCount));
    tray.setToolTip(surfaceState.kind === "ok" ? "Haven Office" : `Haven Office — ${surfaceState.message}`);
  }

  let destroyed = false;
  const handle: WatchHandle = watch<PollData>({
    poll,
    onChange: handleResult,
    isFocused: deps.isFocused,
    hasListeners: () => !destroyed,
  });

  return {
    stop() {
      destroyed = true;
      handle.stop();
      tray.destroy();
    },
    refreshNow() {
      handle.refreshNow();
    },
    shouldKeepRunningInMenuBar() {
      return settingsStore.get().keepRunningInMenuBar;
    },
  };
}

function trayIcon(iconPath: string): NativeImage {
  const image = nativeImage.createFromPath(iconPath);
  image.setTemplateImage(true);
  return image;
}
