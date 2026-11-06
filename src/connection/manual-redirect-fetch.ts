/**
 * A `fetch`-shaped probe over Electron's `ClientRequest` that implements
 * `redirect: "manual"` the way the Fetch standard means it.
 *
 * Why this exists
 * ---------------
 * Remote preflight deliberately refuses to follow redirects: the URL a user
 * types is attacker-influenced (see the `?next=` case in
 * test/connection-preflight.test.mjs), so the probe pins itself to fixed
 * same-origin paths and treats a 3xx as a result to report rather than a hop
 * to take.
 *
 * Electron cannot express that through `session.fetch`. Its `net.fetch`
 * forwards the `redirect` mode to `ClientRequest` and never registers a
 * `redirect` listener (lib/browser/api/net-fetch.ts), and `ClientRequest`
 * documents manual mode as "the redirection will be cancelled unless
 * `request.followRedirect` is invoked synchronously during the redirect
 * event". So a redirected probe does not resolve with a 3xx `Response` the way
 * web `fetch` does — it is cancelled and rejects with an opaque network error,
 * which preflight could only report as an unreachable host.
 *
 * This wrapper listens for `redirect`, declines to follow, and synthesizes the
 * 3xx `Response` the caller expected, so preflight can say "that host
 * redirected us, and here is where to" instead of "unreachable".
 *
 * Only what preflight needs is supported: GET probes, request headers, an
 * abort signal, and a buffered response body.
 *
 * What it writes to main.log
 * --------------------------
 * Every attempt narrates its transport events in order, through an injected
 * `log` (see `TransportLogger`). Before 2026-10-22 it narrated nothing, and the
 * only thing visible from outside the owner's Mac was the
 * `ERR_CONNECTION_CLOSED` sentence this module *invents* — so four days of
 * HAV-44 went into theories about the network, macOS permissions, saved app
 * state and per-app filtering, when the one fact that settles it is an ordering
 * with elapsed times: `close` at +2 ms with nothing received, then `response`
 * HTTP 200 at +253 ms. That is unmistakable in one glance and was unavailable
 * in any form.
 *
 * Hence the elapsed `+NNNms` on every line: wall-clock stamps from the logger
 * cannot resolve a 2 ms writable-side close from the response a quarter-second
 * later, and that gap *is* the diagnosis. The clock starts when this function is
 * entered — not at `request.end()` — so it includes request construction and
 * header wiring. Sub-millisecond in practice, but the field's precision is the
 * reason this trace exists, so the claim has to match the code.
 *
 * The logger is an option rather than a direct `electron-log` import so this
 * module stays Electron-free and testable under plain `node --test`; the real
 * sink is wired in `remoteProbeTransports` (src/main.ts). It defaults to a
 * no-op, so a caller that passes nothing — including every existing test —
 * behaves exactly as before.
 *
 * Nothing logged may carry a credential, and the rule is applied by who controls
 * the string rather than by how a field looks:
 *
 * - The **probed** URL is pinned by `./validate.ts` to a fixed same-origin path
 *   with userinfo rejected, so its host and path are safe in full; only the
 *   query is collapsed to a marker. See `redactUrl`.
 * - A **redirect location** carries no such guarantee, and path-borne tokens are
 *   the norm for Cloudflare Access, signed URLs and `/s/<token>` share links, so
 *   everything after the first path segment goes too. See
 *   `redactRedirectLocation`.
 * - **`error.message`** and **`content-type`** are unbounded server-controlled
 *   free text. Both are collapsed to one line, stripped of userinfo and of
 *   anything from the first `?`/`#`, and capped — one event, one line, bounded
 *   length. See `redactMessage` and `redactHeaderValue`.
 * - Request headers, cookies, the jar and response bodies are never written at
 *   all; a body is a byte count.
 */

export interface IncomingMessageLike {
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ClientRequestLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  setHeader(name: string, value: string): void;
  abort(): void;
  end(): void;
}

export interface CreateRequestInit {
  method: string;
  url: string;
  redirect: "manual";
}

/**
 * The narrow slice of `electron-log` this module needs.
 *
 * Declared structurally so the transport never imports Electron: `log.info` and
 * `log.warn` are the two methods used, `warn` for an attempt that failed so a
 * reader scanning main.log for trouble finds it by level rather than by reading
 * every trace.
 */
export interface TransportLogger {
  info(message: string): void;
  warn(message: string): void;
}

const NO_LOGGING: TransportLogger = { info: () => {}, warn: () => {} };

export interface ManualRedirectFetchOptions {
  createRequest: (init: CreateRequestInit) => ClientRequestLike;
  /** Guard against an endpoint that streams forever; probes are tiny. */
  maxBodyBytes?: number;
  /** Where the event trace goes. Omitted means no logging at all. */
  log?: TransportLogger;
  /**
   * Which probe this is, for a trace where two run against the same host at
   * once — `/api/health` and `/api/auth/get-session` overlap in preflight.
   */
  logLabel?: string;
}

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Correlates the lines of one attempt, and is module-scoped so the two
 * transports built per preflight cannot hand out the same number.
 *
 * It restarts at 1 on every app launch while `main.log` is appended to across
 * launches, so one file can hold several unrelated `#1 health` attempts. The
 * wall-clock stamp electron-log prepends is what separates them; the runbook
 * says so where it teaches the format.
 */
let attemptSequence = 0;

/**
 * Synthesize a transport error that `describeFetchError` can actually diagnose.
 *
 * Everything in src/paperclip/transport.ts keys off `error.code`: the DNS, the
 * refusal, the macOS Local Network and the TLS hints are all selected by code,
 * and an error with none reaches the user as a bare sentence with no repair
 * attached. The errors below are the only ones in the probe path that this
 * module invents rather than forwards, so they are the only ones that have to
 * carry their own code — and until 2026-10-21 they did not. The owner's report
 * on HAV-44 was the bare sentence: "Could not verify remote. Request to
 * https://paperclip.lab.havenco.xyz/api/health closed before a response
 * arrived." No code, no classification, nothing to act on.
 */
function transportError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** `host:port` as typed, for a message a user reads. Falls back to the URL. */
function describeTarget(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Caps on the three fields a server, not this app, decides the length of.
 *
 * A trace is only pasteable if it is bounded, and the runbook teaches one line
 * per event; an unbounded field breaks both. 200 characters is several times any
 * real `net::ERR_*` sentence, and a `content-type` past 80 is already a finding
 * in itself rather than something to print in full.
 */
const MAX_LOGGED_TEXT_CHARS = 200;
const MAX_LOGGED_HEADER_CHARS = 80;
const MAX_LOGGED_SEGMENT_CHARS = 48;

/**
 * One event, one line — and the true length, so a cap is never mistaken for the
 * whole value. `grep '[verify-remote]'` has to return every line of a trace;
 * a message with an embedded newline silently drops its continuation.
 */
function capped(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}<truncated, ${value.length} chars>`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * `host/path` for the log — never the query string, never userinfo.
 *
 * The probed URL is typed by a user and treated as attacker-influenced
 * everywhere else in preflight (see the `?next=` case in
 * test/connection-preflight.test.mjs). main.log is a file the owner pastes into
 * an issue, so anything in a query string travels with it. `URL.host` excludes
 * any `user:password@`, and the query is collapsed to a marker: knowing one was
 * present is diagnostic, knowing its contents is a liability.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search ? "?<redacted>" : ""}`;
  } catch {
    return "<unparseable-url>";
  }
}

/**
 * Where a redirect sent us, with the path reduced to its first segment.
 *
 * `redactUrl`'s full path is only safe because the probed URL is pinned
 * upstream: validate.ts rejects userinfo and strips path, query and fragment, so
 * the transport only ever sees `https://host/api/health`. A `Location` is
 * whatever the server said, and tokens live in paths as often as in queries —
 * Cloudflare Access emits `/cdn-cgi/access/login/<jwt>/callback`, share links
 * are `/s/<token>`. Keeping the host and the first segment answers the only
 * question the diagnosis asks ("did it leave our host, and roughly where to")
 * and leaves nothing behind to carry a credential.
 */
function redactRedirectLocation(location: string): string {
  try {
    const parsed = new URL(location);
    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    const head = segments.length > 0 ? `/${capped(segments[0], MAX_LOGGED_SEGMENT_CHARS)}` : "/";
    const tail = segments.length > 1 ? "/<redacted>" : "";
    return `${parsed.host}${head}${tail}${parsed.search ? "?<redacted>" : ""}`;
  } catch {
    return "<unparseable-url>";
  }
}

/**
 * Chromium's own error text, flattened, de-credentialed and bounded.
 *
 * `error.code` is the prize here — it is what Chromium actually reported, as
 * opposed to the codes this module synthesizes — but the message beside it is
 * unbounded free text from the network stack with no guarantee of being
 * URL-free. Four passes, in this order:
 *
 * 1. Collapse whitespace, because the `?`/`#` cut below matches `\S*` and so
 *    stops at a newline — a URL on a second line would be only half scrubbed,
 *    and the line itself would escape a grep for the trace prefix.
 * 2. Strip `//user:pass@`. Not reachable from the typed URL (validate.ts
 *    rejects it) but free to close for a string the server writes.
 * 3. Strip the credential after a `Bearer`/`Basic` scheme, for a proxy or a
 *    gateway that quotes the request it rejected.
 * 4. Cut from the first `?` or `#`, which leaves `net::ERR_*` untouched and
 *    defuses an embedded query.
 * 5. Cap the length.
 *
 * Steps 2 and 3 are **best effort and nothing more**. Free text written by a
 * remote host cannot be proven credential-free by pattern matching, which is
 * why the cap exists and why docs/install-runbook.md tells a reader that
 * anything credential-shaped in a `[verify-remote]` line is a security finding
 * rather than a logging bug. The fields that *are* guaranteed are the ones this
 * module builds itself.
 */
function redactMessage(message: string): string {
  const flattened = oneLine(message);
  const withoutUserinfo = flattened.replace(/\/\/[^/\s@]*@/g, "//<redacted>@");
  const withoutScheme = withoutUserinfo.replace(
    /\b(bearer|basic)\s+[^\s,;]+/gi,
    (_match, scheme: string) => `${scheme} <redacted>`,
  );
  const withoutQuery = withoutScheme.replace(/[?#]\S*/g, (match) => `${match[0]}<redacted>`);
  return capped(withoutQuery, MAX_LOGGED_TEXT_CHARS);
}

/**
 * `content-type` is the one response header worth logging and still server
 * controlled, so it is flattened and capped like any other free text. It cannot
 * carry a credential by definition, but it can carry 400 characters of
 * whatever a captive portal feels like emitting.
 */
function redactHeaderValue(value: string): string {
  return capped(oneLine(value), MAX_LOGGED_HEADER_CHARS);
}

function headerEntries(init: HeadersInit | undefined): Array<[string, string]> {
  if (!init) {
    return [];
  }
  return [...new Headers(init).entries()];
}

/**
 * `code=… name=… message=…` for whatever the network stack handed us.
 *
 * The code is first because it is the field worth reading: `describeFetchError`
 * in src/paperclip/transport.ts selects every repair hint off it, and a
 * `code=<none>` in the log is itself the finding — it means the user got a bare
 * sentence with nothing to act on.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    // Same three fields in the same order even when the stack throws something
    // that is not an Error, so the shape the runbook teaches is stable and one
    // grep pattern reads every failure line.
    return `code=<none> name=<not-an-error> message=${redactMessage(String(error))}`;
  }
  const code = (error as { code?: unknown }).code;
  const shown = typeof code === "string" && code.length > 0 ? code : "<none>";
  return `code=${shown} name=${error.name} message=${redactMessage(error.message)}`;
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

export function createManualRedirectFetch(options: ManualRedirectFetchOptions): typeof fetch {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = options.log ?? NO_LOGGING;
  const label = options.logLabel ?? "probe";

  const manualRedirectFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const signal = init?.signal ?? null;

      const attempt = `#${++attemptSequence}`;
      // Entry, deliberately: earlier than `request.end()`, so request
      // construction and header wiring are inside the measurement rather than
      // invisible before it. For the session probe the awaited cookie-jar read
      // still sits outside, in `withSessionCookies` — which is why a caller
      // timeout spent in the jar surfaces as `signal-already-aborted` at +0ms
      // and not as `aborted-by-caller` at +8000ms.
      const startedAt = Date.now();
      const prefix = () => `[verify-remote] ${attempt} ${label} +${Date.now() - startedAt}ms`;
      const trace = (event: string) => log.info(`${prefix()} ${event}`);
      const traceFailure = (event: string) => log.warn(`${prefix()} ${event}`);

      log.info(`[verify-remote] ${attempt} ${label} ${method} ${redactUrl(url)} start`);

      if (signal?.aborted) {
        traceFailure("settle reject reason=signal-already-aborted");
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        return;
      }

      let settled = false;
      let redirected: { status: number; location: string; headers: Headers } | null = null;
      // Set the moment response headers arrive, so a connection that dies
      // mid-body can say so instead of claiming no response ever came. Those
      // are different failures: one is "nothing answered", the other is
      // "something answered and was cut off", and only the second rules out
      // the whole class of repairs about reaching the host at all.
      let responded: { status: number } | null = null;
      let detachSignal = () => {};

      const settle = (run: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        detachSignal();
        run();
      };

      let request: ClientRequestLike;
      try {
        request = options.createRequest({ method, url, redirect: "manual" });
      } catch (error) {
        traceFailure(`settle reject reason=create-request-threw ${describeError(error)}`);
        reject(error);
        return;
      }

      for (const [name, value] of headerEntries(init?.headers)) {
        request.setHeader(name, value);
      }

      if (signal) {
        const onAbort = () => {
          const reason = signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
          // The caller's timeout (fetchWithTimeout, src/paperclip/transport.ts)
          // lands here, and it is the backstop for a transaction that produces
          // nothing at all — so this line is what distinguishes "we gave up
          // waiting" from "the network said no".
          trace(`abort-signal ${describeError(reason)}`);
          settle(() => {
            traceFailure("settle reject reason=aborted-by-caller");
            reject(reason);
          });
          try {
            request.abort();
          } catch {
            // The request may already be finished; aborting twice is harmless.
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachSignal = () => signal.removeEventListener("abort", onAbort);
      }

      // Not calling followRedirect() is what declines the hop. Electron then
      // cancels the request, so the `error`/`abort` that follows is expected
      // and must resolve with the captured 3xx rather than reject.
      request.on("redirect", (statusCode: number, _method: string, redirectUrl: string, responseHeaders: Record<string, string | string[] | undefined>) => {
        const headers = toHeaders(responseHeaders ?? {});
        if (redirectUrl) {
          headers.set("location", redirectUrl);
        }
        redirected = { status: statusCode, location: redirectUrl, headers };
        // The location is server-controlled, and a token can sit in its path as
        // readily as in its query — an SSO hop does both. So it gets stricter
        // treatment than the probed URL, which validate.ts has already pinned:
        // host plus the first path segment, nothing after it.
        trace(
          `redirect status=${statusCode} location=${redirectUrl ? redactRedirectLocation(redirectUrl) : "<none>"} followed=no`,
        );
        try {
          request.abort();
        } catch {
          // Electron cancels it for us when the event handler returns.
        }
      });

      const resolveRedirect = () => {
        if (!redirected) {
          return false;
        }
        // A 3xx carries no body here; `Response` permits a null body for these.
        settle(() => {
          trace(`settle resolve status=${redirected!.status} reason=captured-redirect`);
          resolve(
            new Response(null, {
              status: redirected!.status,
              headers: redirected!.headers,
            }),
          );
        });
        return true;
      };

      request.on("response", (response: IncomingMessageLike) => {
        responded = { status: response.statusCode };
        // `content-type` only: it is the header that says whether a captive
        // portal or a proxy answered with HTML where JSON was expected, and it
        // is the one response header that cannot carry a credential. It is still
        // server-controlled free text, so it is flattened and capped.
        const contentType = toHeaders(response.headers ?? {}).get("content-type");
        trace(
          `response status=${response.statusCode} content-type=${contentType === null ? "<none>" : redactHeaderValue(contentType)}`,
        );
        const chunks: Buffer[] = [];
        let total = 0;
        let overflowed = false;

        response.on("data", (chunk: Buffer) => {
          if (overflowed) {
            return;
          }
          total += chunk.length;
          if (total > maxBodyBytes) {
            overflowed = true;
            settle(() => {
              traceFailure(
                `settle reject reason=body-too-large bytes=${total} limit=${maxBodyBytes}`,
              );
              reject(new Error(`Response exceeded ${maxBodyBytes} bytes.`));
            });
            try {
              request.abort();
            } catch {
              // Already torn down.
            }
            return;
          }
          chunks.push(chunk);
        });

        response.on("error", (error: Error) => {
          trace(`response.error ${describeError(error)}`);
          settle(() => {
            // The code rides on the settle line too. Every other reject reason
            // carries a code, and the runbook sends a reader to `[warn]` to find
            // the failure — so the two reasons that forward a *real* Chromium
            // code must not be the two that make you read a second line for it.
            traceFailure(`settle reject reason=response-stream-error ${describeError(error)}`);
            reject(error);
          });
        });

        response.on("end", () => {
          if (overflowed) {
            return;
          }
          trace(`response.end bytes=${total}`);
          const status = response.statusCode;
          // 204/205/304 must have a null body or the Response constructor throws.
          const body = status === 204 || status === 205 || status === 304 || method === "HEAD"
            ? null
            : new Uint8Array(Buffer.concat(chunks));
          settle(() => {
            trace(`settle resolve status=${status} reason=response-end`);
            resolve(
              new Response(body, {
                status,
                statusText: response.statusMessage ?? "",
                headers: toHeaders(response.headers ?? {}),
              }),
            );
          });
        });
      });

      request.on("error", (error: Error) => {
        // Chromium's own code, which is the whole point: `ERR_CONNECTION_CLOSED`
        // in the badge was ours, invented below, and said nothing about what the
        // network did. This line is the one that does.
        trace(`error ${describeError(error)}`);
        if (resolveRedirect()) {
          return;
        }
        settle(() => {
          traceFailure(`settle reject reason=transport-error ${describeError(error)}`);
          reject(error);
        });
      });

      request.on("abort", () => {
        trace("abort");
        if (resolveRedirect()) {
          return;
        }
        settle(() => {
          traceFailure("settle reject reason=request-aborted code=ERR_ABORTED");
          reject(transportError(`The request to ${url} was cancelled.`, "ERR_ABORTED"));
        });
      });

      // `close` is NOT the last event of an Electron 41 transaction, despite
      // what the docs imply. `ClientRequest` emits `finish` then `close`
      // synchronously the instant `request.end()` runs — on the *writable* side,
      // before any network activity — and the `response` follows ~250 ms later.
      // Reproduced in Electron 41.10.7 (Chromium 146) on the owner's Mac,
      // HAV-44, 2026-10-22: a probe that settled on bare `close` rejected
      // ERR_CONNECTION_CLOSED at 2 ms and discarded the real HTTP 200 that
      // arrived at 253 ms — host-independent, which is why the lab host and
      // example.com failed identically and nothing on the network ever mattered.
      //
      // So `close` is only a result in two cases: a captured redirect, or a
      // response that had already started and was cut off before its body ended
      // (ERR_RESPONSE_INCOMPLETE). A bare `close` with nothing received yet is
      // ignored; the real terminal event — `response`→`end`, `error`, or
      // `abort` — still follows, and the caller's abort timeout
      // (fetchWithTimeout, src/paperclip/transport.ts) is the guaranteed
      // backstop for a transaction that truly produces nothing.
      request.on("close", () => {
        // `responded`/`redirected` are the two facts that decide whether this
        // close means anything, so they go in the line. An elapsed `+2ms` with
        // `responded=no` is the HAV-44 signature.
        const state =
          `close responded=${responded ? `HTTP ${responded.status}` : "no"}` +
          ` redirected=${redirected ? `HTTP ${redirected.status}` : "no"}`;
        // One line, not two: the ignored verdict is decided by exactly the two
        // facts already in `state`, so a second line repeated them and said
        // nothing new while making up a third of a healthy attempt's volume.
        if (!responded && !redirected) {
          trace(`${state} ignored reason=nothing-received-yet awaiting=response|error|abort`);
          return;
        }
        trace(state);
        if (resolveRedirect()) {
          return;
        }
        if (responded) {
          const started = responded;
          const target = describeTarget(url);
          settle(() => {
            traceFailure(
              `settle reject reason=closed-mid-body status=${started.status} code=ERR_RESPONSE_INCOMPLETE`,
            );
            reject(
              transportError(
                `${target} sent HTTP ${started.status} but the connection closed before the response body finished.`,
                "ERR_RESPONSE_INCOMPLETE",
              ),
            );
          });
          return;
        }
      });

      request.end();
    });

  return manualRedirectFetch as typeof fetch;
}
