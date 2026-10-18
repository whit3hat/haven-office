/**
 * Pure attention-item logic: what is "active" right now, what order the menu
 * shows them in, and which ones are *new* since the tray last looked.
 *
 * Nothing here talks to the server or to Electron — see `tray-controller.ts`
 * for the poll loop that calls these on every tick.
 */

import type { AttentionItem, InboxDismissal } from "../paperclip";

/**
 * An item the server still lists but the user has already dismissed or
 * snoozed is not "active" — it must not appear in the menu and must never
 * trigger a notification, even on the very next poll.
 *
 * Two sources of dismissal, because they disagree about timing: the feed's
 * own `item.dismissal` is only as fresh as the last `/attention` poll, while
 * `/inbox-dismissals` is the thing `POST`ed the moment the user acts. Checking
 * both means a dismissal made one tick ago is honoured immediately rather
 * than waiting for the next feed refresh to confirm it.
 */
export function isDismissed(item: AttentionItem, dismissals: ReadonlySet<string>): boolean {
  if (item.dismissal?.isActive) {
    return true;
  }
  return dismissals.has(item.dismissalKey);
}

export function activeDismissalKeys(dismissals: readonly InboxDismissal[]): Set<string> {
  const now = Date.now();
  const active = new Set<string>();
  for (const dismissal of dismissals) {
    if (dismissal.kind === "snooze" && dismissal.snoozedUntil) {
      if (new Date(dismissal.snoozedUntil).getTime() <= now) {
        continue;
      }
    }
    active.add(dismissal.itemKey);
  }
  return active;
}

export function activeItems(
  items: readonly AttentionItem[],
  dismissals: ReadonlySet<string>,
): AttentionItem[] {
  return items.filter((item) => !isDismissed(item, dismissals));
}

/** Newest activity first, which is also the order the spec asks the menu to use. */
export function sortNewestFirst(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt));
}

/**
 * Items that were not in the previously-seen key set, in newest-first order.
 *
 * Keyed on `dedupKey`, never `id` — the server can reissue an item under a new
 * row id for the same underlying decision, and keying on `id` would re-fire a
 * notification for something the user has already seen once.
 */
export function newlyAppearingItems(
  current: readonly AttentionItem[],
  previouslySeenKeys: ReadonlySet<string>,
): AttentionItem[] {
  return sortNewestFirst(current.filter((item) => !previouslySeenKeys.has(item.dedupKey)));
}

export function dedupKeySet(items: readonly AttentionItem[]): Set<string> {
  return new Set(items.map((item) => item.dedupKey));
}
