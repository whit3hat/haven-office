import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createPaperclipClient } = require("../dist/paperclip/client.js");
const {
  boardApiKeyStrategy,
  firstAvailableStrategy,
  isSessionCookie,
  serializeCookies,
  sessionCookieStrategy,
} = require("../dist/paperclip/auth.js");
const { isActionableFailure, reasonForStatus } = require("../dist/paperclip/result.js");
const { BoardKeyStore } = require("../dist/paperclip/board-key-store.js");

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

const ORIGIN = "https://paperclip.lab.havenco.xyz";
const COMPANY = "00000000-0000-4000-8000-000000000002";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A signed-in user: the jar holds the server's own cookie name shape. */
function signedInCookies() {
  return sessionCookieStrategy(async () => [
    { name: "__Secure-paperclip-lab.session_token", value: "SESSION-VALUE" },
    { name: "paperclip-lab.company", value: COMPANY },
  ]);
}

const signedOutCookies = sessionCookieStrategy(async () => []);

/**
 * Record what the client sent so the tests can assert on the request, not just
 * the parsed result. Auth is the whole point of this module; a test that only
 * checks the response body would pass with no credential attached at all.
 */
function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const headers = new Headers(init?.headers ?? {});
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: init?.body ?? null,
      redirect: init?.redirect,
    });
    return handler(String(url), init, calls.length - 1);
  };
  return { impl, calls };
}

function client(fetchImpl, auth = signedInCookies(), extra = {}) {
  return createPaperclipClient({
    origin: ORIGIN,
    companyId: COMPANY,
    auth,
    fetchImpl,
    platform: "darwin",
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Auth — the question Phase 2 existed to settle
// ---------------------------------------------------------------------------

test("the session cookie strategy sends the signed-in user's cookies", async () => {
  const { impl, calls } = recordingFetch(() => jsonResponse(fixture("attention-feed")));
  const result = await client(impl).getAttention();

  assert.equal(result.ok, true);
  assert.equal(
    calls[0].headers.cookie,
    "__Secure-paperclip-lab.session_token=SESSION-VALUE; paperclip-lab.company=" + COMPANY,
  );
  // No Authorization header: the app acts as the user, never as an agent.
  assert.equal(calls[0].headers.authorization, undefined);
});

test("a session cookie is recognised by shape, not by a hardcoded name", () => {
  // Paperclip sets `cookiePrefix: paperclip-{instanceId}`, so the name differs
  // per server; on https better-auth also adds the __Secure- prefix.
  assert.equal(isSessionCookie("paperclip-default.session_token"), true);
  assert.equal(isSessionCookie("paperclip-lab-havenco.session_token"), true);
  assert.equal(isSessionCookie("__Secure-paperclip-whatever.session_token"), true);
  assert.equal(isSessionCookie("__Host-paperclip-x.session_token"), true);
  assert.equal(isSessionCookie("paperclip-default.csrf_token"), false);
  assert.equal(isSessionCookie("session_token_backup"), false);
});

test("no session cookie reports signed_out without spending a request", async () => {
  const { impl, calls } = recordingFetch(() => {
    throw new Error("the client must not make a request with no credential");
  });

  const result = await client(impl, signedOutCookies).getAttention();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "signed_out");
  assert.match(result.detail, /Open the window and sign in/);
  assert.equal(calls.length, 0);
});

test("the board API key fallback authenticates as a bearer token", async () => {
  const { impl, calls } = recordingFetch(() => jsonResponse(fixture("attention-feed")));
  const auth = boardApiKeyStrategy(async () => "board-key-123");

  const result = await client(impl, auth).getAttention();

  assert.equal(result.ok, true);
  assert.equal(calls[0].headers.authorization, "Bearer board-key-123");
  assert.equal(calls[0].headers.cookie, undefined);
});

test("the cookie strategy wins when a session exists, and the key is never read", async () => {
  const { impl, calls } = recordingFetch(() => jsonResponse(fixture("dashboard")));
  let keyReads = 0;
  const auth = firstAvailableStrategy([
    signedInCookies(),
    boardApiKeyStrategy(async () => {
      keyReads += 1;
      return "board-key-123";
    }),
  ]);

  const result = await client(impl, auth).getDashboard();

  assert.equal(result.ok, true);
  assert.ok(calls[0].headers.cookie);
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(keyReads, 0);
});

test("with no session the fallback key is used instead", async () => {
  const { impl, calls } = recordingFetch(() => jsonResponse(fixture("dashboard")));
  const auth = firstAvailableStrategy([
    signedOutCookies,
    boardApiKeyStrategy(async () => "board-key-123"),
  ]);

  const result = await client(impl, auth).getDashboard();

  assert.equal(result.ok, true);
  assert.equal(calls[0].headers.authorization, "Bearer board-key-123");
});

test("with neither credential the last failure is reported, not a generic one", async () => {
  const auth = firstAvailableStrategy([
    signedOutCookies,
    boardApiKeyStrategy(async () => null),
  ]);

  const result = await client(async () => jsonResponse({}), auth).getDashboard();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_credential");
  assert.match(result.detail, /No board API key stored/);
});

test("serializeCookies builds a Cookie header the way a browser would", () => {
  assert.equal(
    serializeCookies([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]),
    "a=1; b=2",
  );
  assert.equal(serializeCookies([]), "");
});

// ---------------------------------------------------------------------------
// The attention feed — what P2 is built against
// ---------------------------------------------------------------------------

test("the attention feed parses into the fields the surface needs", async () => {
  const result = await client(async () => jsonResponse(fixture("attention-feed"))).getAttention();

  assert.equal(result.ok, true);
  const feed = result.data;
  assert.equal(feed.totalCount, 3);
  // The badge is computed server-side before pagination, so a short page still
  // carries a company-wide number.
  assert.equal(feed.deskBadgeCount, 2);
  assert.equal(feed.nextCursor, null);
  assert.equal(feed.items.length, 3);

  const [first] = feed.items;
  assert.equal(first.sourceKind, "issue_thread_interaction");
  assert.equal(first.whyNow, "Pepper is waiting on a decision before Rhodey can start P2.");
  assert.equal(first.inlineResolvable, true);
  assert.deepEqual(
    first.decisionVerbs.map((verb) => verb.id),
    ["accept", "reject"],
  );
  // Click-through uses the server's own href rather than composing a path.
  assert.equal(first.subject.href, "/HAV/issues/HAV-32");
  assert.equal(first.relatedIssue.identifier, "HAV-32");
  assert.equal(feed.countsBySourceKind.approval, 1);
});

test("dedupe keys are stable identity, and dismissal keys are what the API wants", async () => {
  const result = await client(async () => jsonResponse(fixture("attention-feed"))).getAttention();
  const items = result.data.items;

  // Notification dedupe must key on dedupKey, not id — the server may re-emit
  // the same decision under a new row id.
  assert.equal(new Set(items.map((item) => item.dedupKey)).size, items.length);
  // POST /inbox-dismissals rejects anything not matching this prefix set.
  for (const item of items) {
    assert.match(item.dismissalKey, /^(approval|join|run|attention):/);
  }

  const snoozed = items.find((item) => item.dismissal !== null);
  assert.equal(snoozed.dismissal.kind, "snooze");
  assert.equal(snoozed.dismissal.isActive, true);
  assert.equal(snoozed.snoozedUntil, "2026-10-19T10:00:00.000Z");
});

test("attention query parameters are serialized the way the route parses them", async () => {
  const { impl, calls } = recordingFetch(() => jsonResponse(fixture("attention-feed")));

  await client(impl).getAttention({
    queue: "decide",
    sort: "decide",
    limit: 25,
    includeDismissed: false,
    activitySince: "2026-10-18T00:00:00.000Z",
  });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, `/api/companies/${COMPANY}/attention`);
  assert.equal(url.searchParams.get("queue"), "decide");
  assert.equal(url.searchParams.get("sort"), "decide");
  assert.equal(url.searchParams.get("limit"), "25");
  // The route compares against the literal string "true", so booleans must not
  // be sent as 0/1 or omitted-means-false.
  assert.equal(url.searchParams.get("includeDismissed"), "false");
  assert.equal(url.searchParams.get("activitySince"), "2026-10-18T00:00:00.000Z");
});

test("no query means no query string at all", async () => {
  const { impl, calls } = recordingFetch(() => jsonResponse(fixture("attention-feed")));
  await client(impl).getAttention();
  assert.equal(calls[0].url, `${ORIGIN}/api/companies/${COMPANY}/attention`);
});

test("dismissing an item posts the itemKey the feed handed us", async () => {
  const { impl, calls } = recordingFetch(() =>
    jsonResponse(
      {
        id: "00000000-0000-4000-8000-000000000201",
        companyId: COMPANY,
        userId: "scrubbed-id-001",
        itemKey: "attention:00000000-0000-4000-8000-000000000101",
        kind: "dismiss",
        dismissedAt: "2026-10-18T22:10:00.000Z",
        snoozedUntil: null,
      },
      201,
    ),
  );

  const result = await client(impl).createInboxDismissal({
    itemKey: "attention:00000000-0000-4000-8000-000000000101",
    kind: "dismiss",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].body), {
    itemKey: "attention:00000000-0000-4000-8000-000000000101",
    kind: "dismiss",
  });
});

test("restoring a dismissal url-encodes the item key and tolerates 204", async () => {
  const { impl, calls } = recordingFetch(() => new Response(null, { status: 204 }));

  const result = await client(impl).deleteInboxDismissal("attention:abc/def");

  assert.equal(result.ok, true);
  assert.equal(result.data, null);
  assert.equal(calls[0].method, "DELETE");
  // The colon and slash in an item key must not become path segments.
  assert.equal(
    calls[0].url,
    `${ORIGIN}/api/companies/${COMPANY}/inbox-dismissals/attention%3Aabc%2Fdef`,
  );
});

// ---------------------------------------------------------------------------
// Failures are data
// ---------------------------------------------------------------------------

test("the real 403 an agent key gets is reported as forbidden, not signed out", async () => {
  // This is the recorded response that decided the auth model. 403 must not be
  // collapsed into 401: "sign in" is the wrong instruction for a credential
  // that is simply the wrong kind.
  const result = await client(async () => jsonResponse(fixture("attention-403"), 403)).getAttention();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "forbidden");
  assert.equal(result.status, 403);
  assert.equal(result.detail, "Board access required (HTTP 403)");
  assert.equal(isActionableFailure(result.reason), true);
});

test("an expired session is reported as signed_out with the server's own words", async () => {
  const result = await client(async () =>
    jsonResponse({ error: "Board authentication required" }, 401),
  ).getAttention();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "signed_out");
  assert.equal(result.detail, "Board authentication required (HTTP 401)");
});

test("statuses map to the reasons the surface renders differently", () => {
  assert.equal(reasonForStatus(401), "signed_out");
  assert.equal(reasonForStatus(403), "forbidden");
  assert.equal(reasonForStatus(404), "not_found");
  assert.equal(reasonForStatus(429), "rate_limited");
  assert.equal(reasonForStatus(500), "server_error");
  assert.equal(reasonForStatus(502), "server_error");
});

test("an OS network denial stays diagnosable through the client", async () => {
  // The Phase 1 failure: curl worked, the app said "host unreachable". The
  // client must reach the same conclusion preflight does, because it shares
  // the classifier rather than copying it.
  const denied = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("network access denied"), {
      code: "ERR_NETWORK_ACCESS_DENIED",
    }),
  });

  const result = await client(async () => {
    throw denied;
  }).getAttention();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "blocked_by_os");
  assert.match(result.detail, /Privacy & Security → Local Network/);
  assert.equal(isActionableFailure(result.reason), true);
});

test("a TLS rejection is not reported as an unreachable host", async () => {
  const tls = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
  });

  const result = await client(async () => {
    throw tls;
  }).getDashboard();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "tls_error");
  assert.match(result.detail, /certificate has expired/);
});

test("a dead host is unreachable, and says what to check", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });

  const result = await client(async () => {
    throw refused;
  }).getDashboard();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
  assert.match(result.detail, /nothing is listening on port 443/);
});

test("HTML on an API path blames the proxy, not Paperclip", async () => {
  const result = await client(
    async () =>
      new Response("<html><body>Sign in to the Wi-Fi</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  ).getAttention();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad_response");
  assert.match(result.detail, /Something between this app and Paperclip/);
});

test("unreadable JSON on a 200 is a bad response, not a crash", async () => {
  const result = await client(
    async () =>
      new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
  ).getAttention();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad_response");
});

test("a timeout resolves with a reason instead of hanging or throwing", async () => {
  const result = await client(
    (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
    signedInCookies(),
    { timeoutMs: 20 },
  ).getAttention();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
  assert.match(result.detail, /No response within/);
});

test("the client refuses to follow a redirect while holding the session cookie", async () => {
  const { impl, calls } = recordingFetch(() => jsonResponse(fixture("dashboard")));
  await client(impl).getDashboard();
  // Following a redirect would hand the cookie to wherever it points.
  assert.equal(calls[0].redirect, "error");
});

// ---------------------------------------------------------------------------
// The remaining verified endpoints
// ---------------------------------------------------------------------------

test("each verified endpoint hits its real path and parses its recorded response", async () => {
  const cases = [
    ["getMe", "agents-me", "/api/agents/me"],
    ["getDashboard", "dashboard", `/api/companies/${COMPANY}/dashboard`],
    ["getLiveRuns", "live-runs", `/api/companies/${COMPANY}/live-runs`],
    ["getHeartbeatRuns", "heartbeat-runs", `/api/companies/${COMPANY}/heartbeat-runs`],
    ["getCostsByAgent", "costs-by-agent", `/api/companies/${COMPANY}/costs/by-agent`],
    ["getBudgetsOverview", "budgets-overview", `/api/companies/${COMPANY}/budgets/overview`],
    ["getActivity", "activity", `/api/companies/${COMPANY}/activity`],
  ];

  for (const [method, fixtureName, expectedPath] of cases) {
    const { impl, calls } = recordingFetch(() => jsonResponse(fixture(fixtureName)));
    const result = await client(impl)[method]();

    assert.equal(result.ok, true, `${method} should succeed`);
    assert.equal(new URL(calls[0].url).pathname, expectedPath, `${method} path`);
    assert.deepEqual(result.data, fixture(fixtureName), `${method} payload`);
  }
});

test("the narrowed types line up with the recorded payloads", async () => {
  const dashboard = (await client(async () => jsonResponse(fixture("dashboard")))
    .getDashboard()).data;
  assert.equal(typeof dashboard.agents.running, "number");
  assert.equal(typeof dashboard.tasks.blocked, "number");
  assert.equal(typeof dashboard.costs.monthUtilizationPercent, "number");
  assert.equal(typeof dashboard.pendingApprovals, "number");

  const me = (await client(async () => jsonResponse(fixture("agents-me"))).getMe()).data;
  assert.equal(me.name, "Friday");
  assert.equal(typeof me.companyId, "string");

  const runs = (await client(async () => jsonResponse(fixture("live-runs"))).getLiveRuns()).data;
  assert.ok(Array.isArray(runs));
  assert.equal(typeof runs[0].agentName, "string");
});

test("getActivity passes a limit when asked for one", async () => {
  const { impl, calls } = recordingFetch(() => jsonResponse(fixture("activity")));
  await client(impl).getActivity(3);
  assert.equal(new URL(calls[0].url).searchParams.get("limit"), "3");
});

test("the client reports which strategy is in play without exposing the credential", async () => {
  const cookieClient = client(async () => jsonResponse({}), signedInCookies());
  const keyClient = client(async () => jsonResponse({}), boardApiKeyStrategy(async () => "k"));

  assert.equal(cookieClient.authKind, "session_cookie");
  assert.equal(keyClient.authKind, "board_api_key");
  // P2 may render the distinction; it must never be able to read the secret.
  assert.equal(JSON.stringify(cookieClient).includes("SESSION-VALUE"), false);
});

// ---------------------------------------------------------------------------
// The fallback credential never lands in plaintext
// ---------------------------------------------------------------------------

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    // Stand-in for the Keychain: reversible, and obviously not the plaintext.
    encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) {
        throw new Error("not decryptable by this keychain");
      }
      return text.slice(4);
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(process.env.PAPERCLIP_TMPDIR ?? "/tmp", "board-keys-"));
}

test("a board API key round-trips and is never written in plaintext", async () => {
  const directory = tempDir();
  const store = new BoardKeyStore({ directory, safeStorage: fakeSafeStorage() });

  await store.save("profile-1", "super-secret-board-key");
  assert.equal(await store.load("profile-1"), "super-secret-board-key");

  const onDisk = fs.readFileSync(store.getFilePath(), "utf8");
  assert.equal(onDisk.includes("super-secret-board-key"), false);
  // And it is its own file — never connections.json, which is plaintext JSON.
  assert.equal(path.basename(store.getFilePath()), "board-credentials.json");
  assert.equal(fs.existsSync(path.join(directory, "connections.json")), false);
});

test("keys are scoped per connection profile", async () => {
  const store = new BoardKeyStore({ directory: tempDir(), safeStorage: fakeSafeStorage() });

  await store.save("profile-1", "key-one");
  await store.save("profile-2", "key-two");

  assert.equal(await store.load("profile-1"), "key-one");
  assert.equal(await store.load("profile-2"), "key-two");
  assert.equal(await store.load("profile-3"), null);
});

test("without OS encryption the key is refused, not written in the clear", async () => {
  const store = new BoardKeyStore({ directory: tempDir(), safeStorage: fakeSafeStorage(false) });

  await assert.rejects(() => store.save("profile-1", "key"), /Refusing to store/);
  assert.equal(fs.existsSync(store.getFilePath()), false);
});

test("a key the keychain can no longer decrypt is dropped rather than failing forever", async () => {
  const directory = tempDir();
  const store = new BoardKeyStore({ directory, safeStorage: fakeSafeStorage() });
  await store.save("profile-1", "key-one");

  // A different OS user, or a keychain reset: the ciphertext is now garbage.
  const stranded = new BoardKeyStore({
    directory,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: () => {
        throw new Error("cannot decrypt");
      },
    },
  });

  assert.equal(await stranded.load("profile-1"), null);
  // Dropped, so the next save is clean rather than shadowed by dead ciphertext.
  assert.equal(await store.load("profile-1"), null);
});

test("clearing a key removes it", async () => {
  const store = new BoardKeyStore({ directory: tempDir(), safeStorage: fakeSafeStorage() });
  await store.save("profile-1", "key-one");
  await store.clear("profile-1");
  assert.equal(await store.load("profile-1"), null);
  // Clearing something absent is not an error.
  await store.clear("profile-nope");
});

test("a corrupt credentials file does not take the app down", async () => {
  const directory = tempDir();
  fs.writeFileSync(path.join(directory, "board-credentials.json"), "{ this is not json");
  const store = new BoardKeyStore({ directory, safeStorage: fakeSafeStorage() });

  assert.equal(await store.load("profile-1"), null);
  await store.save("profile-1", "key-one");
  assert.equal(await store.load("profile-1"), "key-one");
});
