/**
 * The one file in this module that knows Electron exists.
 *
 * Everything else takes a `fetch` and an `AuthStrategy`, which is what makes
 * the client testable without a display. This file is the wiring: it turns a
 * connection profile into a client that authenticates as the signed-in user.
 *
 * Why the transport is the session's `fetch` and not the global one
 * ----------------------------------------------------------------
 * The same reason `remotePartitionFetch` in `src/main.ts` exists. Node's
 * global `fetch` in the main process is undici: it carries Node's bundled CA
 * list rather than the OS trust store, ignores the proxy and client
 * certificates the session is configured with — and, decisively here, has no
 * access to the cookie jar the user signed in to. `ses.fetch` is Chromium's
 * stack over that exact partition.
 *
 * `credentials: "include"` is not optional
 * ---------------------------------------
 * This is the detail the whole cookie-reuse approach turns on, and it is the
 * opposite of what you would guess. Passing a `session` to Electron's network
 * stack does **not** send that session's cookies. From Electron 41.10.7's own
 * `ClientRequestConstructorOptions` declarations:
 *
 *   credentials — "If this option is not specified, authentication data from
 *   the session will be sent, and cookies will not be sent (unless
 *   `useSessionCookies` is set)."
 *   useSessionCookies — "Whether to send cookies with this request from the
 *   provided session. … Default is `false`."
 *
 * So a request issued over the right partition with the defaults is
 * *unauthenticated*, and the server answers 401 — which looks exactly like
 * "the user is signed out" and would have sent us to build the API-key
 * fallback for no reason. We set `credentials: "include"` here, and the
 * strategy additionally sends an explicit `Cookie` header read from the jar,
 * because that second path is the one the tests can actually prove.
 */

import { session, safeStorage, type Session } from "electron";
import { createPaperclipClient, type PaperclipClient } from "./client";
import {
  boardApiKeyStrategy,
  firstAvailableStrategy,
  sessionCookieStrategy,
  type AuthStrategy,
  type CookieReader,
} from "./auth";
import { BoardKeyStore } from "./board-key-store";

/**
 * Read cookies for an origin out of a Chromium partition.
 *
 * `cookies.get` in the main process returns `httpOnly` cookies too, which is
 * essential: the Paperclip session cookie is `httpOnly`, so nothing in a
 * renderer could ever have read it. This is a main-process-only capability.
 */
export function partitionCookieReader(partitionSession: Session): CookieReader {
  return async (url: string) => {
    const cookies = await partitionSession.cookies.get({ url });
    return cookies.map((cookie) => ({ name: cookie.name, value: cookie.value }));
  };
}

/**
 * A `fetch` bound to a partition, with that partition's cookies attached.
 *
 * Unlike `createManualRedirectFetch`, this supports request bodies, which the
 * dismissal endpoints need. It does not implement `redirect: "manual"` — the
 * client asks for `redirect: "error"` instead, because an API path that
 * redirects is a failure here rather than something to report a location for.
 */
export function partitionFetch(partitionSession: Session): typeof fetch {
  const sessionFetch: typeof fetch = (input, init) =>
    partitionSession.fetch(input as string, {
      ...(init as RequestInit),
      credentials: "include",
    });
  return sessionFetch;
}

export interface ElectronClientOptions {
  origin: string;
  companyId: string;
  /** The window's partition, e.g. `persist:paperclip-remote-<profileId>`. */
  partition: string;
  /** Scopes the fallback credential so two remotes cannot read each other's. */
  profileId: string;
  /** Electron's `app.getPath("userData")`. Only used by the fallback store. */
  userDataPath: string;
  timeoutMs?: number;
}

/**
 * Build a client that acts as the signed-in user for one connection.
 *
 * The strategies are ordered, not chosen: the cookie needs no setup, so it
 * wins whenever the user is signed in, and the keychain fallback is only
 * reached when there is no session at all.
 */
export function createElectronPaperclipClient(options: ElectronClientOptions): PaperclipClient {
  const partitionSession = session.fromPartition(options.partition);
  const boardKeys = new BoardKeyStore({
    directory: options.userDataPath,
    safeStorage,
  });

  const auth: AuthStrategy = firstAvailableStrategy([
    sessionCookieStrategy(partitionCookieReader(partitionSession)),
    boardApiKeyStrategy(() => boardKeys.load(options.profileId)),
  ]);

  return createPaperclipClient({
    origin: options.origin,
    companyId: options.companyId,
    auth,
    fetchImpl: partitionFetch(partitionSession),
    timeoutMs: options.timeoutMs,
  });
}

/** The keychain-backed store, for the settings path that sets a fallback key. */
export function createBoardKeyStore(userDataPath: string): BoardKeyStore {
  return new BoardKeyStore({ directory: userDataPath, safeStorage });
}
