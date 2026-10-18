/**
 * Haven Office's Paperclip data layer.
 *
 * Import the client, the auth seam, the poller and the types from here;
 * `./electron` is deliberately *not* re-exported so that importing this module
 * never drags `electron` into something that does not need it (a test, a
 * script, a future non-Electron Haven tool). Reach for `./electron`
 * explicitly from the main process.
 *
 * Worked example: `scripts/paperclip-attention.mjs`.
 * Design notes and the auth decision: `docs/paperclip-data-layer.md`.
 */

export { createPaperclipClient } from "./client";
export type { PaperclipClient, PaperclipClientOptions } from "./client";

export {
  boardApiKeyStrategy,
  firstAvailableStrategy,
  isSessionCookie,
  serializeCookies,
  sessionCookieStrategy,
} from "./auth";
export type {
  AuthDecision,
  AuthStrategy,
  AuthStrategyKind,
  BoardApiKeyLoader,
  CookieLike,
  CookieReader,
} from "./auth";

export { BoardKeyStore } from "./board-key-store";
export type { BoardKeyStoreOptions, SafeStorageLike } from "./board-key-store";

export { failure, isActionableFailure, reasonForStatus, success } from "./result";
export type {
  PaperclipFailure,
  PaperclipFailureReason,
  PaperclipResult,
  PaperclipSuccess,
} from "./result";

export { classifyFetchError, describeFetchError, fetchWithTimeout } from "./transport";
export type { TransportFailureReason } from "./transport";

export { watch, WATCH_INTERVALS } from "./watch";
export type { WatchHandle, WatchOptions } from "./watch";

export type * from "./types";
