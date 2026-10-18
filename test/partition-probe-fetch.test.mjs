import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createPartitionProbeFetch,
  withSessionCookies,
} = require("../dist/connection/partition-probe-fetch.js");

/**
 * The defect this file exists for (HAV-45) was not in preflight's logic — it
 * was in the request options main.ts handed Electron. `credentials` was unset,
 * so the probe sent no cookies, every `/api/auth/get-session` came back 401,
 * and a signed-in user was reported `signed_out`.
 *
 * test/connection-preflight.test.mjs cannot catch that: it injects its own
 * `fetch`. So the transport itself is asserted here instead — both the option
 * and the explicit `Cookie` header, because the header is the half that is
 * provable off a Mac.
 */

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.ended = false;
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  abort() {}

  end() {
    this.ended = true;
  }
}

function respondJson(request, { status = 200, body = {} } = {}) {
  const response = new EventEmitter();
  response.statusCode = status;
  response.statusMessage = "OK";
  response.headers = { "content-type": "application/json" };
  request.emit("response", response);
  response.emit("data", Buffer.from(JSON.stringify(body)));
  response.emit("end");
}

function probeHarness({ cookies, readCookies } = {}) {
  const requests = [];
  const seen = [];
  const session = { partition: "persist:paperclip-remote-test" };

  const probeFetch = createPartitionProbeFetch({
    session,
    createRequest: (init) => {
      const request = new FakeRequest();
      request.init = init;
      requests.push(request);
      setImmediate(() => respondJson(request, { body: { session: { id: "paperclip:1" } } }));
      return request;
    },
    readCookies:
      readCookies ??
      (async (url) => {
        seen.push(url);
        return cookies ?? [];
      }),
  });

  return { probeFetch, requests, seen, session };
}

test("the probe asks Electron for the session's cookies", async () => {
  const { probeFetch, requests, session } = probeHarness();

  await probeFetch("https://paperclip.example.com/api/auth/get-session");

  assert.equal(requests.length, 1);
  // Without `credentials: "include"` the request carries no cookies at all,
  // whatever session it is given. This assertion is the regression guard.
  assert.equal(requests[0].init.credentials, "include");
  assert.equal(requests[0].init.session, session);
  assert.equal(requests[0].init.redirect, "manual");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.url, "https://paperclip.example.com/api/auth/get-session");
});

test("the probe sends the partition's jar as an explicit Cookie header", async () => {
  const { probeFetch, requests, seen } = probeHarness({
    cookies: [
      { name: "__Secure-paperclip-abc.session_token", value: "tok" },
      { name: "paperclip-abc.company", value: "HAV" },
    ],
  });

  const response = await probeFetch("https://paperclip.example.com/api/auth/get-session", {
    headers: { accept: "application/json" },
  });

  assert.equal(response.status, 200);
  // The jar is read for the probed origin only, never a path or host the
  // caller did not ask for.
  assert.deepEqual(seen, ["https://paperclip.example.com"]);
  assert.equal(
    requests[0].headers.cookie,
    "__Secure-paperclip-abc.session_token=tok; paperclip-abc.company=HAV",
  );
  assert.equal(requests[0].headers.accept, "application/json");
});

test("an empty jar sends no Cookie header", async () => {
  const { probeFetch, requests } = probeHarness({ cookies: [] });

  await probeFetch("https://paperclip.example.com/api/health");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.cookie, undefined);
});

test("a jar that cannot be read still issues the probe", async () => {
  // Signed out must stay distinguishable from unreachable: an unreadable jar
  // means no cookies, not a failed request.
  const { probeFetch, requests } = probeHarness({
    readCookies: async () => {
      throw new Error("partition is gone");
    },
  });

  const response = await probeFetch("https://paperclip.example.com/api/health");

  assert.equal(response.status, 200);
  assert.equal(requests[0].headers.cookie, undefined);
});

test("a cookie-bearing probe still reports a declined redirect as a 3xx", async () => {
  // The cookies must not cost us the manual-redirect behaviour preflight
  // depends on: a gateway that redirects /api/health has to stay reportable as
  // "that host redirected us, and here is where to", not an unreachable host.
  const requests = [];
  const probeFetch = createPartitionProbeFetch({
    session: {},
    createRequest: (init) => {
      const request = new FakeRequest();
      request.init = init;
      requests.push(request);
      setImmediate(() => {
        request.emit("redirect", 302, "GET", "https://sso.example.com/login", {});
        request.emit("error", new Error("net::ERR_ABORTED"));
      });
      return request;
    },
    readCookies: async () => [{ name: "paperclip-abc.session_token", value: "tok" }],
  });

  const response = await probeFetch("https://paperclip.example.com/api/health");

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://sso.example.com/login");
  assert.equal(requests[0].init.credentials, "include");
  assert.equal(requests[0].headers.cookie, "paperclip-abc.session_token=tok");
});

test("withSessionCookies leaves a caller's own Cookie header alone", async () => {
  const calls = [];
  const wrapped = withSessionCookies(
    async (input, init) => {
      calls.push(new Headers(init.headers).get("cookie"));
      return new Response(null, { status: 204 });
    },
    async () => [{ name: "jar", value: "value" }],
  );

  await wrapped("https://paperclip.example.com/api/health", {
    headers: { cookie: "explicit=1" },
  });
  await wrapped(new URL("https://paperclip.example.com/api/health"));

  assert.deepEqual(calls, ["explicit=1", "jar=value"]);
});

test("a non-URL input is not fatal", async () => {
  let called = false;
  const wrapped = withSessionCookies(
    async () => {
      called = true;
      return new Response(null, { status: 204 });
    },
    async () => {
      throw new Error("should not be consulted for a URL we cannot parse");
    },
  );

  const response = await wrapped("not-a-url");

  assert.equal(called, true);
  assert.equal(response.status, 204);
});
