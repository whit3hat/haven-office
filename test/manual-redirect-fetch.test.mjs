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

test("closing before any response rejects rather than hanging", async () => {
  const { requests, fetchImpl } = harness();
  const pending = fetchImpl("https://paperclip.lab.havenco.xyz/api/health");

  requests[0].emit("close");

  await assert.rejects(pending, /closed before a response arrived/);
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
