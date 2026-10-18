# Paperclip API fixtures

Replay inputs for `test/paperclip-client.test.mjs`. **No test here touches a
live server** — the suite injects a `fetch` that serves these files.

## Provenance

| Fixture | Source |
| --- | --- |
| `agents-me.json` | Recorded `HTTP 200` from `GET /api/agents/me` |
| `dashboard.json` | Recorded `HTTP 200` from `GET /api/companies/{id}/dashboard` |
| `live-runs.json` | Recorded `HTTP 200`, truncated to 2 rows |
| `heartbeat-runs.json` | Recorded `HTTP 200`, truncated to 2 rows |
| `costs-by-agent.json` | Recorded `HTTP 200`, truncated to 2 rows |
| `budgets-overview.json` | Recorded `HTTP 200` |
| `activity.json` | Recorded `HTTP 200`, truncated to 3 rows |
| `attention-403.json` | Recorded `HTTP 403` body, verbatim |
| `inbox-dismissals-403.json` | Recorded `HTTP 403` body, verbatim |
| `attention-feed.json` | **Synthesized** — see below |

Recordings are from `https://paperclip.lab.havenco.xyz` on 18 October 2026,
server `@paperclipai/server` `2026.1001.0`, using an agent API key.

### Why `attention-feed.json` is synthesized

An agent key cannot read the attention feed. Both of these are recorded, real
responses and they are the reason this app authenticates as the signed-in user
rather than as an agent:

```
GET /api/companies/{id}/attention          -> 403 {"error":"Board access required"}
GET /api/companies/{id}/inbox-dismissals   -> 403 {"error":"Board authentication required"}
```

`/api/openapi.json` documents the 200 response for that route as only
`{"type": "object", "additionalProperties": {}}`, so the spec is no help
either. The fixture was therefore written by hand against the server's own
shipped type declarations — `AttentionFeed` and `AttentionItem` in
`@paperclipai/shared/dist/types/attention.d.ts` at the exact version the lab
server runs.

That makes it structurally authoritative but **not** response-verified: field
*names* and *types* come from the server's compiler, while the *values* are
plausible rather than observed. It covers an interaction awaiting a decision,
a pending approval, and a snoozed failed run. See
`docs/paperclip-data-layer.md` for what should be re-recorded once someone can
run the app with a real board session.

## Scrubbing

The recorded fixtures are passed through a scrub that replaces:

- every UUID with a sequential `00000000-0000-4000-8000-0000000000NN` placeholder
- every email address with `someone@example.invalid`
- every hex string of 32+ characters with zeros
- every long mixed-case opaque identifier (better-auth user ids, key handles)
  with `scrubbed-id-NNN`

and drops `adapterConfig`, `runtimeConfig`, `details` and `usageJson` entirely —
`adapterConfig` carries secret *references* and the others are large and
unread. Agent display names and role text are kept: they are not secret and
they make a failing assertion legible.
