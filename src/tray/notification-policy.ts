/**
 * Decides which newly-appearing attention items earn a native notification.
 *
 * This is the part of the tray that gets muted forever if it is noisy, so the
 * three limits below are requirements, not polish:
 *
 * - **Dedupe.** A `dedupKey` that has ever notified does not notify again, for
 *   the life of this gate. Pass `candidates` that are already filtered to
 *   "active" (not dismissed/snoozed) — see `attention-items.ts` — so a
 *   dismissed-then-reappeared item is this module's problem exactly once.
 * - **Debounce bursts.** A poll tick that surfaces more than `burstThreshold`
 *   new items at once (the common case is "the app was offline for an hour
 *   and ten things happened") collapses into a single combined notification
 *   instead of ten individual ones.
 * - **Cap per interval.** Even one item at a time, no more than
 *   `maxPerInterval` notifications fire within `intervalMs`. An item that
 *   loses its budget slot is **not** marked notified — it stays a candidate
 *   and gets a slot on a later tick once the window ages out, rather than
 *   being silently dropped forever.
 */

import type { AttentionItem } from "../paperclip";

export interface NotificationPolicyConfig {
  /** More new items than this in one tick collapse into one combined notification. */
  burstThreshold: number;
  /** Rolling window the cap is measured over. */
  intervalMs: number;
  /** Max notifications (an individual item or a collapsed burst each count as one) per `intervalMs`. */
  maxPerInterval: number;
}

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicyConfig = {
  burstThreshold: 3,
  intervalMs: 10 * 60_000,
  maxPerInterval: 8,
};

export type NotificationAnnouncement =
  | { kind: "item"; item: AttentionItem }
  | { kind: "burst"; items: AttentionItem[] };

export interface NotificationPlan {
  notifications: NotificationAnnouncement[];
  /** New, not-yet-notified items this tick could not show because the cap is full right now. */
  suppressedCount: number;
}

export class NotificationGate {
  private readonly notifiedKeys: Set<string>;
  private readonly fireLog: number[] = [];

  constructor(
    private readonly config: NotificationPolicyConfig = DEFAULT_NOTIFICATION_POLICY,
    private readonly now: () => number = Date.now,
    seedNotifiedKeys: Iterable<string> = [],
  ) {
    this.notifiedKeys = new Set(seedNotifiedKeys);
  }

  /** Keys that must never notify again, e.g. restored from disk across an app restart. */
  hasNotified(dedupKey: string): boolean {
    return this.notifiedKeys.has(dedupKey);
  }

  plan(candidates: readonly AttentionItem[]): NotificationPlan {
    const unseen = candidates.filter((item) => !this.notifiedKeys.has(item.dedupKey));
    if (unseen.length === 0) {
      return { notifications: [], suppressedCount: 0 };
    }

    this.pruneFireLog();
    const budget = this.config.maxPerInterval - this.fireLog.length;
    if (budget <= 0) {
      return { notifications: [], suppressedCount: unseen.length };
    }

    if (unseen.length > this.config.burstThreshold) {
      this.markNotified(unseen);
      this.recordFire();
      return { notifications: [{ kind: "burst", items: unseen }], suppressedCount: 0 };
    }

    const shown = unseen.slice(0, budget);
    const held = unseen.length - shown.length;
    this.markNotified(shown);
    for (const _item of shown) {
      this.recordFire();
    }

    return {
      notifications: shown.map((item) => ({ kind: "item", item }) as const),
      suppressedCount: held,
    };
  }

  private markNotified(items: readonly AttentionItem[]): void {
    for (const item of items) {
      this.notifiedKeys.add(item.dedupKey);
    }
  }

  private recordFire(): void {
    this.fireLog.push(this.now());
  }

  private pruneFireLog(): void {
    const cutoff = this.now() - this.config.intervalMs;
    while (this.fireLog.length > 0 && this.fireLog[0] < cutoff) {
      this.fireLog.shift();
    }
  }
}
