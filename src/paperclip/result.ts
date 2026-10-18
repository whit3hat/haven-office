/**
 * Every call into a Paperclip server resolves. Nothing here throws.
 *
 * The reason is not politeness about error handling — it is what the surface
 * needs. A menu-bar item has to render "macOS is blocking the local network"
 * differently from "the server is down" differently from "you are signed out",
 * and it has to do it without a try/catch around every poll tick. A thrown
 * error carries that distinction in a string at best; a result carries it in a
 * field the menu can switch on.
 */

import type { TransportFailureReason } from "./transport";

/**
 * Why a call did not produce data.
 *
 * `TransportFailureReason` covers what can be learned from a failed socket.
 * The rest are judgements about a response we did get, and each one maps to a
 * different thing the user would do about it:
 *
 * - `signed_out`   — sign in, in the window. Not an error; the expected state
 *                    before the user has ever logged in.
 * - `forbidden`    — authenticated, but not as someone with board access. This
 *                    is what an *agent* key gets on /attention, and the reason
 *                    the app authenticates as the signed-in user instead.
 * - `not_found`    — wrong company id, or an endpoint this server version does
 *                    not have. Worth distinguishing from `server_error` so a
 *                    version mismatch does not look like an outage.
 * - `rate_limited` — back off hard; `watch` keys off this.
 * - `server_error` — the server broke. Retrying may help.
 * - `bad_response` — HTTP 200 carrying something we cannot read. Almost always
 *                    a proxy or a captive portal answering for the server, so
 *                    it must not be reported as a Paperclip fault.
 * - `no_credential`— nothing to authenticate with yet. Distinct from
 *                    `signed_out`: the fallback strategy has no stored key,
 *                    which is a setup step rather than a session expiry.
 *
 * There is deliberately no `cancelled`: `watch` stops by not scheduling
 * another tick and discarding whatever is in flight, so no caller ever has to
 * render a cancellation.
 */
export type PaperclipFailureReason =
  | TransportFailureReason
  | "signed_out"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "bad_response"
  | "no_credential";

export interface PaperclipFailure {
  ok: false;
  reason: PaperclipFailureReason;
  /** One sentence fit to show a user. Never a raw stack or "fetch failed". */
  detail: string;
  /** Present when the server answered at all. */
  status?: number;
}

export interface PaperclipSuccess<T> {
  ok: true;
  data: T;
  status: number;
}

export type PaperclipResult<T> = PaperclipSuccess<T> | PaperclipFailure;

export function success<T>(data: T, status: number): PaperclipSuccess<T> {
  return { ok: true, data, status };
}

export function failure(
  reason: PaperclipFailureReason,
  detail: string,
  status?: number,
): PaperclipFailure {
  return status === undefined ? { ok: false, reason, detail } : { ok: false, reason, detail, status };
}

/**
 * Whether a failure is worth telling the user about *right now*.
 *
 * `watch` and the surface both need this. A transient 500 during a poll is
 * noise; being signed out or blocked by the OS is the entire message. Keeping
 * the judgement here means the tray and any future surface agree on it.
 */
export function isActionableFailure(reason: PaperclipFailureReason): boolean {
  return (
    reason === "signed_out" ||
    reason === "forbidden" ||
    reason === "blocked_by_os" ||
    reason === "tls_error" ||
    reason === "no_credential"
  );
}

/**
 * Map an HTTP status onto a reason.
 *
 * 401 and 403 are split on purpose. Paperclip returns 401 when there is no
 * usable session and 403 ("Board access required" / "Board user context
 * required") when the caller authenticated but not as a board user — which is
 * exactly what happens if the app ever authenticates with an agent key. Those
 * need different copy: one says "sign in", the other says "this credential is
 * the wrong kind".
 */
export function reasonForStatus(status: number): PaperclipFailureReason {
  if (status === 401) {
    return "signed_out";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return "server_error";
}
