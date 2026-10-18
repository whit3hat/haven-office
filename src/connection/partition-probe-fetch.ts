/**
 * The remote-preflight probe transport: Chromium's stack, over the partition
 * the window will use, with that partition's cookies actually attached.
 *
 * Why this exists on top of `createManualRedirectFetch`
 * ----------------------------------------------------
 * Passing a `session` to Electron's network stack does **not** send that
 * session's cookies. From Electron 41.10.7's own
 * `ClientRequestConstructorOptions` declarations:
 *
 *   credentials — "If this option is not specified, authentication data from
 *   the session will be sent, and cookies will not be sent (unless
 *   `useSessionCookies` is set)."
 *   useSessionCookies — "Whether to send cookies with this request from the
 *   provided session. … Default is `false`."
 *
 * A probe built with the defaults is therefore unauthenticated. The server
 * answers `401 Board authentication required`, preflight reports
 * `sessionState: "signed_out"` for a user who is signed in, and the start path
 * then opens the server root instead of their remembered view (HAV-45).
 *
 * Two mechanisms, deliberately both — the same split `src/paperclip/electron.ts`
 * already makes for the data layer:
 *
 * 1. `credentials: "include"` on the request. This is the documented mechanism.
 * 2. An explicit `Cookie` header read from the partition's jar. This one is
 *    transport-independent, so it is the path a test can prove without a Mac —
 *    and the missing option, not preflight's logic, was the defect.
 *
 * `cookies.get` in the main process returns `httpOnly` cookies, which is
 * essential: the Paperclip session cookie is `httpOnly`.
 *
 * Scoping, because the probed URL is attacker-influenced
 * -----------------------------------------------------
 * Cookies are read for the origin being probed and no other, and preflight pins
 * itself to fixed same-origin paths and declines redirects (see
 * ./manual-redirect-fetch.ts). So a crafted URL cannot aim one remote's jar at
 * another host: a redirect is reported, never followed, and the jar consulted is
 * always the one belonging to the host actually being asked.
 */

import { serializeCookies, type CookieReader } from "../paperclip/auth";
import {
  createManualRedirectFetch,
  type ClientRequestLike,
  type CreateRequestInit,
} from "./manual-redirect-fetch";

/** What the probe hands Electron's `net.request`, session and cookies included. */
export interface ProbeRequestInit<SessionLike> extends CreateRequestInit {
  session: SessionLike;
  credentials: "include";
}

export interface PartitionProbeFetchOptions<SessionLike> {
  /** The partition the connection window will use. */
  session: SessionLike;
  /** Normally `(init) => electronNet.request(init)`. */
  createRequest: (init: ProbeRequestInit<SessionLike>) => ClientRequestLike;
  /** Reads the partition's jar; see `partitionCookieReader`. */
  readCookies: CookieReader;
  maxBodyBytes?: number;
}

export function createPartitionProbeFetch<SessionLike>(
  options: PartitionProbeFetchOptions<SessionLike>,
): typeof fetch {
  const transport = createManualRedirectFetch({
    maxBodyBytes: options.maxBodyBytes,
    createRequest: (init) =>
      options.createRequest({
        ...init,
        session: options.session,
        // Not optional: without it the request carries no cookies at all.
        credentials: "include",
      }),
  });

  return withSessionCookies(transport, options.readCookies);
}

/**
 * Attach a jar's cookies for the request's origin as an explicit header.
 *
 * Leaves an already-set `Cookie` header alone so a caller can still speak for
 * itself, and never fails the request: a jar we cannot read means no cookies,
 * which preflight reports accurately as `signed_out`. Failing the probe instead
 * would turn "not signed in" into "host unreachable".
 */
export function withSessionCookies(
  fetchImpl: typeof fetch,
  readCookies: CookieReader,
): typeof fetch {
  const cookieBearingFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);

    if (!headers.has("cookie")) {
      const cookie = await readOriginCookies(readCookies, requestUrl(input));
      if (cookie) {
        headers.set("cookie", cookie);
      }
    }

    return fetchImpl(input, { ...init, headers });
  };

  return cookieBearingFetch as typeof fetch;
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  return typeof input === "string" ? input : input.url;
}

async function readOriginCookies(
  readCookies: CookieReader,
  url: string,
): Promise<string | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }

  try {
    const cookies = await readCookies(origin);
    return cookies.length > 0 ? serializeCookies(cookies) : null;
  } catch {
    return null;
  }
}
