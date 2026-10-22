import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createManualRedirectFetch } = require("../dist/connection/manual-redirect-fetch.js");

/**
 * Stands in for Electron's ClientRequest.
 *
 * The behaviour that matters is the one documented for `redirect: "manual"`:
 * the `redirect` event fires, and because `followRedirect()` is never called
 * the request is cancelled and emits `error` instead of `response`. That is
 * exactly the sequence `session.fetch` cannot turn back into a 3xx Response,
 * which is why this wrapper exists.
 */
class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.ended = false;
    this.aborted = false;
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  abort() {
    this.aborted = true;
  }

  end() {
    this.ended = true;
  }
}

function fakeResponse({ statusCode, statusMessage, headers }) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.statusMessage = statusMessage;
  response.headers = headers ?? {};
  return response;
}

function harness() {
  const requests = [];
  const fetchImpl = createManualRedirectFetch({
    createRequest: (init) => {
      const request = new FakeRequest();
      request.init = init;
      requests.push(request);
      return request;
    },
  });
  return { requests, fetchImpl };
}

test("a normal response becomes a Response with status, headers and body", async () => {
  const { requests, fetchImpl } = harness();

  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health", {
    method: "GET",
    headers: { accept: "application/json" },
  });

  const request = requests[0];
  assert.equal(request.init.url, "https://paperclip.lab.havenco.xyz/api/health");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.redirect, "manual");
  assert.equal(request.headers.accept, "application/json");
  assert.equal(request.ended, true);

  const response = fakeResponse({
    statusCode: 200,
    statusMessage: "OK",
    headers: { "content-type": "application/json" },
  });
  request.emit("response", response);
  response.emit("data", Buffer.from('{"status":'));
  response.emit("data", Buffer.from('"ok"}'));
  response.emit("end");

  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "application/json");
  assert.deepEqual(await result.json(), { status: "ok" });
});

test("a declined redirect resolves as the 3xx the caller asked to see", async () => {
  const { requests, fetchImpl } = harness();

  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health", { method: "GET" });
  const request = requests[0];

  request.emit(
    "redirect",
    302,
    "GET",
    "https://sso.havenco.xyz/login",
    { "content-type": "text/html" },
  );
  // Electron cancels the request once the handler declines to follow.
  request.emit("error", new Error("net::ERR_ABORTED"));

  const result = await pending;
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "https://sso.havenco.xyz/login");
  assert.equal(await result.text(), "");
  // The hop must not have been taken: one request, and we aborted it.
  assert.equal(requests.length, 1);
  assert.equal(request.aborted, true);
});

test("a redirect that ends via abort or close still resolves, not rejects", async () => {
  for (const terminator of ["abort", "close"]) {
    const { requests, fetchImpl } = harness();
    const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");
    const request = requests[0];

    request.emit("redirect", 301, "GET", "https://elsewhere.test/api/health", {});
    request.emit(terminator);

    const result = await pending;
    assert.equal(result.status, 301, `terminator ${terminator}`);
    assert.equal(result.headers.get("location"), "https://elsewhere.test/api/health");
  }
});

test("a genuine transport error rejects with that error", async () => {
  const { requests, fetchImpl } = harness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  requests[0].emit("error", new Error("net::ERR_CERT_AUTHORITY_INVALID"));

  await assert.rejects(pending, /ERR_CERT_AUTHORITY_INVALID/);
});

// The regression the owner reproduced in Electron 41.10.7 on 2026-10-22
// (HAV-44). `ClientRequest` emits `finish` then `close` synchronously the
// instant `end()` is called — on the writable side, before any network
// activity — and the real `response` follows ~250 ms later. The old wrapper
// settled ERR_CONNECTION_CLOSED on that early `close` and discarded the HTTP
// 200 that was already on its way, so every build carrying this wrapper failed
// Verify Remote for every host, identically. The probe must survive the early
// close and resolve with the response.
test("an early synchronous close does not pre-empt the response that follows", async () => {
  const { requests, fetchImpl } = earlyCloseHarness();

  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health", {
    method: "GET",
    headers: { accept: "application/json" },
  });

  const request = requests[0];
  // `end()` has already emitted `finish` + `close` synchronously by now.
  assert.equal(request.ended, true);
  assert.equal(request.closedEarly, true);

  const response = fakeResponse({
    statusCode: 200,
    statusMessage: "OK",
    headers: { "content-type": "application/json" },
  });
  request.emit("response", response);
  response.emit("data", Buffer.from('{"status":"ok"}'));
  response.emit("end");

  const result = await pending;
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: "ok" });
});

// A bare `close` is not a result on its own. When the transaction genuinely
// fails, Electron follows that early close with an `error` carrying a Chromium
// code, and that forwarded error — not a sentence this wrapper invents — is
// what reaches the user and the diagnostics.
test("an early close followed by a real error rejects with that error", async () => {
  const { requests, fetchImpl } = earlyCloseHarness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  requests[0].emit("error", Object.assign(new Error("net::ERR_CONNECTION_REFUSED"), {
    code: "ERR_CONNECTION_REFUSED",
  }));

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "ERR_CONNECTION_REFUSED");
    return true;
  });
});

// The composition the owner check in docs/paperclip-data-layer.md § 4 item 5
// asks about (HAV-68): the Electron-41 ordering *and* a redirecting host. The
// early-close test above ends in a `response`; a declined hop ends in `abort`
// instead, and `redirected` is still unset while the early `close` passes
// through — so this is the one path where ignoring that close has to hold open
// a transaction that never produces a `response` at all. Up to and including
// `v2026.10.14` this rejected ERR_CONNECTION_CLOSED at ~2 ms, before the 3xx
// existed to report, which is why item 5's floor is `v2026.10.15`.
test("an early close does not pre-empt a redirect that arrives later", async () => {
  const { requests, fetchImpl } = earlyCloseHarness();
  const pending = fetchImpl("https://vanity.havenco.xyz/api/health");

  const request = requests[0];
  assert.equal(request.closedEarly, true);

  request.emit("redirect", 302, "GET", "https://paperclip.lab.havenco.xyz/api/health", {});
  // Declining the hop makes Electron cancel the request.
  request.emit("abort");

  const result = await pending;
  assert.equal(result.status, 302);
  assert.equal(
    result.headers.get("location"),
    "https://paperclip.lab.havenco.xyz/api/health",
  );
  assert.equal(request.aborted, true);
});

// "Nothing answered" and "something answered and was cut off" call for
// different repairs, and collapsing them into one sentence hid the fact that
// the host had already been reached.
test("closing mid-body says a response started and names its status", async () => {
  const { requests, fetchImpl } = harness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  const response = fakeResponse({ statusCode: 200, headers: {} });
  requests[0].emit("response", response);
  response.emit("data", Buffer.from('{"status":"o'));
  requests[0].emit("close");

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "ERR_RESPONSE_INCOMPLETE");
    assert.match(error.message, /sent HTTP 200/);
    assert.match(error.message, /before the response body finished/);
    assert.doesNotMatch(error.message, /no HTTP response|ended before any/);
    return true;
  });
});

// A `close` that arrives after the body ended is the documented last event of
// every successful transaction. It must not overwrite the resolved Response.
test("a close after a completed body does not turn success into a failure", async () => {
  const { requests, fetchImpl } = harness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  const response = fakeResponse({ statusCode: 200, headers: {} });
  requests[0].emit("response", response);
  response.emit("data", Buffer.from('{"status":"ok"}'));
  response.emit("end");
  requests[0].emit("close");

  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(await result.text(), '{"status":"ok"}');
});

test("an upstream abort is reported as cancelled, with a code", async () => {
  const { requests, fetchImpl } = harness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  requests[0].emit("abort");

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "ERR_ABORTED");
    assert.match(error.message, /was cancelled/);
    return true;
  });
});

test("an abort signal rejects and cancels the in-flight request", async () => {
  const { requests, fetchImpl } = harness();
  const controller = new AbortController();

  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health", {
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(requests[0].aborted, true);
});

test("an already-aborted signal never opens a request", async () => {
  const { requests, fetchImpl } = harness();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    fetchImpl("https://paperclip.lab.havenco.xyz/api/health", { signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
  assert.equal(requests.length, 0);
});

test("a 204 is built with a null body instead of throwing", async () => {
  const { requests, fetchImpl } = harness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  const response = fakeResponse({ statusCode: 204, headers: {} });
  requests[0].emit("response", response);
  response.emit("end");

  const result = await pending;
  assert.equal(result.status, 204);
  assert.equal(result.body, null);
});

test("an endlessly streaming body is cut off rather than buffered forever", async () => {
  const { requests, fetchImpl } = createBoundedHarness(64);
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  const response = fakeResponse({ statusCode: 200, headers: {} });
  requests[0].emit("response", response);
  response.emit("data", Buffer.alloc(65));

  await assert.rejects(pending, /exceeded 64 bytes/);
  assert.equal(requests[0].aborted, true);
});

test("repeated response headers are joined rather than dropped", async () => {
  const { requests, fetchImpl } = harness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  const response = fakeResponse({
    statusCode: 200,
    headers: { "x-trace": ["a", "b"], "x-empty": undefined },
  });
  requests[0].emit("response", response);
  response.emit("end");

  const result = await pending;
  assert.equal(result.headers.get("x-trace"), "a, b");
  assert.equal(result.headers.get("x-empty"), null);
});

// ---------------------------------------------------------------------------
// The main.log trace (HAV-78)
// ---------------------------------------------------------------------------
//
// The wrapper bug is fixed; these cover the reason it stayed hidden for four
// days. Nothing about Verify Remote reached main.log, so the only evidence
// outside the owner's Mac was a badge reading `ERR_CONNECTION_CLOSED` — which
// this module synthesizes rather than receives. The trace has to state the
// event ordering and the elapsed times, because that ordering is the diagnosis.

test("the trace states the event ordering that explains a failure", async () => {
  const { requests, fetchImpl, lines } = tracingHarness();

  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");
  const response = fakeResponse({ statusCode: 200, headers: {} });
  requests[0].emit("response", response);
  response.emit("data", Buffer.from('{"status":"ok"}'));
  response.emit("end");
  await pending;

  assert.deepEqual(events(lines), [
    "GET paperclip.lab.havenco.xyz/api/health start",
    "response status=200 content-type=<none>",
    "response.end bytes=15",
    "settle resolve status=200 reason=response-end",
  ]);
  // Every line after the first carries its elapsed time; a wall-clock stamp
  // alone cannot separate a 2 ms close from a response 250 ms later.
  for (const line of lines.slice(1)) {
    assert.match(line.message, /\+\d+ms /);
  }
  // One attempt, one id, and the label says which probe spoke.
  const ids = new Set(lines.map((line) => line.message.split(" ")[1]));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^#\d+$/);
  assert.ok(lines.every((line) => line.message.includes(" health ")));
});

// The exact sequence the owner reproduced in Electron 41.10.7 on 2026-10-22.
// Had these five lines existed in main.log, HAV-44 would have been one glance:
// a close with nothing received, then an HTTP 200 that arrives anyway.
test("an ignored early close is named in the trace rather than passed over", async () => {
  const { requests, fetchImpl, lines } = tracingHarness({ earlyClose: true });

  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");
  const response = fakeResponse({
    statusCode: 200,
    headers: { "content-type": "application/json" },
  });
  requests[0].emit("response", response);
  response.emit("data", Buffer.from('{"status":"ok"}'));
  response.emit("end");
  await pending;

  assert.deepEqual(events(lines), [
    "GET paperclip.lab.havenco.xyz/api/health start",
    "close responded=no redirected=no",
    "close ignored reason=nothing-received-yet awaiting=response|error|abort",
    "response status=200 content-type=application/json",
    "response.end bytes=15",
    "settle resolve status=200 reason=response-end",
  ]);
  // A survived close is not trouble, so it must not be logged as trouble.
  assert.deepEqual(lines.filter((line) => line.level === "warn"), []);
});

test("a failure logs Chromium's own code and settles at warn level", async () => {
  const { requests, fetchImpl, lines } = tracingHarness({ earlyClose: true });
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  requests[0].emit("error", Object.assign(new Error("net::ERR_CONNECTION_REFUSED"), {
    code: "ERR_CONNECTION_REFUSED",
  }));
  await assert.rejects(pending);

  assert.deepEqual(events(lines).slice(-2), [
    "error code=ERR_CONNECTION_REFUSED name=Error message=net::ERR_CONNECTION_REFUSED",
    "settle reject reason=transport-error",
  ]);
  assert.deepEqual(
    lines.filter((line) => line.level === "warn").map((line) => event(line)),
    ["settle reject reason=transport-error"],
  );
});

// `code=<none>` is itself the finding: it means `describeFetchError` had nothing
// to key a repair hint off, so the user got a bare sentence. That was the state
// of the probe path until 2026-10-21.
test("an error carrying no code says so instead of looking classified", async () => {
  const { requests, fetchImpl, lines } = tracingHarness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  requests[0].emit("error", new Error("something went wrong"));
  await assert.rejects(pending);

  assert.ok(events(lines).includes("error code=<none> name=Error message=something went wrong"));
});

test("a declined redirect records where it was sent and that it was not followed", async () => {
  const { requests, fetchImpl, lines } = tracingHarness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  requests[0].emit("redirect", 302, "GET", "https://sso.havenco.xyz/login?token=secret", {});
  requests[0].emit("error", new Error("net::ERR_ABORTED"));
  await pending;

  assert.ok(
    events(lines).includes(
      "redirect status=302 location=sso.havenco.xyz/login?<redacted> followed=no",
    ),
  );
  assert.ok(events(lines).includes("settle resolve status=302 reason=captured-redirect"));
});

// main.log is a file the owner pastes into an issue, and the probed URL is
// user-typed and treated as attacker-influenced everywhere else in preflight.
// So: host and path only — no query, no userinfo, no cookies, no other headers.
test("no credential-bearing material reaches the trace", async () => {
  const { requests, fetchImpl, lines } = tracingHarness();

  const pending = fetchImpl(
    "https://alice:hunter2@paperclip.lab.havenco.xyz/api/health?token=sekret#frag",
    { headers: { cookie: "paperclip_session=sekret", authorization: "Bearer sekret" } },
  );
  const response = fakeResponse({
    statusCode: 200,
    headers: { "content-type": "application/json", "set-cookie": "paperclip_session=sekret" },
  });
  requests[0].emit("response", response);
  response.emit("data", Buffer.from('{"token":"sekret"}'));
  response.emit("end");
  await pending;

  const trace = lines.map((line) => line.message).join("\n");
  assert.doesNotMatch(trace, /sekret/);
  assert.doesNotMatch(trace, /hunter2/);
  assert.doesNotMatch(trace, /alice/);
  assert.doesNotMatch(trace, /authorization|set-cookie|cookie/i);
  // The path still identifies which probe this was, and the marker still says a
  // query was present — that much is diagnostic and carries nothing.
  assert.ok(trace.includes("paperclip.lab.havenco.xyz/api/health?<redacted> start"));
});

// A message from the network stack is free text with no promise of being
// URL-free, so it gets scrubbed too — without mangling the `net::ERR_*` codes
// that are the reason to log it at all.
test("a query string embedded in an error message is scrubbed", async () => {
  const { requests, fetchImpl, lines } = tracingHarness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  requests[0].emit(
    "error",
    new Error("failed loading https://paperclip.lab.havenco.xyz/api/health?token=sekret"),
  );
  await assert.rejects(pending);

  const trace = lines.map((line) => line.message).join("\n");
  assert.doesNotMatch(trace, /sekret/);
  assert.ok(trace.includes("message=failed loading https://paperclip.lab.havenco.xyz/api/health?<redacted>"));
});

test("a close after a response started is reported as mid-body, with the status", async () => {
  const { requests, fetchImpl, lines } = tracingHarness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  const response = fakeResponse({ statusCode: 200, headers: {} });
  requests[0].emit("response", response);
  response.emit("data", Buffer.from('{"status":"o'));
  requests[0].emit("close");
  await assert.rejects(pending);

  assert.deepEqual(events(lines).slice(-2), [
    "close responded=HTTP 200 redirected=no",
    "settle reject reason=closed-mid-body status=200 code=ERR_RESPONSE_INCOMPLETE",
  ]);
});

test("a caller timeout is distinguishable from the network refusing", async () => {
  const { requests, fetchImpl, lines } = tracingHarness();
  const controller = new AbortController();

  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending);

  assert.ok(events(lines).includes("settle reject reason=aborted-by-caller"));
  assert.equal(requests[0].aborted, true);
});

test("an already-aborted signal is traced, not silently dropped", async () => {
  const { fetchImpl, lines } = tracingHarness();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    fetchImpl("https://paperclip.lab.havenco.xyz/api/health", { signal: controller.signal }),
    (error) => error.name === "AbortError",
  );

  assert.deepEqual(events(lines), [
    "GET paperclip.lab.havenco.xyz/api/health start",
    "settle reject reason=signal-already-aborted",
  ]);
});

// The transport must stay usable from plain node and from any caller that
// passes no logger — which is every other test in this file.
test("no logger means no logging and no throwing", async () => {
  const { requests, fetchImpl } = harness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  const response = fakeResponse({ statusCode: 200, headers: {} });
  requests[0].emit("response", response);
  response.emit("end");

  assert.equal((await pending).status, 200);
});

/**
 * Captures the trace the way `electron-log` would receive it: one string per
 * line, with the level, since level is how a reader finds a failed attempt in a
 * log that also carries the updater's chatter.
 */
function tracingHarness({ earlyClose = false } = {}) {
  const requests = [];
  const lines = [];
  const record = (level) => (message) => lines.push({ level, message });

  const fetchImpl = createManualRedirectFetch({
    log: { info: record("info"), warn: record("warn") },
    logLabel: "health",
    createRequest: (init) => {
      const request = new FakeRequest();
      request.init = init;
      if (earlyClose) {
        request.end = function end() {
          this.ended = true;
          this.emit("finish");
          this.emit("close");
        };
      }
      requests.push(request);
      return request;
    },
  });

  return { requests, fetchImpl, lines };
}

/** The line with its `[verify-remote] #N label +Nms` preamble removed. */
function event(line) {
  return line.message
    .replace(/^\[verify-remote\] #\d+ \w+ /, "")
    .replace(/^\+\d+ms /, "");
}

function events(lines) {
  return lines.map(event);
}

/**
 * A harness whose `end()` emits `finish` then `close` synchronously, the way
 * Electron 41's ClientRequest does — the behaviour that produced the HAV-44
 * regression. `closedEarly` records that the close fired before any response.
 */
function earlyCloseHarness() {
  const requests = [];
  const fetchImpl = createManualRedirectFetch({
    createRequest: (init) => {
      const request = new FakeRequest();
      request.init = init;
      request.closedEarly = false;
      request.end = function end() {
        this.ended = true;
        this.emit("finish");
        this.closedEarly = true;
        this.emit("close");
      };
      requests.push(request);
      return request;
    },
  });
  return { requests, fetchImpl };
}

function createBoundedHarness(maxBodyBytes) {
  const requests = [];
  const fetchImpl = createManualRedirectFetch({
    maxBodyBytes,
    createRequest: (init) => {
      const request = new FakeRequest();
      request.init = init;
      requests.push(request);
      return request;
    },
  });
  return { requests, fetchImpl };
}
