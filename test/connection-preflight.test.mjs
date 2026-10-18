import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { preflightRemoteConnection } = require("../dist/connection/preflight.js");

test("preflight accepts authenticated Paperclip with active session", async () => {
  const responses = [
    jsonResponse(
      {
        status: "ok",
        version: "2026.403.0",
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
      },
      200,
    ),
    jsonResponse(
      {
        session: { id: "paperclip:session:1", userId: "user-1" },
        user: { id: "user-1" },
      },
      200,
    ),
  ];

  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip-host.tailnet.ts.net",
    localServerVersion: "2026.403.0",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.insecureTransport, false);
  assert.equal(result.sessionState, "signed_in");
  assert.equal(result.deploymentMode, "authenticated");
  assert.equal(result.bootstrapStatus, "ready");
});

test("preflight treats 401 session probe as sign-in required", async () => {
  const responses = [
    jsonResponse(
      {
        status: "ok",
        version: "2026.403.0",
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        bootstrapStatus: "bootstrap_pending",
        bootstrapInviteActive: false,
      },
      200,
    ),
    authRequiredResponse(),
  ];

  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip-host.tailnet.ts.net",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.insecureTransport, false);
  assert.equal(result.sessionState, "signed_out");
  assert.equal(result.bootstrapStatus, "bootstrap_pending");
});

test("preflight accepts redacted authenticated health with Paperclip auth-required session response", async () => {
  const responses = [
    jsonResponse(
      {
        status: "ok",
        deploymentMode: "authenticated",
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
      },
      200,
    ),
    authRequiredResponse(),
  ];

  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip-host.tailnet.ts.net",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionState, "signed_out");
  assert.equal(result.deploymentMode, "authenticated");
  assert.equal(result.deploymentExposure, null);
  assert.equal(result.authReady, null);
  assert.equal(result.bootstrapStatus, "ready");
  assert.equal(result.bootstrapInviteActive, false);
});

test("preflight accepts redacted authenticated health with active Paperclip session", async () => {
  const responses = [
    jsonResponse(
      {
        status: "ok",
        deploymentMode: "authenticated",
        bootstrapStatus: "bootstrap_pending",
        bootstrapInviteActive: true,
      },
      200,
    ),
    jsonResponse(
      {
        session: { id: "paperclip:session:user-1", userId: "user-1" },
        user: { id: "user-1" },
      },
      200,
    ),
  ];

  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip-host.tailnet.ts.net/some/path?ignored=true#hash",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.normalizedUrl, "https://paperclip-host.tailnet.ts.net/");
  assert.equal(result.sessionState, "signed_in");
  assert.equal(result.bootstrapStatus, "bootstrap_pending");
  assert.equal(result.bootstrapInviteActive, true);
});

test("preflight accepts redacted authenticated health when deploymentExposure is present without authReady", async () => {
  const responses = [
    jsonResponse(
      {
        status: "ok",
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
      },
      200,
    ),
    authRequiredResponse(),
  ];

  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip-host.example.com",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.paperclipDetected, true);
  assert.equal(result.sessionState, "signed_out");
  assert.equal(result.deploymentExposure, "public");
});

test("preflight rejects redacted health with generic 401 session response", async () => {
  const responses = [
    jsonResponse(
      {
        status: "ok",
        deploymentMode: "authenticated",
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
      },
      200,
    ),
    jsonResponse({ error: "Unauthorized" }, 401),
  ];

  const result = await preflightRemoteConnection({
    remoteUrl: "https://example.com",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_paperclip");
  assert.equal(result.paperclipDetected, true);
  assert.equal(result.sessionState, "unknown");
});

test("preflight rejects redacted health without bootstrap invite state", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip-host.tailnet.ts.net",
    fetchImpl: async () =>
      jsonResponse(
        {
          status: "ok",
          deploymentMode: "authenticated",
          bootstrapStatus: "ready",
        },
        200,
      ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_paperclip");
  assert.equal(result.paperclipDetected, false);
});

test("preflight treats explicit authReady false as auth not ready", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip-host.tailnet.ts.net",
    fetchImpl: async () =>
      jsonResponse(
        {
          status: "ok",
          version: "2026.403.0",
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          authReady: false,
          bootstrapStatus: "ready",
          bootstrapInviteActive: false,
        },
        200,
      ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "auth_not_ready");
  assert.equal(result.paperclipDetected, true);
});

test("preflight blocks local_trusted remotes", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://192.168.1.50:3100",
    fetchImpl: async () =>
      jsonResponse(
        {
          status: "ok",
          version: "2026.403.0",
          deploymentMode: "local_trusted",
          deploymentExposure: "private",
          authReady: true,
          bootstrapStatus: "ready",
          bootstrapInviteActive: false,
        },
        200,
      ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.insecureTransport, false);
  assert.equal(result.reason, "unsupported_local_trusted");
});

test("preflight rejects unsupported URL schemes before any network call", async () => {
  let called = false;
  const result = await preflightRemoteConnection({
    remoteUrl: "ftp://paperclip.example.com",
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ status: "ok" }, 200);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_url");
  assert.match(result.detail, /http or https/i);
  assert.equal(called, false);
});

test("preflight allows http remotes and carries the insecurity warning", async () => {
  const responses = [
    jsonResponse(
      {
        status: "ok",
        version: "2026.403.0",
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
      },
      200,
    ),
    authRequiredResponse(),
  ];

  const result = await preflightRemoteConnection({
    remoteUrl: "http://paperclip.example.com:3200",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.insecureTransport, true);
  assert.equal(result.origin, "http://paperclip.example.com:3200");
  assert.equal(result.sessionState, "signed_out");
  assert.match(result.warning, /without TLS/i);
});

test("preflight rejects non-Paperclip endpoints", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://example.com",
    fetchImpl: async () => jsonResponse({ hello: "world" }, 200),
  });

  assert.equal(result.ok, false);
  assert.equal(result.insecureTransport, false);
  assert.equal(result.reason, "not_paperclip");
});

test("preflight rejects health responses that are not HTTP 200", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip-host.tailnet.ts.net",
    fetchImpl: async () =>
      jsonResponse(
        {
          status: "ok",
          deploymentMode: "authenticated",
          bootstrapStatus: "ready",
          bootstrapInviteActive: false,
        },
        503,
      ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_paperclip");
});

test("preflight uses fixed same-origin probe paths and manual redirects", async () => {
  const calls = [];
  const responses = [
    jsonResponse(
      {
        status: "ok",
        deploymentMode: "authenticated",
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
      },
      200,
    ),
    authRequiredResponse(),
  ];

  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip-host.tailnet.ts.net/user/input?next=https://evil.test#fragment",
    fetchImpl: async (input, init) => {
      calls.push({ url: input.toString(), redirect: init?.redirect });
      return responses.shift();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      url: "https://paperclip-host.tailnet.ts.net/api/health",
      redirect: "manual",
    },
    {
      url: "https://paperclip-host.tailnet.ts.net/api/auth/get-session",
      redirect: "manual",
    },
  ]);
});

test("preflight classifies TLS failures", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://badcert.example.com",
    fetchImpl: async () => {
      throw new Error("self-signed certificate");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.insecureTransport, false);
  assert.equal(result.reason, "tls_error");
});

// The test above throws an error whose *message* carries the keyword. No real
// fetch does that: undici — the global fetch in Node and in Electron's main
// process — rejects every transport failure as the literal "fetch failed" and
// puts the diagnosis on `cause`. Measured against badssl.com on 2026-10-18.
// The tests below use that real shape, which the old keyword match on
// `error.message` could not classify and reported to the user as "fetch failed".
function undiciFetchFailure(causeMessage, code) {
  const cause = new Error(causeMessage);
  if (code) {
    cause.code = code;
  }
  return Object.assign(new TypeError("fetch failed"), { cause });
}

test("preflight reads the cause chain undici hides the real failure behind", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip.lab.havenco.xyz",
    fetchImpl: async () => {
      throw undiciFetchFailure(
        "self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
      );
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "tls_error");
  // The whole point: the user must not be told "fetch failed".
  assert.notEqual(result.detail, "fetch failed");
  assert.match(result.detail, /self-signed certificate/);
  assert.match(result.detail, /DEPTH_ZERO_SELF_SIGNED_CERT/);
});

test("preflight classifies real TLS error codes, not just keyword messages", async () => {
  const cases = [
    ["certificate has expired", "CERT_HAS_EXPIRED"],
    ["Hostname/IP does not match certificate's altnames", "ERR_TLS_CERT_ALTNAME_INVALID"],
    ["unable to verify the first certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    // Chromium's own code, which is what the session-backed probe reports.
    ["net::ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_AUTHORITY_INVALID"],
  ];

  for (const [message, code] of cases) {
    const result = await preflightRemoteConnection({
      remoteUrl: "https://paperclip.lab.havenco.xyz",
      fetchImpl: async () => {
        throw undiciFetchFailure(message, code);
      },
    });
    assert.equal(result.reason, "tls_error", `${code} should classify as tls_error`);
    assert.match(result.detail, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("preflight reports a connection failure as unreachable with the real reason", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip.lab.havenco.xyz",
    fetchImpl: async () => {
      throw undiciFetchFailure("connect ECONNREFUSED 192.168.4.38:443", "ECONNREFUSED");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
  assert.match(result.detail, /ECONNREFUSED/);
  assert.notEqual(result.detail, "fetch failed");
});

// "Host unreachable" is equally true of a name that never resolved, a port
// with nothing behind it, and an address that cannot be routed to — and those
// are three unrelated repairs. The owner reported exactly this badge on
// 2026-10-18 with nothing to act on, which is what these assert against.
// `paperclip.lab.havenco.xyz` is NXDOMAIN on public DNS and resolves to a
// private address on the lab's own resolvers, so the DNS case is the likely one.
test("preflight distinguishes DNS failure from refusal from an unroutable address", async () => {
  const cases = [
    {
      code: "ENOTFOUND",
      message: "getaddrinfo ENOTFOUND paperclip.lab.havenco.xyz",
      expect: /did not resolve on this Mac/,
      reject: /nothing is listening|never answered/,
    },
    // Chromium's spelling of the same failure, which the session-backed probe reports.
    {
      code: "ERR_NAME_NOT_RESOLVED",
      message: "net::ERR_NAME_NOT_RESOLVED",
      expect: /did not resolve on this Mac/,
      reject: /nothing is listening|never answered/,
    },
    {
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 192.168.4.8:443",
      expect: /nothing is listening on port 443/,
      reject: /did not resolve|never answered/,
    },
    {
      code: "ERR_CONNECTION_TIMED_OUT",
      message: "net::ERR_CONNECTION_TIMED_OUT",
      expect: /private address \(192\.168\.x\.x, 10\.x\.x\.x\)/,
      reject: /did not resolve|nothing is listening/,
    },
  ];

  for (const { code, message, expect, reject } of cases) {
    const result = await preflightRemoteConnection({
      remoteUrl: "https://paperclip.lab.havenco.xyz",
      fetchImpl: async () => {
        throw undiciFetchFailure(message, code);
      },
    });

    assert.equal(result.reason, "unreachable", `${code} should still classify as unreachable`);
    // The raw diagnosis must survive alongside the hint, not be replaced by it.
    assert.match(result.detail, new RegExp(code), `${code} should appear in the detail`);
    assert.match(result.detail, expect, `${code} should name its own repair`);
    assert.doesNotMatch(result.detail, reject, `${code} should not name another repair`);
  }
});

test("the refusal hint names the port actually typed, not the scheme default", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip.lab.havenco.xyz:8443",
    fetchImpl: async () => {
      throw undiciFetchFailure("connect ECONNREFUSED 192.168.4.8:8443", "ECONNREFUSED");
    },
  });

  assert.match(result.detail, /nothing is listening on port 8443/);
});

test("an unrecognised transport code gets no invented hint", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip.lab.havenco.xyz",
    fetchImpl: async () => {
      throw undiciFetchFailure("socket hang up", "ECONNRESET");
    },
  });

  assert.equal(result.reason, "unreachable");
  assert.match(result.detail, /socket hang up/);
  assert.doesNotMatch(result.detail, /did not resolve|nothing is listening|never answered/);
});

test("preflight names a redirect instead of calling the host non-Paperclip", async () => {
  const result = await preflightRemoteConnection({
    remoteUrl: "https://paperclip.lab.havenco.xyz",
    fetchImpl: async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://sso.havenco.xyz/login?next=%2Fapi%2Fhealth" },
      }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_paperclip");
  assert.match(result.detail, /redirected \(HTTP 302\)/);
  assert.match(result.detail, /sso\.havenco\.xyz/);
  // The old message blamed the host for not exposing the endpoint, which sent
  // readers looking in the wrong place.
  assert.doesNotMatch(result.detail, /does not appear to expose/);
});

test("preflight distinguishes a non-JSON answer from a bad status", async () => {
  const html = await preflightRemoteConnection({
    remoteUrl: "https://paperclip.lab.havenco.xyz",
    fetchImpl: async () =>
      new Response("<!doctype html><title>nope</title>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  assert.equal(html.reason, "not_paperclip");
  assert.match(html.detail, /text\/html/);

  const gone = await preflightRemoteConnection({
    remoteUrl: "https://paperclip.lab.havenco.xyz",
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  assert.equal(gone.reason, "not_paperclip");
  assert.match(gone.detail, /HTTP 404/);
});

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authRequiredResponse() {
  return jsonResponse({ error: "Board authentication required" }, 401);
}
