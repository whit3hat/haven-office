/**
 * A typed Paperclip REST client for the Electron main process.
 *
 * Three rules shape this file:
 *
 * 1. **No Electron import.** It takes a `fetch` and an `AuthStrategy`. That is
 *    what lets the whole thing be tested with recorded fixtures and no server,
 *    and what makes it reusable by any future Haven tool.
 * 2. **Nothing throws.** Every method resolves to a `PaperclipResult`. See
 *    `result.ts` for why the surface needs the reason as a field.
 * 3. **Only verified endpoints.** Each method below corresponds to a route this
 *    project has actually called. Adding one means verifying it first.
 */

import { authFailure, type AuthStrategy } from "./auth";
import {
  failure,
  reasonForStatus,
  success,
  type PaperclipResult,
} from "./result";
import { classifyFetchError, describeFetchError, fetchWithTimeout } from "./transport";
import type {
  ActivityEntry,
  AgentCost,
  AgentIdentity,
  AttentionFeed,
  AttentionQuery,
  BudgetsOverview,
  DashboardSummary,
  DismissalRequest,
  HeartbeatRun,
  InboxDismissal,
  LiveRun,
} from "./types";

export interface PaperclipClientOptions {
  /** Origin only — `https://host[:port]`, no path. */
  origin: string;
  companyId: string;
  auth: AuthStrategy;
  /**
   * Transport. In the app this is the session-backed fetch from
   * `electron.ts`; in tests it is a fixture function.
   */
  fetchImpl?: typeof fetch;
  /**
   * 8s matches remote preflight. It is long enough for a cold lab server and
   * short enough that a tray poll cannot pile up behind a dead host.
   */
  timeoutMs?: number;
  /** Only used to phrase a transport failure; injectable so the macOS branch is testable. */
  platform?: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export interface PaperclipClient {
  readonly origin: string;
  readonly companyId: string;
  readonly authKind: AuthStrategy["kind"];

  getAttention(query?: AttentionQuery): Promise<PaperclipResult<AttentionFeed>>;
  listInboxDismissals(): Promise<PaperclipResult<InboxDismissal[]>>;
  createInboxDismissal(request: DismissalRequest): Promise<PaperclipResult<InboxDismissal>>;
  deleteInboxDismissal(itemKey: string): Promise<PaperclipResult<null>>;

  getMe(): Promise<PaperclipResult<AgentIdentity>>;
  getDashboard(): Promise<PaperclipResult<DashboardSummary>>;
  getLiveRuns(): Promise<PaperclipResult<LiveRun[]>>;
  getHeartbeatRuns(): Promise<PaperclipResult<HeartbeatRun[]>>;
  getCostsByAgent(): Promise<PaperclipResult<AgentCost[]>>;
  getBudgetsOverview(): Promise<PaperclipResult<BudgetsOverview>>;
  getActivity(limit?: number): Promise<PaperclipResult<ActivityEntry[]>>;
}

export function createPaperclipClient(options: PaperclipClientOptions): PaperclipClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  const origin = options.origin.replace(/\/+$/, "");
  const company = encodeURIComponent(options.companyId);

  async function request<T>(
    path: string,
    init?: { method?: string; body?: unknown; expectNoContent?: boolean },
  ): Promise<PaperclipResult<T>> {
    let url: URL;
    try {
      url = new URL(path, `${origin}/`);
    } catch {
      return failure("bad_response", `"${origin}" is not a usable Paperclip origin.`);
    }

    const decision = await options.auth.authorize(url);
    if (!decision.ok) {
      return authFailure(decision);
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      ...decision.headers,
    };
    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(fetchImpl, url, timeoutMs, {
        method: init?.method ?? "GET",
        headers,
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        // The API never redirects, and following one with the session cookie
        // attached would hand the credential to wherever the redirect points.
        // Treat a redirect as a failure rather than a hop.
        redirect: "error",
      });
    } catch (error) {
      return failure(
        classifyFetchError(error),
        describeFetchError(error, origin, platform, timeoutMs),
      );
    }

    if (response.status >= 400) {
      return failure(
        reasonForStatus(response.status),
        await describeErrorResponse(response, url),
        response.status,
      );
    }

    if (init?.expectNoContent || response.status === 204) {
      return success(null as T, response.status);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      // A reachable host answering HTML on an API path is a proxy, a captive
      // portal or a sign-in page — never the Paperclip API. Saying "bad
      // response" keeps the blame off the server.
      const seen = contentType ? `"${contentType}"` : "no content-type";
      return failure(
        "bad_response",
        `${url.pathname} answered with ${seen} rather than JSON. Something between this app and `
        + "Paperclip is answering for it.",
        response.status,
      );
    }

    try {
      return success((await response.json()) as T, response.status);
    } catch (error) {
      return failure(
        "bad_response",
        `${url.pathname} returned unreadable JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        response.status,
      );
    }
  }

  return {
    origin,
    companyId: options.companyId,
    authKind: options.auth.kind,

    getAttention(query) {
      return request<AttentionFeed>(`/api/companies/${company}/attention${attentionSearch(query)}`);
    },

    listInboxDismissals() {
      return request<InboxDismissal[]>(`/api/companies/${company}/inbox-dismissals`);
    },

    createInboxDismissal(dismissal) {
      return request<InboxDismissal>(`/api/companies/${company}/inbox-dismissals`, {
        method: "POST",
        body: dismissal,
      });
    },

    deleteInboxDismissal(itemKey) {
      return request<null>(
        `/api/companies/${company}/inbox-dismissals/${encodeURIComponent(itemKey)}`,
        { method: "DELETE", expectNoContent: true },
      );
    },

    getMe() {
      return request<AgentIdentity>("/api/agents/me");
    },

    getDashboard() {
      return request<DashboardSummary>(`/api/companies/${company}/dashboard`);
    },

    getLiveRuns() {
      return request<LiveRun[]>(`/api/companies/${company}/live-runs`);
    },

    getHeartbeatRuns() {
      return request<HeartbeatRun[]>(`/api/companies/${company}/heartbeat-runs`);
    },

    getCostsByAgent() {
      return request<AgentCost[]>(`/api/companies/${company}/costs/by-agent`);
    },

    getBudgetsOverview() {
      return request<BudgetsOverview>(`/api/companies/${company}/budgets/overview`);
    },

    getActivity(limit) {
      const search = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
      return request<ActivityEntry[]>(`/api/companies/${company}/activity${search}`);
    },
  };
}

/**
 * Build the attention query string.
 *
 * The booleans are serialized as the literal strings "true"/"false" because
 * that is what the route parses — it compares `req.query.includeDismissed ===
 * "true"` — and an omitted parameter is not the same as `false` to a reader of
 * the server logs.
 */
function attentionSearch(query: AttentionQuery | undefined): string {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  if (query.queue) params.set("queue", query.queue);
  if (query.sort) params.set("sort", query.sort);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.activitySince) params.set("activitySince", query.activitySince);
  if (query.activityUntil) params.set("activityUntil", query.activityUntil);
  if (query.includeDismissed !== undefined) {
    params.set("includeDismissed", query.includeDismissed ? "true" : "false");
  }
  if (query.archived !== undefined) params.set("archived", query.archived ? "true" : "false");
  if (query.all !== undefined) params.set("all", query.all ? "true" : "false");

  const search = params.toString();
  return search ? `?${search}` : "";
}

/**
 * Prefer the server's own `{"error": "..."}` message.
 *
 * Paperclip's are specific and worth showing verbatim — "Board access
 * required" tells the user something real, where "HTTP 403" does not.
 */
async function describeErrorResponse(response: Response, url: URL): Promise<string> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        typeof (body as { error?: unknown }).error === "string"
      ) {
        return `${(body as { error: string }).error} (HTTP ${response.status})`;
      }
    }
  } catch {
    // Fall through to the generic description below.
  }
  return `${url.pathname} returned HTTP ${response.status}.`;
}
