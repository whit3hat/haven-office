import { normalizeRemoteUrl } from "./validate";
import type {
  BootstrapStatus,
  DeploymentExposure,
  DeploymentMode,
  RemotePreflightResult,
  SessionState,
} from "./types";

interface PreflightOptions {
  remoteUrl: string;
  fetchImpl?: typeof fetch;
  localServerVersion?: string | null;
  timeoutMs?: number;
}

interface HealthPayload {
  status?: unknown;
  version?: unknown;
  deploymentMode?: unknown;
  deploymentExposure?: unknown;
  authReady?: unknown;
  bootstrapStatus?: unknown;
  bootstrapInviteActive?: unknown;
}

interface ParsedHealthPayload {
  status: string;
  version: string | null;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure | null;
  authReady: boolean | null;
  bootstrapStatus: BootstrapStatus | null;
  bootstrapInviteActive: boolean | null;
}

export async function preflightRemoteConnection(options: PreflightOptions): Promise<RemotePreflightResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;

  let normalized;
  try {
    normalized = normalizeRemoteUrl(options.remoteUrl);
  } catch (error) {
    return buildFailure({
      remoteUrl: options.remoteUrl,
      insecureTransport: false,
      reason: "invalid_url",
      detail: error instanceof Error ? error.message : "Enter a valid remote URL.",
    });
  }

  try {
    const healthResponse = await fetchJson(fetchImpl, new URL("/api/health", normalized.origin), timeoutMs);
    const health = healthResponse.status === 200 ? parseHealthPayload(healthResponse.body) : null;

    if (!health) {
      return buildFailure({
        remoteUrl: normalized.normalizedUrl,
        normalizedUrl: normalized.normalizedUrl,
        origin: normalized.origin,
        insecureTransport: normalized.insecureTransport,
        reason: "not_paperclip",
        detail: describeUnusableHealthResponse(healthResponse, normalized.origin),
        warning: normalized.warning,
      });
    }

    if (health.status !== "ok") {
      return {
        ok: false,
        normalizedUrl: normalized.normalizedUrl,
        origin: normalized.origin,
        insecureTransport: normalized.insecureTransport,
        paperclipDetected: true,
        deploymentMode: health.deploymentMode,
        deploymentExposure: health.deploymentExposure,
        authReady: health.authReady,
        bootstrapStatus: health.bootstrapStatus,
        bootstrapInviteActive: health.bootstrapInviteActive,
        sessionState: "unknown",
        version: health.version,
        reason: "unreachable",
        detail: "Paperclip responded, but the instance is not healthy yet.",
        warning: buildVersionWarning(health.version, options.localServerVersion, normalized.warning),
      };
    }

    if (health.deploymentMode === "local_trusted") {
      return {
        ok: false,
        normalizedUrl: normalized.normalizedUrl,
        origin: normalized.origin,
        insecureTransport: normalized.insecureTransport,
        paperclipDetected: true,
        deploymentMode: health.deploymentMode,
        deploymentExposure: health.deploymentExposure,
        authReady: health.authReady,
        bootstrapStatus: health.bootstrapStatus,
        bootstrapInviteActive: health.bootstrapInviteActive,
        sessionState: "unknown",
        version: health.version,
        reason: "unsupported_local_trusted",
        detail:
          "This Paperclip server is configured for loopback-only local use. Reconfigure it to upstream authenticated mode before using Haven Office remote mode.",
        warning: buildVersionWarning(health.version, options.localServerVersion, normalized.warning),
      };
    }

    if (health.deploymentMode !== "authenticated") {
      return {
        ok: false,
        normalizedUrl: normalized.normalizedUrl,
        origin: normalized.origin,
        insecureTransport: normalized.insecureTransport,
        paperclipDetected: true,
        deploymentMode: health.deploymentMode,
        deploymentExposure: health.deploymentExposure,
        authReady: health.authReady,
        bootstrapStatus: health.bootstrapStatus,
        bootstrapInviteActive: health.bootstrapInviteActive,
        sessionState: "unknown",
        version: health.version,
        reason: "not_paperclip",
        detail: "The remote did not report an authenticated Paperclip deployment.",
        warning: buildVersionWarning(health.version, options.localServerVersion, normalized.warning),
      };
    }

    if (health.authReady === false) {
      return {
        ok: false,
        normalizedUrl: normalized.normalizedUrl,
        origin: normalized.origin,
        insecureTransport: normalized.insecureTransport,
        paperclipDetected: true,
        deploymentMode: health.deploymentMode,
        deploymentExposure: health.deploymentExposure,
        authReady: health.authReady,
        bootstrapStatus: health.bootstrapStatus,
        bootstrapInviteActive: health.bootstrapInviteActive,
        sessionState: "unknown",
        version: health.version,
        reason: "auth_not_ready",
        detail: "The remote reports authenticated mode, but its auth subsystem is not ready.",
        warning: buildVersionWarning(health.version, options.localServerVersion, normalized.warning),
      };
    }

    const sessionResponse = await fetchSession(fetchImpl, new URL("/api/auth/get-session", normalized.origin), timeoutMs);
    if (sessionResponse.sessionState === "unknown") {
      return {
        ok: false,
        normalizedUrl: normalized.normalizedUrl,
        origin: normalized.origin,
        insecureTransport: normalized.insecureTransport,
        paperclipDetected: true,
        deploymentMode: health.deploymentMode,
        deploymentExposure: health.deploymentExposure,
        authReady: health.authReady,
        bootstrapStatus: health.bootstrapStatus,
        bootstrapInviteActive: health.bootstrapInviteActive,
        sessionState: "unknown",
        version: health.version,
        reason: "not_paperclip",
        detail: "The remote session probe returned an unexpected response.",
        warning: buildVersionWarning(health.version, options.localServerVersion, normalized.warning),
      };
    }

    return {
      ok: true,
      normalizedUrl: normalized.normalizedUrl,
      origin: normalized.origin,
      insecureTransport: normalized.insecureTransport,
      paperclipDetected: true,
      deploymentMode: health.deploymentMode,
      deploymentExposure: health.deploymentExposure,
      authReady: health.authReady,
      bootstrapStatus: health.bootstrapStatus,
      bootstrapInviteActive: health.bootstrapInviteActive,
      sessionState: sessionResponse.sessionState,
      version: health.version,
      warning: buildVersionWarning(health.version, options.localServerVersion, normalized.warning),
    };
  } catch (error) {
    return buildFailure({
      remoteUrl: normalized.normalizedUrl,
      normalizedUrl: normalized.normalizedUrl,
      origin: normalized.origin,
      insecureTransport: normalized.insecureTransport,
      reason: classifyFetchError(error),
      detail: describeFetchError(error),
      warning: normalized.warning,
    });
  }
}

interface HealthProbeResponse {
  status: number;
  body: unknown;
  contentType: string;
  location: string | null;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
): Promise<HealthProbeResponse> {
  const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
  const contentType = response.headers.get("content-type") ?? "";
  const location = response.headers.get("location");

  if (!contentType.toLowerCase().includes("application/json")) {
    return { status: response.status, body: null, contentType, location };
  }

  return {
    status: response.status,
    body: await response.json(),
    contentType,
    location,
  };
}

/**
 * Explain why a health probe did not yield a usable payload.
 *
 * The old single sentence said "does not appear to expose the Paperclip health
 * endpoint" for every shape of miss, which is actively misleading for the two
 * most common real causes: a reverse proxy or SSO gateway redirecting the
 * probe, and a host that answers but with HTML. We deliberately do not follow
 * redirects here (see fetchWithTimeout), so a 3xx is a result to report, not a
 * hop to take.
 */
function describeUnusableHealthResponse(response: HealthProbeResponse, origin: string): string {
  if (response.status >= 300 && response.status < 400) {
    const target = response.location ? ` to ${response.location}` : "";
    return (
      `${origin}/api/health redirected (HTTP ${response.status})${target}. `
      + "Haven Office does not follow redirects while verifying a remote, so point the "
      + "connection at the Paperclip origin itself rather than a gateway or vanity URL."
    );
  }

  if (response.status !== 200) {
    return `${origin}/api/health returned HTTP ${response.status}, not a Paperclip health payload.`;
  }

  if (!response.contentType.toLowerCase().includes("application/json")) {
    const seen = response.contentType ? `"${response.contentType}"` : "no content-type";
    return (
      `${origin}/api/health answered with ${seen} rather than JSON. `
      + "This host is reachable but does not look like a Paperclip server."
    );
  }

  return `${origin}/api/health returned JSON that is not a recognizable Paperclip health payload.`;
}

async function fetchSession(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
): Promise<{ sessionState: SessionState }> {
  const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { sessionState: "unknown" };
  }

  const body = await response.json();

  if (response.status === 401) {
    return isPaperclipAuthRequiredPayload(body)
      ? { sessionState: "signed_out" }
      : { sessionState: "unknown" };
  }

  if (response.status !== 200) {
    return { sessionState: "unknown" };
  }

  if (isPaperclipSessionPayload(body)) {
    return { sessionState: "signed_in" };
  }

  return { sessionState: "unknown" };
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseHealthPayload(body: unknown): ParsedHealthPayload | null {
  if (!isObject(body)) {
    return null;
  }

  const deploymentMode =
    body.deploymentMode === "authenticated" || body.deploymentMode === "local_trusted"
      ? body.deploymentMode
      : null;
  const deploymentExposure =
    body.deploymentExposure === "private" || body.deploymentExposure === "public"
      ? body.deploymentExposure
      : null;
  const authReady = typeof body.authReady === "boolean" ? body.authReady : null;
  const bootstrapStatus =
    body.bootstrapStatus === "ready" || body.bootstrapStatus === "bootstrap_pending"
      ? body.bootstrapStatus
      : null;
  const bootstrapInviteActive =
    typeof body.bootstrapInviteActive === "boolean" ? body.bootstrapInviteActive : null;
  const status = typeof body.status === "string" ? body.status : null;
  const version = typeof body.version === "string" ? body.version : null;
  const hasFullHealthShape = deploymentExposure !== null && authReady !== null;
  const hasRedactedAuthenticatedShape =
    status === "ok" &&
    deploymentMode === "authenticated" &&
    bootstrapStatus !== null &&
    bootstrapInviteActive !== null &&
    authReady === null;

  if (!status || !deploymentMode || (!hasFullHealthShape && !hasRedactedAuthenticatedShape)) {
    return null;
  }

  return {
    status,
    version,
    deploymentMode,
    deploymentExposure,
    authReady,
    bootstrapStatus,
    bootstrapInviteActive,
  };
}

function isPaperclipAuthRequiredPayload(body: unknown): boolean {
  return isObject(body) && body.error === "Board authentication required";
}

function isPaperclipSessionPayload(body: unknown): boolean {
  if (!isObject(body) || !isObject(body.session)) {
    return false;
  }

  return (
    typeof body.session.id === "string" &&
    body.session.id.startsWith("paperclip:") &&
    typeof body.session.userId === "string" &&
    body.session.userId.length > 0
  );
}

function buildFailure(input: {
  remoteUrl: string;
  normalizedUrl?: string;
  origin?: string;
  insecureTransport?: boolean;
  reason: RemotePreflightResult["reason"];
  detail: string;
  warning?: string;
}): RemotePreflightResult {
  return {
    ok: false,
    normalizedUrl: input.normalizedUrl ?? input.remoteUrl.trim(),
    origin: input.origin ?? "",
    insecureTransport: input.insecureTransport === true,
    paperclipDetected: false,
    deploymentMode: null,
    deploymentExposure: null,
    authReady: null,
    bootstrapStatus: null,
    bootstrapInviteActive: null,
    sessionState: "unknown",
    version: null,
    reason: input.reason,
    detail: input.detail,
    warning: input.warning,
  };
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
function unwrapErrorChain(error: unknown): { messages: string[]; codes: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
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

  return { messages, codes };
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

function describeFetchError(error: unknown): string {
  const { messages, codes } = unwrapErrorChain(error);

  // The outermost message is the generic wrapper; anything deeper is the real
  // diagnosis, so prefer the deepest one and keep the code alongside it.
  const detail = messages.length > 1 ? messages[messages.length - 1] : messages[0];
  if (!detail) {
    return "Remote preflight failed.";
  }

  const code = codes.find((candidate) => !detail.includes(candidate));
  return code ? `${detail} (${code})` : detail;
}

function classifyFetchError(error: unknown): RemotePreflightResult["reason"] {
  const { messages, codes } = unwrapErrorChain(error);

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

function buildVersionWarning(
  remoteVersion: string | null,
  localServerVersion: string | null | undefined,
  existingWarning?: string,
): string | undefined {
  const warnings = [existingWarning].filter(Boolean) as string[];

  if (remoteVersion && localServerVersion && remoteVersion !== localServerVersion) {
    warnings.push(
      `Remote Paperclip version ${remoteVersion} differs from the bundled desktop server version ${localServerVersion}.`,
    );
  }

  return warnings.length > 0 ? warnings.join(" ") : undefined;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
