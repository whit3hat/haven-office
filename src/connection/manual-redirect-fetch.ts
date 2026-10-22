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

export interface ManualRedirectFetchOptions {
  createRequest: (init: CreateRequestInit) => ClientRequestLike;
  /** Guard against an endpoint that streams forever; probes are tiny. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

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

function headerEntries(init: HeadersInit | undefined): Array<[string, string]> {
  if (!init) {
    return [];
  }
  return [...new Headers(init).entries()];
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

  const manualRedirectFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const signal = init?.signal ?? null;

      if (signal?.aborted) {
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
        reject(error);
        return;
      }

      for (const [name, value] of headerEntries(init?.headers)) {
        request.setHeader(name, value);
      }

      if (signal) {
        const onAbort = () => {
          const reason = signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
          settle(() => reject(reason));
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
        settle(() =>
          resolve(
            new Response(null, {
              status: redirected!.status,
              headers: redirected!.headers,
            }),
          ),
        );
        return true;
      };

      request.on("response", (response: IncomingMessageLike) => {
        responded = { status: response.statusCode };
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
            settle(() => reject(new Error(`Response exceeded ${maxBodyBytes} bytes.`)));
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
          settle(() => reject(error));
        });

        response.on("end", () => {
          if (overflowed) {
            return;
          }
          const status = response.statusCode;
          // 204/205/304 must have a null body or the Response constructor throws.
          const body = status === 204 || status === 205 || status === 304 || method === "HEAD"
            ? null
            : new Uint8Array(Buffer.concat(chunks));
          settle(() =>
            resolve(
              new Response(body, {
                status,
                statusText: response.statusMessage ?? "",
                headers: toHeaders(response.headers ?? {}),
              }),
            ),
          );
        });
      });

      request.on("error", (error: Error) => {
        if (resolveRedirect()) {
          return;
        }
        settle(() => reject(error));
      });

      request.on("abort", () => {
        if (resolveRedirect()) {
          return;
        }
        settle(() =>
          reject(transportError(`The request to ${url} was cancelled.`, "ERR_ABORTED")),
        );
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
        if (resolveRedirect()) {
          return;
        }
        if (responded) {
          const started = responded;
          const target = describeTarget(url);
          settle(() =>
            reject(
              transportError(
                `${target} sent HTTP ${started.status} but the connection closed before the response body finished.`,
                "ERR_RESPONSE_INCOMPLETE",
              ),
            ),
          );
        }
      });

      request.end();
    });

  return manualRedirectFetch as typeof fetch;
}
