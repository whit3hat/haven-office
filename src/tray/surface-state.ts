/**
 * The tray's degraded states.
 *
 * `PaperclipFailureReason` has nine values because the client has to tell nine
 * different transport/auth outcomes apart; the tray only has to tell the user
 * apart four *repairs*: sign in, grant macOS permission, wait for the server,
 * or something else is wrong. Collapsing happens here, once, so the menu and
 * any future surface agree on the grouping.
 */

import type { PaperclipFailureReason, PaperclipResult } from "../paperclip";

export type SurfaceStateKind = "ok" | "signed_out" | "os_blocked" | "unreachable" | "error";

export interface SurfaceState {
  kind: SurfaceStateKind;
  /** One sentence fit to show in the menu. */
  message: string;
}

const SIGNED_OUT_REASONS: readonly PaperclipFailureReason[] = ["signed_out", "no_credential", "forbidden"];

export function classifySurfaceState<T>(result: PaperclipResult<T>): SurfaceState {
  if (result.ok) {
    return { kind: "ok", message: "Connected" };
  }

  if (SIGNED_OUT_REASONS.includes(result.reason)) {
    return {
      kind: "signed_out",
      message: "Signed out — open Haven Office to sign in.",
    };
  }

  if (result.reason === "blocked_by_os") {
    return {
      kind: "os_blocked",
      message: "macOS is blocking Haven Office from reaching this server.",
    };
  }

  if (result.reason === "unreachable" || result.reason === "tls_error") {
    return { kind: "unreachable", message: "Server unreachable." };
  }

  // rate_limited, server_error, bad_response, not_found: none of these is the
  // tray's business to diagnose further. The client's own `detail` already
  // phrases the one sentence worth showing.
  return { kind: "error", message: result.detail };
}

/**
 * Phrase a count given whether it is live or the last one we actually saw.
 *
 * Showing a stale number with no qualifier is how a tray lies: the owner
 * glances at "3" and has no way to know it is from twenty minutes ago. `null`
 * means we have never once had a successful poll, which is different again
 * from "had one, then lost the connection".
 */
export function describeBadge(state: SurfaceState, lastKnownCount: number | null): string {
  if (state.kind === "ok") {
    return lastKnownCount === null ? "" : String(lastKnownCount);
  }

  return lastKnownCount === null ? "" : `${lastKnownCount}?`;
}
