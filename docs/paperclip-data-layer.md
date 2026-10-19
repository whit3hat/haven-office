# The Paperclip data layer (`src/paperclip/`)

How Haven Office reads a Paperclip server from the Electron main process: which
auth strategy won and why, the real shape of the attention payload, and what is
still unverified.

Written for [HAV-42](https://github.com/whit3hat/haven-office) (Phase 2, P1).
Verified against `https://paperclip.lab.havenco.xyz` running
`@paperclipai/server` `2026.1001.0` on 18 October 2026.

## 1. Which auth strategy won

**The session cookie.** The board API key is implemented as a fallback behind
the same interface, but nothing requires it today.

### Why it had to be one of those two

The endpoints this app exists to surface are board-scoped. The route handler
for the attention feed is explicit about it:

```js
// @paperclipai/server/dist/routes/attention.js
assertCompanyAccess(req, companyId);
assertBoard(req);
if (!req.actor.userId) {
  res.status(403).json({ error: "Board user context required" });
  return;
}
```

Confirmed by request, not by reading. With an **agent** API key:

```
GET /api/companies/{id}/attention        -> 403 {"error":"Board access required"}
GET /api/companies/{id}/inbox-dismissals -> 403 {"error":"Board authentication required"}
```

So the app must act as **the signed-in user**, never as an agent. Two ways to
hold a board identity:

| Strategy | What the user has to do | Works for `/attention`? |
| --- | --- | --- |
| Chromium session cookie | Nothing — they already sign in inside the window | Yes |
| Board API key in the Keychain | Create a key, paste it once | Yes |
| Agent API key | — | **No**, 403 |

The board key genuinely works, for a non-obvious reason worth recording: the
auth middleware resolves a board key to a user, so it satisfies the same
`req.actor.userId` check a session does.

```js
// @paperclipai/server/dist/middleware/auth.js
const boardKey = await boardAuth.findBoardApiKeyByToken(token);
if (boardKey) { … req.actor = { type: "board", userId: boardKey.userId, … } }
```

An agent key never will — different actor type. That is the whole finding.

### The detail cookie reuse actually turns on

Reusing the cookie works, but **not** the way the obvious wiring suggests, and
this is the thing that would have cost a run:

> Passing a `session` to Electron's network stack does not send that session's
> cookies.

From Electron 41.10.7's own `ClientRequestConstructorOptions` declarations
(`node_modules/electron/electron.d.ts`):

- `credentials` — "If this option is not specified, authentication data from
  the session will be sent, and **cookies will not be sent** (unless
  `useSessionCookies` is set)."
- `useSessionCookies` — "Whether to send cookies with this request from the
  provided session. … **Default is `false`**."

A request issued over the correct partition with default options is therefore
*unauthenticated*, and the server answers `401`. That is indistinguishable from
"the user is signed out", and acting on it would have sent us to build the
API-key fallback for no reason at all.

`src/paperclip/electron.ts` handles it two ways, deliberately:

1. The transport passes `credentials: "include"`, so Chromium attaches the
   partition's jar. This is the documented mechanism.
2. `sessionCookieStrategy` *also* sends an explicit `Cookie` header read via
   `ses.cookies.get({ url })`. This is the path the tests exercise, because it
   is transport-independent — what the suite proves is what ships.

`cookies.get` in the main process returns `httpOnly` cookies, which is
essential: the Paperclip session cookie is `httpOnly`, so nothing in a renderer
could ever read it. This is a main-process-only capability.

Remote preflight had the identical defect, found while writing this section and
fixed the same two ways in HAV-45. Its probe was
`electronNet.request({ …, session })` with no `credentials`, so every
`/api/auth/get-session` answered `401` and a signed-in user was reported
`signed_out` — which opened the server root instead of their remembered view.
That transport now lives in `src/connection/partition-probe-fetch.ts`, which
supplies both the option and the explicit header. `test/partition-probe-fetch.test.mjs`
asserts the *request options* rather than injecting a `fetch` over them: the
defect was in the options, so a test that replaces the whole transport —
`test/connection-preflight.test.mjs` does — cannot see it in either direction.

### Do not hardcode the cookie name

Paperclip configures better-auth with a per-instance prefix:

```js
// @paperclipai/server/dist/auth/better-auth.js
return `paperclip-${scopedInstanceId}`;
```

So the cookie is `paperclip-<instanceId>.session_token`, and `instanceId`
differs per server; on an `https` origin better-auth additionally applies the
`__Secure-` prefix. A literal name would work against the lab server and fail
silently against the next one. `isSessionCookie()` matches the shape instead,
and the whole jar for the origin is sent rather than a hand-picked subset.

### Status of this finding

Honest limits, because they matter for whoever builds P2:

- The server-side requirements, the 403s and the Electron option semantics are
  **verified** — by live request, by reading the shipped server code, and from
  the shipped Electron type declarations respectively.
- The cookie round trip has now been executed on a Mac **at the preflight
  layer** (HAV-45, 2026-10-18): a signed-in partition preflighted as
  `signed_in` and the window opened on the remembered view. So the mechanism —
  `credentials: "include"` plus a `Cookie` header read from the partition jar —
  is confirmed against real Chromium, not just against the type declarations.
- The same round trip through `PaperclipClient.getMe()` has **not** been
  executed on a Mac. The build container this was written in has no GUI
  libraries, so the Electron binary cannot start at all:
  `error while loading shared libraries: libglib-2.0.so.0`. Everything that
  does not need Electron was verified by running it; that one step could not
  be. It uses the same transport shape, so the preflight result is strong
  evidence for it but not a substitute.
- What remains to confirm, in ten minutes on the owner's Mac, is in §4.

### Where the fallback credential lives

Never in `connections.json` — `ConnectionStore` writes that as plaintext JSON
under `userData`. `BoardKeyStore` keeps a separate `board-credentials.json`
holding nothing but `safeStorage` ciphertext (the macOS Keychain), mode `0600`,
keyed per connection profile so two remotes cannot read each other's key. If
`safeStorage.isEncryptionAvailable()` is false the store **refuses to save**
rather than writing a key in the clear.

## 2. The attention payload

`GET /api/companies/{companyId}/attention` — "List decision-only attention feed
items". Query parameters (`queue`, `sort=activity|decide`, `cursor`, `limit`,
`activitySince`, `activityUntil`, `includeDismissed`, `archived`, `all`); the
booleans are compared against the literal string `"true"` by the route, which is
why the client serializes them that way.

**`/api/openapi.json` documents the 200 response as
`{"type": "object", "additionalProperties": {}}` — i.e. nothing.** The shape
below is transcribed from the server's own shipped type declarations,
`@paperclipai/shared/dist/types/attention.d.ts` at the version the lab server
runs.

```ts
interface AttentionFeed {
  companyId: string;
  generatedAt: string;
  totalCount: number;
  deskBadgeCount: number;      // items new today or past decide-by
  nextCursor: string | null;
  countsBySourceKind: Record<AttentionSourceKind, number>;
  items: AttentionItem[];
}
```

The fields that matter for a menu-bar surface, and why:

| Field | Why P2 needs it |
| --- | --- |
| `deskBadgeCount` | The badge number. Computed **before** pagination, so a 5-item page still carries a company-wide count. Use this, not `items.length`. |
| `dedupKey` | Stable identity across polls. **Notification dedupe must key on this, not `id`** — the server may re-emit the same decision under a new row id, and keying on `id` notifies twice. |
| `dismissalKey` | What `POST /inbox-dismissals` expects. The server validates it against `/^(approval\|join\|run\|attention):.+$/` and rejects anything else. |
| `dismissal` | `{ kind, dismissedAt, snoozedUntil, isActive }`. `isActive` goes false when a snooze elapses. **Never notify for an item with an active dismissal.** |
| `subject.href` | Server-rendered company-prefixed path, e.g. `/HAV/issues/HAV-42`. Navigate with this rather than composing a path from `kind` + `id`. |
| `whyNow` | One server-written sentence on why a human is needed. Menu copy, free. |
| `decisionVerbs` + `inlineResolvable` | Whether the item can be resolved without opening the window, and the verb labels. |
| `severity`, `rank`, `decideBy` | Ordering and urgency. `sort=decide` orders by `decideBy`. |

`AttentionSourceKind` is one of `approval`, `decision`,
`issue_thread_interaction`, `join_request`, `recovery_action`,
`productivity_review`, `blocker_attention`, `review`, `failed_run`,
`budget_alert`, `agent_error_alert`.

`src/paperclip/types.ts` narrows this to the fields above. Two things from the
server type are deliberately **not** modelled, to be added when a surface needs
them: `detail` (a twelve-member discriminated union of per-kind excerpts and
images) and `resolverAudience` (who may resolve an interaction — present only
on `issue_thread_interaction` rows).

### Dismissal companions

```
GET    /api/companies/{id}/inbox-dismissals            -> InboxDismissal[]
POST   /api/companies/{id}/inbox-dismissals            -> 201 InboxDismissal
DELETE /api/companies/{id}/inbox-dismissals/{itemKey}   -> 204
```

`POST` takes `{ itemKey, kind: "dismiss" | "snooze", snoozedUntil? }`. The
server enforces that a dismissal has no `snoozedUntil`, that a snooze has one,
and that it is in the future.

## 3. Using it

```ts
import { createElectronPaperclipClient } from "./paperclip/electron";
import { watch } from "./paperclip";

const client = createElectronPaperclipClient({
  origin: connection.allowedOrigin,
  companyId,
  partition: connection.partition,   // the window's own session partition
  profileId: connection.profileId,
  userDataPath: app.getPath("userData"),
});

const handle = watch({
  poll: () => client.getAttention({ sort: "decide", limit: 20 }),
  onChange: (result) => {
    if (!result.ok) {
      tray.showDegraded(result.reason, result.detail);  // never a stale count
      return;
    }
    tray.render(result.data);
  },
  isFocused: () => BrowserWindow.getFocusedWindow() !== null,
  hasListeners: () => !tray.isDestroyed(),
});
```

Runnable example: `node scripts/paperclip-attention.mjs --url <origin>
--company <id>`, with `PAPERCLIP_BOARD_COOKIE` or `PAPERCLIP_BOARD_API_KEY` in
the environment. It runs on plain Node — no Electron, no display — which is
itself the demonstration that the client has no renderer dependency.

### Failure reasons a surface must distinguish

`signed_out` · `forbidden` · `no_credential` · `blocked_by_os` · `tls_error` ·
`unreachable` · `bad_response` · `not_found` · `rate_limited` · `server_error`

`isActionableFailure(reason)` marks the ones that are the entire message rather
than poll noise. `blocked_by_os` is the Phase 1 failure — `curl` worked, the
app said "host unreachable" — and it stays diagnosable because the client
shares `src/paperclip/transport.ts` with `src/connection/preflight.ts` instead
of copying it.

### Polling cost

`WATCH_INTERVALS`, one table, each number commented with its reason: 15s
focused-and-changing, 60s focused-and-static, 5min unfocused, 30s→15min
exponential on error, 2min on `429`. Unfocused is the one that matters on a
shared host: roughly 290 requests a day instead of 5,700.

## 4. What still needs checking on a Mac

None of this blocks P2 — the `AuthStrategy` seam means a surprise costs a
strategy swap, not a redesign. But it should be confirmed before a release:

1. **The cookie round trip.** With the window signed in to a remote, call
   `client.getMe()` from the main process and confirm it returns 200 rather
   than 401. A 401 means the cookie is not being attached; check
   `credentials: "include"` on the transport and that `cookies.get` returned
   the `session_token`.
2. **The real attention payload.** Record `GET /attention` with a board session
   and re-record `test/fixtures/attention-feed.json` from it. That fixture is
   structurally authoritative (field names and types come from the server's own
   compiler) but its *values* are plausible rather than observed, and
   `countsBySourceKind` in particular should be checked for whether absent
   kinds are omitted or present as `0`.
3. **`safeStorage` on a real Keychain.** Only needed if the fallback is ever
   used.
4. ~~**Preflight's session probe (HAV-45).**~~ **Confirmed on the owner's Mac,
   2026-10-18.** Connecting to a remote the owner was already signed in to
   opened on the remembered view, not the server root — so the probe's cookies
   reach Chromium and `preflightRemoteConnection` returns `signed_in`. The
   cookie round trip in item 1 is the same mechanism one layer up, and this is
   the first real-Chromium evidence for it.
5. **The redirect interaction (HAV-47).** The half of HAV-45's Mac plan that
   the signed-in connect does not exercise: point Verify Remote at a host that
   redirects `/api/health` and confirm it still reports the redirect target,
   not an unreachable host. That is the one interaction between
   `credentials: "include"` and the deliberate `redirect: "manual"` handling in
   `src/connection/manual-redirect-fetch.ts` that only Chromium can settle.
   `test/partition-probe-fetch.test.mjs` asserts our half (a cookie-bearing
   probe still resolves a declined redirect as a 3xx with its `Location`).
   Bundle it into HAV-47's Verify Remote pass, which touches the same handler.
6. **Verify Remote on a saved profile (HAV-47).** Sign in to a saved remote,
   reopen the launcher, and press **Verify Remote** on that URL. It should
   report an active session, not "sign-in required". The fix resolves the
   saved profile from the typed URL's origin so both the probe and the window
   read the same partition; a Mac is what proves the partition it now picks is
   the one Chromium actually stored the cookie in.
   `test/window-policy.test.mjs` asserts the selection itself.

## 5. Module layout

| File | Contents |
| --- | --- |
| `transport.ts` | Fetch-with-timeout and the error classification, shared with `src/connection/preflight.ts`. The single owner of `blocked_by_os`. |
| `result.ts` | `PaperclipResult`, the failure reasons, `isActionableFailure`. |
| `auth.ts` | `AuthStrategy` plus the cookie and board-key implementations. No Electron. |
| `board-key-store.ts` | `safeStorage`-encrypted fallback credential. Injected `SafeStorageLike`, so testable with no keychain. |
| `types.ts` | Hand-written response types, with per-type provenance. |
| `client.ts` | `createPaperclipClient`. Takes a `fetch`; nothing throws. |
| `watch.ts` | Adaptive polling. |
| `electron.ts` | **The only file that imports `electron`.** Session partition → cookie reader + transport + keychain. |
| `index.ts` | Public surface. Deliberately does not re-export `./electron`. |

Tests: `test/paperclip-client.test.mjs`, `test/paperclip-watch.test.mjs`
(`pnpm test:paperclip`). Fixtures and their scrubbing:
`test/fixtures/README.md`. No test touches a live server.
