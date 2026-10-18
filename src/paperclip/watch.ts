/**
 * Adaptive polling.
 *
 * Paperclip has no push channel for the attention feed, so a native surface
 * has to poll. Polling a home server every few seconds forever is rude to a
 * shared host and pointless most of the time — the interesting question is
 * never "how often can we poll" but "what is the longest we can wait and still
 * be useful".
 *
 * Every interval is in `WATCH_INTERVALS` with the reason it is what it is.
 * Changing one is a product decision, so it should be a one-line diff in a
 * table rather than a hunt through control flow.
 */

import { isActionableFailure, type PaperclipResult } from "./result";

export const WATCH_INTERVALS = {
  /**
   * Focused and something changed on the last tick. Fast enough that a
   * decision the owner is waiting on appears while they are still looking at
   * the screen.
   */
  activeMs: 15_000,

  /**
   * Focused, but the payload was byte-identical to last time. Most of a day
   * looks like this. 60s keeps the surface honest without asking the server
   * for the same bytes four times a minute.
   */
  idleMs: 60_000,

  /**
   * Nothing is focused. The tray still has to be right when the owner glances
   * at it, but nobody is watching it update, so five minutes is plenty — and
   * it is the difference between ~5,700 and ~290 requests a day.
   */
  unfocusedMs: 300_000,

  /**
   * First failure. Short, because the overwhelming majority of failures here
   * are a laptop that just woke up or a lab server mid-restart.
   */
  errorBaseMs: 30_000,

  /**
   * Doubling cap. A server that has been down for twenty minutes is being
   * worked on by a human; hammering it does not help, and the OS-blocked and
   * signed-out cases will not fix themselves from a retry at all.
   */
  errorMaxMs: 900_000,

  /**
   * Rate limiting is the server explicitly saying "slower". Start past the
   * normal error floor rather than discovering the limit again in 30s.
   */
  rateLimitedMs: 120_000,
} as const;

export interface WatchHandle {
  /** Stop polling. Idempotent; a tick already in flight is discarded. */
  stop(): void;
  /**
   * Poll now, resetting any backoff. For "the window just got focus" and for a
   * menu the user just opened — a stale tray is worst exactly when looked at.
   */
  refreshNow(): void;
  readonly stopped: boolean;
}

export interface WatchOptions<T> {
  /** One poll. Must resolve — the client's methods already do. */
  poll: () => Promise<PaperclipResult<T>>;
  /** Called only when the payload actually changed, and on every failure. */
  onChange: (result: PaperclipResult<T>) => void;
  /**
   * Whether a human can currently see the surface. Injected rather than read
   * from `app`/`BrowserWindow` so this file stays Electron-free and testable.
   */
  isFocused?: () => boolean;
  /**
   * Is anything still listening? When this goes false the watch stops by
   * itself — a tray that has been destroyed should not keep a timer alive.
   */
  hasListeners?: () => boolean;
  /** Seam for tests; defaults to the real timers. */
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  /** Compare payloads. Defaults to JSON equality, which is right for these. */
  isEqual?: (a: T, b: T) => boolean;
  intervals?: typeof WATCH_INTERVALS;
}

export function watch<T>(options: WatchOptions<T>): WatchHandle {
  const intervals = options.intervals ?? WATCH_INTERVALS;
  const setTimeoutImpl =
    options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms) as unknown);
  const clearTimeoutImpl =
    options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const isFocused = options.isFocused ?? (() => true);
  const hasListeners = options.hasListeners ?? (() => true);
  const isEqual = options.isEqual ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));

  let stopped = false;
  let timer: unknown = null;
  let consecutiveErrors = 0;
  let last: { value: T } | null = null;
  let inFlight = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number) => {
    clearTimer();
    if (stopped) {
      return;
    }
    timer = setTimeoutImpl(() => {
      timer = null;
      void tick();
    }, delayMs);
  };

  const nextDelay = (result: PaperclipResult<T>, changed: boolean): number => {
    if (!result.ok) {
      if (result.reason === "rate_limited") {
        return intervals.rateLimitedMs;
      }
      // Exponential, capped. `consecutiveErrors` is already incremented.
      const doubled = intervals.errorBaseMs * 2 ** Math.min(consecutiveErrors - 1, 10);
      return Math.min(doubled, intervals.errorMaxMs);
    }

    if (!isFocused()) {
      return intervals.unfocusedMs;
    }

    return changed ? intervals.activeMs : intervals.idleMs;
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) {
      return;
    }

    if (!hasListeners()) {
      stop();
      return;
    }

    inFlight = true;
    let result: PaperclipResult<T>;
    try {
      result = await options.poll();
    } finally {
      inFlight = false;
    }

    // A watch stopped while the request was in flight must not deliver. The
    // surface is already gone, and calling into it is how a destroyed Tray
    // turns into a crash.
    if (stopped) {
      return;
    }

    let changed = false;
    if (result.ok) {
      consecutiveErrors = 0;
      changed = last === null || !isEqual(last.value, result.data);
      last = { value: result.data };
      if (changed) {
        options.onChange(result);
      }
    } else {
      consecutiveErrors += 1;
      // Failures always surface. The surface decides how loudly: a one-off 500
      // mid-poll is noise, but `isActionableFailure` marks the ones that are
      // the entire message ("you are signed out", "macOS is blocking this").
      options.onChange(result);
    }

    schedule(nextDelay(result, changed));
  };

  function stop(): void {
    stopped = true;
    clearTimer();
  }

  // Poll immediately: a surface that shows nothing until the first interval
  // elapses looks broken.
  void tick();

  return {
    stop,
    refreshNow() {
      if (stopped) {
        return;
      }
      consecutiveErrors = 0;
      clearTimer();
      void tick();
    },
    get stopped() {
      return stopped;
    },
  };
}

/** Re-exported so a surface can ask "is this failure worth shouting about?". */
export { isActionableFailure };
