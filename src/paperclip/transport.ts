/**
 * Shared HTTP transport diagnostics for everything that talks to a Paperclip
 * server from the Electron main process.
 *
 * This file was extracted verbatim from `src/connection/preflight.ts`, which is
 * still its first consumer. It lives here rather than under `src/connection/`
 * because the Paperclip client needs the exact same classification and the one
 * thing worse than duplicating it would be the two copies drifting: the whole
 * value of `blocked_by_os` is that a single code path recognises the macOS 15
 * Local Network denial, so a user who has been told "enable Haven Office under
 * Local Network" once is never told "host unreachable" by a different screen.
 */

/**
 * The three transport outcomes this module can tell apart from an error alone.
 *
 * Deliberately a subset of `RemotePreflightFailureReason`: everything else in
 * that union is a judgement about a *response* (wrong deployment mode, not a
 * Paperclip server, auth not ready) and only the caller that made the request
 * knows those.
 */
export type TransportFailureReason = "unreachable" | "blocked_by_os" | "tls_error";

/**
 * Issue a request that cannot hang forever.
 *
 * Every caller here is on a user-visible path, so "no answer" has to become an
 * answer within a bounded time. `redirect: "manual"` is the caller's default
 * because a redirect is a result worth reporting, not a hop to take — see
 * src/connection/manual-redirect-fetch.ts.
 */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL | string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url as URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Flatten an error and everything on its `cause` chain.
 *
 * This exists because `fetch` hides the only useful part of a network failure.
 * Undici — the global `fetch` in Node and in Electron's main process — rejects
 * every transport failure as the literal `TypeError: fetch failed`, and puts
 * the real reason ("certificate has expired", "connect ECONNREFUSED", …) on
 * `error.cause`. Reading only `.message`, as this module used to, produced the
 * useless user-facing detail "fetch failed" and defeated the keyword matching
 * below, so every TLS rejection was reported as a plain unreachable host.
 */
export function unwrapErrorChain(error: unknown): { messages: string[]; codes: string[]; names: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
  const names: string[] = [];
  const seen = new Set<unknown>();

  let current: unknown = error;
  // The chain is short in practice; the bound is only here so a cyclic or
  // adversarially deep `cause` cannot spin.
  for (let depth = 0; current != null && depth < 8; depth += 1) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);

    if (current instanceof Error) {
      if (current.message) {
        messages.push(current.message);
      }
      if (current.name) {
        names.push(current.name);
      }
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && code) {
        codes.push(code);
      }
      current = (current as { cause?: unknown }).cause;
      continue;
    }

    if (typeof current === "string" && current) {
      messages.push(current);
    }
    break;
  }

  return { messages, codes, names };
}

/**
 * Error codes that mean "we reached the host but refused its certificate".
 * Node/OpenSSL codes come from undici; `ERR_CERT_*` / `ERR_SSL_*` come from
 * Chromium, which is what Electron's session-backed fetch reports.
 */
const TLS_ERROR_CODES = [
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];

/**
 * The three transport failures that all arrive as "Host unreachable", and the
 * different repairs they call for.
 *
 * Node/OpenSSL codes come from undici; `ERR_*` codes come from Chromium, which
 * is what Electron's session-backed fetch reports. Keeping both spellings
 * matters because the two stacks name the same failure differently.
 */
const DNS_ERROR_CODES = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
];

const REFUSED_ERROR_CODES = ["ECONNREFUSED", "ERR_CONNECTION_REFUSED"];

/**
 * macOS refused to let *this app* touch the local network.
 *
 * Since macOS 15 a GUI app needs an explicit Local Network grant to open a
 * socket to a private address. The denial is not reported as a permission
 * error: Chromium raises `ERR_NETWORK_ACCESS_DENIED`, and the BSD layer raises
 * `EPERM`/`EACCES` on `connect`. Nothing in any of them says "permission", so
 * without this mapping the app blames the network for an OS policy decision.
 */
const LOCAL_NETWORK_DENIED_ERROR_CODES = [
  "ERR_NETWORK_ACCESS_DENIED",
  "EPERM",
  "EACCES",
];

/**
 * The connection ended without a complete HTTP response.
 *
 * This is its own class, not a flavour of "unreachable": the socket got far
 * enough to end, so a name that never resolved and a port with nothing behind
 * it are both already excluded. What is left is something on the path between
 * this app and a server that answers the same URL elsewhere — and the three
 * candidates have nothing to do with each other, so the hint names all three.
 *
 * `ECONNRESET` is undici's spelling ("socket hang up"); the `ERR_*` spellings
 * are Chromium's, which is what the session-backed probe reports.
 * `ERR_RESPONSE_INCOMPLETE` is synthesized by
 * src/connection/manual-redirect-fetch.ts for an Electron response that was cut
 * off mid-body; `ERR_CONNECTION_CLOSED` is kept here because Chromium itself
 * reports it. The wrapper no longer synthesizes it: a bare Electron `close`
 * fires synchronously at `request.end()`, before any response, so it is not a
 * failure signal (HAV-44, Electron 41.10.7).
 */
const CONNECTION_CLOSED_ERROR_CODES = [
  "ECONNRESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
  "ERR_EMPTY_RESPONSE",
  "ERR_RESPONSE_INCOMPLETE",
  "ERR_QUIC_PROTOCOL_ERROR",
  "ERR_HTTP2_PROTOCOL_ERROR",
];

const UNROUTABLE_ERROR_CODES = [
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_INTERNET_DISCONNECTED",
];

/**
 * The one sentence that separates an OS denial from a real network problem.
 *
 * `EHOSTUNREACH` and a silent timeout are what a Local Network denial looks
 * like from inside the process, and they are also what a genuinely
 * unreachable host looks like. The app cannot tell the two apart from the
 * error — but the user can, in one command, because Terminal holds its own
 * grant. havenCo's report was exactly this: `curl` got HTTP 200 while the app
 * on the same Mac at the same moment called the host unreachable.
 */
const LOCAL_NETWORK_PERMISSION_HINT =
  "On macOS 15 and later, Haven Office also needs Local Network permission to reach a "
  + "private address: open System Settings → Privacy & Security → Local Network and enable "
  + "Haven Office. If `curl` to this URL works in Terminal but this check does not, that "
  + "permission is the cause and the network is fine.";

/**
 * Turn a transport error code into the one thing worth checking next.
 *
 * "Host unreachable" is true of a name that never resolved, a port with
 * nothing behind it, and an address that cannot be routed to — but those are
 * three unrelated repairs, and the code is the only thing that tells them
 * apart. havenCo's own remote is the motivating case: `paperclip.lab.havenco.xyz`
 * exists only in the lab's internal DNS and points at a private address, so a
 * Mac using any other resolver gets `ENOTFOUND` and a Mac off the LAN gets a
 * timeout. Neither is a fault in the app or the server.
 */
export function describeTransportFailure(
  codes: string[],
  names: string[],
  origin: string,
  platform: string,
): string | null {
  let host: string;
  let port: string;
  try {
    const url = new URL(origin);
    host = url.hostname;
    port = url.port || (url.protocol === "http:" ? "80" : "443");
  } catch {
    return null;
  }

  const isMac = platform === "darwin";

  if (codes.some((code) => LOCAL_NETWORK_DENIED_ERROR_CODES.includes(code))) {
    return isMac
      ? `macOS blocked Haven Office from reaching ${host}. This is the Local Network privacy `
        + "control, not a network fault: open System Settings → Privacy & Security → Local "
        + "Network and enable Haven Office. If Haven Office is not listed, quit it, reopen it "
        + "and try again so macOS can ask."
      : `The operating system blocked Haven Office from reaching ${host}.`;
  }

  if (codes.some((code) => DNS_ERROR_CODES.includes(code))) {
    return `The name "${host}" did not resolve on this Mac. A lab-internal name resolves only through the lab's own DNS servers, so check System Settings → Network → DNS, or that you are on the lab network or VPN.`;
  }

  if (codes.some((code) => REFUSED_ERROR_CODES.includes(code))) {
    return `${host} resolved and answered, but nothing is listening on port ${port}. Check the port in the URL.`;
  }

  // Reached before the timeout branch below because this failure is faster and
  // more specific than a timeout: the connection ended, so the host resolved
  // and something accepted the socket. Naming the path is the whole value here.
  if (codes.some((code) => CONNECTION_CLOSED_ERROR_CODES.includes(code))) {
    const base =
      `The connection to ${host} ended before a response completed, which is neither a name`
      + " that failed to resolve nor a refused port. `curl` to the same URL splits it fastest:"
      + " if curl gets a response, the difference is on the path between this app and that host"
      + " rather than the server — a VPN or proxy intercepting it, a different machine answering"
      + " this name on this network, or HTTP/3, since a host advertising `alt-svc: h3` can be"
      + " retried over UDP 443 and a firewall may drop that while TCP keeps working (compare"
      + " `curl --http2` with `curl --http3`).";
    return isMac
      ? `${base} On macOS 15 and later, the first attempt can also be cut off while macOS asks `
        + "for Local Network permission: enable Haven Office under System Settings → Privacy & "
        + "Security → Local Network, then press Verify again — the attempt that triggers the "
        + "prompt is not retried for you."
      : base;
  }

  // Deliberately not a single cause. A private address that never answers is
  // either off-network or blocked by macOS for this app, the error is
  // identical for both, and the previous wording named only the first — which
  // is the wrong repair for someone already on the LAN.
  const timedOut = names.includes("AbortError") || names.includes("TimeoutError");
  if (timedOut || codes.some((code) => UNROUTABLE_ERROR_CODES.includes(code))) {
    const base = timedOut
      ? `${host} did not answer in time.`
      : `${host} resolved but never answered.`;
    const network =
      " If it resolves to a private address (192.168.x.x, 10.x.x.x) you have to be on the lab"
      + " network or VPN to reach it.";
    return isMac ? `${base}${network} ${LOCAL_NETWORK_PERMISSION_HINT}` : `${base}${network}`;
  }

  return null;
}

export function describeFetchError(
  error: unknown,
  origin: string | undefined,
  platform: string,
  timeoutMs: number,
): string {
  const { messages, codes, names } = unwrapErrorChain(error);

  // The outermost message is the generic wrapper; anything deeper is the real
  // diagnosis, so prefer the deepest one and keep the code alongside it.
  let detail = messages.length > 1 ? messages[messages.length - 1] : messages[0];

  // An aborted probe is our own timeout firing, and "This operation was
  // aborted" describes our implementation rather than what happened to the
  // user. Say the thing that is true of the remote.
  if (names.includes("AbortError") || names.includes("TimeoutError")) {
    detail = `No response within ${Math.round(timeoutMs / 1000)}s.`;
  }

  if (!detail) {
    return "Remote preflight failed.";
  }

  const code = codes.find((candidate) => !detail.includes(candidate));
  const described = code ? `${detail} (${code})` : detail;

  const hint = origin ? describeTransportFailure(codes, names, origin, platform) : null;
  return hint ? `${described} — ${hint}` : described;
}

export function classifyFetchError(error: unknown): TransportFailureReason {
  const { messages, codes } = unwrapErrorChain(error);

  // Checked before anything else: an OS denial is a different repair from
  // every other failure here, and labelling it "Host unreachable" sends the
  // user to look at a network that is working.
  if (codes.some((code) => LOCAL_NETWORK_DENIED_ERROR_CODES.includes(code))) {
    return "blocked_by_os";
  }

  if (
    codes.some(
      (code) =>
        TLS_ERROR_CODES.includes(code) || code.startsWith("ERR_CERT_") || code.startsWith("ERR_SSL_"),
    )
  ) {
    return "tls_error";
  }

  const haystack = messages.join(" ").toLowerCase();
  if (
    haystack.includes("self-signed") ||
    haystack.includes("self signed") ||
    haystack.includes("certificate") ||
    haystack.includes("unable to verify") ||
    haystack.includes("tls") ||
    haystack.includes("ssl")
  ) {
    return "tls_error";
  }

  return "unreachable";
}
