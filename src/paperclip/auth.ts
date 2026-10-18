/**
 * One auth seam, two strategies.
 *
 * Why there is a seam at all
 * --------------------------
 * The endpoints this app exists to read are board-scoped. `GET
 * /api/companies/{id}/attention` calls `assertBoard(req)` and then refuses
 * anything without `req.actor.userId`, so an agent key gets
 * `403 Board access required`. The app has to act as **the signed-in user**.
 *
 * Two ways to do that, and the surface must not care which is in play:
 *
 * 1. `sessionCookieStrategy` — reuse the Chromium session the user already
 *    signed into inside the window. Nothing for the user to manage. This is
 *    the one we want, and the one wired up by default.
 * 2. `boardApiKeyStrategy` — a board API key held in the OS keychain. Needed
 *    if cookie reuse is ever unavailable, and it genuinely works for these
 *    endpoints: the server resolves a board key to `userId: boardKey.userId`,
 *    so a board key satisfies the same `req.actor.userId` check a session
 *    does. (An *agent* key never will — different actor type.)
 *
 * Neither implementation imports Electron. The cookie strategy takes a reader
 * function and the key strategy takes a loader, so both are unit-testable off
 * a Mac; `src/paperclip/electron.ts` is the only file that knows about
 * `session.fromPartition` and `safeStorage`.
 */

import { failure, type PaperclipFailure } from "./result";

export type AuthStrategyKind = "session_cookie" | "board_api_key";

export type AuthDecision =
  | { ok: true; headers: Record<string, string> }
  | ({ ok: false } & Pick<PaperclipFailure, "reason" | "detail">);

export interface AuthStrategy {
  readonly kind: AuthStrategyKind;
  /**
   * Headers that authenticate a request to `target`, or a failure explaining
   * why we cannot authenticate at all.
   *
   * Returning a failure rather than empty headers matters: it lets the client
   * report `signed_out` without spending a request, which is what makes a
   * closed-window poll cheap when the user has never logged in.
   */
  authorize(target: URL): Promise<AuthDecision>;
}

export interface CookieLike {
  name: string;
  value: string;
}

/** Reads cookies for a URL out of some cookie jar. Electron's is one. */
export type CookieReader = (url: string) => Promise<CookieLike[]>;

/**
 * Does this cookie look like a Paperclip board session?
 *
 * We match on the suffix instead of a literal name because the name is not
 * fixed. Paperclip configures better-auth with
 * `cookiePrefix: "paperclip-{instanceId}"`, so the cookie is
 * `paperclip-<instanceId>.session_token` — and `instanceId` differs per
 * server. On an https origin better-auth additionally applies the
 * `__Secure-` prefix. Hardcoding any single spelling would work against the
 * lab server and silently fail against the next one, so match the shape.
 */
export function isSessionCookie(name: string): boolean {
  const withoutPrefix = name.replace(/^__(?:Secure|Host)-/, "");
  return /(?:^|\.)session_token$/.test(withoutPrefix);
}

/**
 * Serialize a cookie jar into a `Cookie` request header.
 *
 * The strategy sends the header explicitly rather than relying on the
 * transport's jar. Both work, but an explicit header is the same on every
 * transport — including the injected `fetch` the tests use — so the thing the
 * tests prove is the thing that ships.
 */
export function serializeCookies(cookies: CookieLike[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export function sessionCookieStrategy(readCookies: CookieReader): AuthStrategy {
  return {
    kind: "session_cookie",
    async authorize(target: URL): Promise<AuthDecision> {
      let cookies: CookieLike[];
      try {
        cookies = await readCookies(target.origin);
      } catch (error) {
        return {
          ok: false,
          reason: "signed_out",
          detail: `Could not read the sign-in session for ${target.origin}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      if (!cookies.some((cookie) => isSessionCookie(cookie.name))) {
        return {
          ok: false,
          reason: "signed_out",
          detail: `No Paperclip sign-in session for ${target.origin}. Open the window and sign in.`,
        };
      }

      // Send the whole jar for the origin, not just the session cookie. Paperclip
      // also sets CSRF and company-scoping cookies, and the web app sends all of
      // them; sending a hand-picked subset is how you discover the server wanted
      // one you did not know about.
      return { ok: true, headers: { cookie: serializeCookies(cookies) } };
    },
  };
}

/** Loads a board API key, or null when none has been stored yet. */
export type BoardApiKeyLoader = () => Promise<string | null>;

export function boardApiKeyStrategy(loadKey: BoardApiKeyLoader): AuthStrategy {
  return {
    kind: "board_api_key",
    async authorize(target: URL): Promise<AuthDecision> {
      let key: string | null;
      try {
        key = await loadKey();
      } catch (error) {
        return {
          ok: false,
          reason: "no_credential",
          detail: `Could not read the stored board API key: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      if (!key) {
        return {
          ok: false,
          reason: "no_credential",
          detail: `No board API key stored for ${target.origin}.`,
        };
      }

      return { ok: true, headers: { authorization: `Bearer ${key}` } };
    },
  };
}

/**
 * Try the cookie first, fall back to a stored key.
 *
 * Ordered, not clever: the cookie costs nothing and needs no setup, so it wins
 * whenever it is there. The fallback is only reached when there is no session
 * at all, which is also the only case where asking the user for a key is a
 * reasonable thing to do.
 */
export function firstAvailableStrategy(strategies: AuthStrategy[]): AuthStrategy {
  return {
    kind: strategies[0]?.kind ?? "session_cookie",
    async authorize(target: URL): Promise<AuthDecision> {
      let last: AuthDecision = {
        ok: false,
        reason: "no_credential",
        detail: "No authentication strategy is configured.",
      };

      for (const strategy of strategies) {
        const decision = await strategy.authorize(target);
        if (decision.ok) {
          return decision;
        }
        last = decision;
      }

      return last;
    },
  };
}

/** Turn a refused `AuthDecision` into the client's failure shape. */
export function authFailure(decision: Extract<AuthDecision, { ok: false }>): PaperclipFailure {
  return failure(decision.reason, decision.detail);
}
