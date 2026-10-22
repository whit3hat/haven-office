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
