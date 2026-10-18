/**
 * Hand-written response types, narrow on purpose.
 *
 * `/api/openapi.json` describes 728 paths, and generating all of them would
 * give us thousands of lines nobody reads and a compile error every time the
 * server adds a field. These types cover the fields Haven Office actually
 * reads and nothing else.
 *
 * Provenance, because it differs per type and matters when one of these is
 * wrong:
 *
 * - Everything except `AttentionFeed` and `InboxDismissal` is narrowed from a
 *   **recorded HTTP 200** off `https://paperclip.lab.havenco.xyz` (18 Oct
 *   2026); the fixtures in `test/fixtures/` are those responses, scrubbed.
 * - `AttentionFeed`, `AttentionItem` and `InboxDismissal` are transcribed from
 *   the **server's own shipped type declarations** —
 *   `@paperclipai/shared/dist/types/attention.d.ts` at `2026.1001.0`, the
 *   version this repo pins and the lab server runs. An agent key gets
 *   `403 Board access required` on `/attention`, so these could not be taken
 *   from a live response; the OpenAPI schema for the route is only
 *   `{type: object, additionalProperties: {}}` and documents nothing. See
 *   `docs/paperclip-data-layer.md` for what still needs confirming against a
 *   real board session.
 */

// ---------------------------------------------------------------------------
// Attention feed — the reason this module exists
// ---------------------------------------------------------------------------

export type AttentionSourceKind =
  | "approval"
  | "decision"
  | "issue_thread_interaction"
  | "join_request"
  | "recovery_action"
  | "productivity_review"
  | "blocker_attention"
  | "review"
  | "failed_run"
  | "budget_alert"
  | "agent_error_alert";

export type AttentionSubjectKind =
  | "approval"
  | "decision"
  | "issue"
  | "interaction"
  | "join_request"
  | "recovery_action"
  | "run"
  | "budget_incident"
  | "agent";

export type AttentionSeverity = "critical" | "high" | "medium" | "low";

export type AttentionSortMode = "activity" | "decide";

export interface AttentionSubject {
  kind: AttentionSubjectKind;
  id: string;
  companyId: string;
  title: string | null;
  identifier: string | null;
  status: string | null;
  /**
   * Server-rendered, company-prefixed path such as `/HAV/issues/HAV-42`. The
   * surface navigates with this rather than composing a URL from `kind` and
   * `id` — the server already knows the routing, and duplicating it is how a
   * click lands on a 404 after a route change.
   */
  href: string | null;
}

export interface AttentionDecisionVerb {
  id: string;
  label: string;
  description: string | null;
}

export interface AttentionQueueRef {
  key: string;
  title: string;
}

export interface AttentionProjectRef {
  id: string;
  name: string;
  urlKey: string;
}

export type InboxDismissalKind = "dismiss" | "snooze";

export interface AttentionItemDismissal {
  kind: InboxDismissalKind;
  dismissedAt: string;
  snoozedUntil: string | null;
  /** False once a snooze has elapsed, so the item is live again. */
  isActive: boolean;
}

export interface AttentionItem {
  id: string;
  companyId: string;
  sourceKind: AttentionSourceKind;
  subject: AttentionSubject;
  /** One sentence from the server on why this needs a human now. */
  whyNow: string;
  decisionVerbs: AttentionDecisionVerb[];
  inlineResolvable: boolean;
  /**
   * Stable identity across polls. This — not `id` — is what notification
   * dedupe has to key on: the server may re-emit an item with a new row id for
   * the same underlying decision, and keying on `id` would notify twice.
   */
  dedupKey: string;
  /** The key `POST /inbox-dismissals` expects: `(approval|join|run|attention):…`. */
  dismissalKey: string;
  dismissal: AttentionItemDismissal | null;
  severity: AttentionSeverity;
  rank: number;
  activityAt: string;
  createdAt: string;
  updatedAt: string;
  relatedIssue: AttentionSubject | null;
  project: AttentionProjectRef | null;
  queues: AttentionQueueRef[];
  expiresAt: string | null;
  /** Explicit deadline, when the item has one. Drives `sort=decide`. */
  decideBy: string | null;
  snoozedUntil: string | null;
  originAgentName: string | null;
}

export interface AttentionFeed {
  companyId: string;
  generatedAt: string;
  totalCount: number;
  /**
   * The server's own badge number: items new today or past their decide-by.
   * Computed before pagination, so a 5-item page still carries a company-wide
   * count — which is exactly what a menu-bar badge needs.
   */
  deskBadgeCount: number;
  nextCursor: string | null;
  countsBySourceKind: Partial<Record<AttentionSourceKind, number>>;
  items: AttentionItem[];
}

export interface AttentionQuery {
  queue?: string;
  sort?: AttentionSortMode;
  cursor?: string;
  limit?: number;
  activitySince?: string;
  activityUntil?: string;
  includeDismissed?: boolean;
  archived?: boolean;
  /** One unpaginated snapshot. Fine for a tray; do not use for a long feed. */
  all?: boolean;
}

export interface InboxDismissal {
  id: string;
  companyId: string;
  userId: string;
  itemKey: string;
  kind: InboxDismissalKind;
  dismissedAt: string;
  snoozedUntil: string | null;
}

export interface DismissalRequest {
  itemKey: string;
  kind?: InboxDismissalKind;
  /** Required when `kind` is `snooze`, and the server rejects a past time. */
  snoozedUntil?: string;
}

// ---------------------------------------------------------------------------
// Identity and summary endpoints — narrowed from recorded 200s
// ---------------------------------------------------------------------------

export interface AgentIdentity {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
}

export interface DashboardSummary {
  companyId: string;
  agents: { active: number; running: number; paused: number; error: number };
  tasks: { open: number; inProgress: number; blocked: number; done: number };
  costs: { monthSpendCents: number; monthBudgetCents: number; monthUtilizationPercent: number };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
}

export interface LiveRun {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface HeartbeatRun {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  exitCode: number | null;
}

export interface AgentCost {
  agentId: string;
  agentName: string;
  agentStatus: string;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
}

export interface BudgetsOverview {
  companyId: string;
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount: number;
  activeIncidents: unknown[];
  policies: unknown[];
}

export interface ActivityEntry {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  agentId: string | null;
  runId: string | null;
  createdAt: string;
}
