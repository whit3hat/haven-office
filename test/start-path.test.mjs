import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  COMPANY_PREFIX_ENV_VAR,
  DEFAULT_COMPANY_PREFIX,
  desktopViewPath,
  normalizeCompanyPrefix,
  normalizeViewPath,
  resolveCompanyPrefix,
  resolveDesktopViewUrl,
  resolveStartUrl,
  toViewPath,
} = require("../dist/connection/start-path.js");
const {
  ConnectionStore,
  getConnectionsFilePath,
} = require("../dist/connection/profiles.js");
const { LOCAL_PROFILE_ID } = require("../dist/connection/types.js");

function tempStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "haven-start-path-"));
  return {
    tempDir,
    store: new ConnectionStore(getConnectionsFilePath(tempDir)),
    reload: () => new ConnectionStore(getConnectionsFilePath(tempDir)),
  };
}

// --- start path resolution ------------------------------------------------

test("start path lands on the office for a local connection", () => {
  assert.equal(
    resolveStartUrl({ allowedOrigin: "http://localhost:3100", prefix: "HAV" }),
    "http://localhost:3100/HAV/office",
  );
});

test("start path lands on the office for a remote connection", () => {
  assert.equal(
    resolveStartUrl({
      allowedOrigin: "https://paperclip-host.tailnet.ts.net",
      prefix: "HAV",
    }),
    "https://paperclip-host.tailnet.ts.net/HAV/office",
  );
});

test("start path prefers the remembered view over the office default", () => {
  assert.equal(
    resolveStartUrl({
      allowedOrigin: "http://localhost:3100",
      prefix: "HAV",
      lastViewPath: "/HAV/issues/HAV-35",
    }),
    "http://localhost:3100/HAV/issues/HAV-35",
  );
});

test("start path falls back to the office when the remembered view is unusable", () => {
  for (const lastViewPath of [null, "", "relative/path", "https://evil.example.com/x"]) {
    assert.equal(
      resolveStartUrl({ allowedOrigin: "http://localhost:3100", prefix: "HAV", lastViewPath }),
      "http://localhost:3100/HAV/office",
      `expected office fallback for ${JSON.stringify(lastViewPath)}`,
    );
  }
});

test("start path falls back to the origin root when the prefix is unusable", () => {
  assert.equal(
    resolveStartUrl({ allowedOrigin: "http://localhost:3100", prefix: "not a prefix" }),
    "http://localhost:3100/",
  );
});

// --- prefix comes from configuration -------------------------------------

test("company prefix is read from configuration, most specific first", () => {
  assert.equal(resolveCompanyPrefix({}), DEFAULT_COMPANY_PREFIX);
  assert.equal(
    resolveCompanyPrefix({ state: { officeCompanyPrefix: "ACME" } }),
    "ACME",
  );
  assert.equal(
    resolveCompanyPrefix({
      state: { officeCompanyPrefix: "ACME" },
      env: { [COMPANY_PREFIX_ENV_VAR]: "ENVCO" },
    }),
    "ENVCO",
  );
  assert.equal(
    resolveCompanyPrefix({
      profile: { companyPrefix: "PROF" },
      state: { officeCompanyPrefix: "ACME" },
      env: { [COMPANY_PREFIX_ENV_VAR]: "ENVCO" },
    }),
    "PROF",
  );
});

test("company prefix ignores invalid configuration values", () => {
  for (const value of ["", "   ", "has space", "bad/slash", "x".repeat(33), 42, null]) {
    assert.equal(normalizeCompanyPrefix(value), null, `expected ${JSON.stringify(value)} rejected`);
  }

  assert.equal(normalizeCompanyPrefix("/HAV/"), "HAV");
  assert.equal(
    resolveCompanyPrefix({ env: { [COMPANY_PREFIX_ENV_VAR]: "has space" } }),
    DEFAULT_COMPANY_PREFIX,
  );
});

test("the store resolves the prefix per connection", () => {
  const { store } = tempStore();
  const profile = store.saveRemoteProfile({
    name: "Other Paperclip",
    remoteUrl: "https://other.example.com/",
    now: "2026-10-13T10:00:00.000Z",
  });

  assert.equal(store.getCompanyPrefix(LOCAL_PROFILE_ID, {}), DEFAULT_COMPANY_PREFIX);
  assert.equal(
    store.getCompanyPrefix(LOCAL_PROFILE_ID, { [COMPANY_PREFIX_ENV_VAR]: "ENVCO" }),
    "ENVCO",
  );
  assert.equal(store.getCompanyPrefix(profile.id, {}), DEFAULT_COMPANY_PREFIX);
});

// --- no origin escape -----------------------------------------------------

test("start path never escapes the allowed origin", () => {
  const allowedOrigin = "https://paperclip-host.tailnet.ts.net";
  const escapes = [
    "//evil.example.com/HAV/office",
    "/\\evil.example.com/HAV/office",
    "\\\\evil.example.com",
    "https://evil.example.com/HAV/office",
    "http://paperclip-host.tailnet.ts.net/HAV/office",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "/HAV/office\nhttps://evil.example.com",
  ];

  for (const candidate of escapes) {
    assert.equal(normalizeViewPath(candidate), null, `expected ${candidate} rejected`);
    const resolved = resolveStartUrl({ allowedOrigin, prefix: "HAV", lastViewPath: candidate });
    assert.equal(
      new URL(resolved).origin,
      allowedOrigin,
      `expected ${candidate} to stay on the allowed origin`,
    );
  }
});

test("desktop view urls stay on the allowed origin and reject unknown views", () => {
  const allowedOrigin = "http://localhost:3100";

  assert.equal(
    resolveDesktopViewUrl({ allowedOrigin, prefix: "HAV", viewKey: "office" }),
    "http://localhost:3100/HAV/office",
  );
  assert.equal(
    resolveDesktopViewUrl({ allowedOrigin, prefix: "HAV", viewKey: "board" }),
    "http://localhost:3100/HAV/issues",
  );
  assert.equal(
    resolveDesktopViewUrl({ allowedOrigin, prefix: "HAV", viewKey: "nope" }),
    null,
  );
  assert.equal(desktopViewPath("office", "../../evil"), null);
});

test("only in-origin urls are storable as a view path", () => {
  const allowedOrigin = "https://paperclip-host.tailnet.ts.net";

  assert.equal(
    toViewPath("https://paperclip-host.tailnet.ts.net/HAV/office?tab=desk#a", allowedOrigin),
    "/HAV/office?tab=desk#a",
  );
  assert.equal(toViewPath("https://evil.example.com/HAV/office", allowedOrigin), null);
  assert.equal(toViewPath("http://paperclip-host.tailnet.ts.net/HAV/office", allowedOrigin), null);
  assert.equal(toViewPath("not a url", allowedOrigin), null);
});

// --- last-view round trip -------------------------------------------------

test("last view round-trips through the store for local and remote", () => {
  const { store, reload } = tempStore();
  const profile = store.saveRemoteProfile({
    name: "Home Server",
    remoteUrl: "https://paperclip-host.tailnet.ts.net/",
    now: "2026-10-13T10:00:00.000Z",
  });

  assert.equal(store.getLastViewPath(LOCAL_PROFILE_ID), null);
  assert.equal(store.getLastViewPath(profile.id), null);
  assert.equal(store.getLastViewPath(null), null);

  store.recordLastViewPath(LOCAL_PROFILE_ID, "/HAV/issues");
  store.recordLastViewPath(profile.id, "/HAV/office");

  const reloaded = reload();
  assert.equal(reloaded.getLastViewPath(LOCAL_PROFILE_ID), "/HAV/issues");
  assert.equal(reloaded.getLastViewPath(profile.id), "/HAV/office");

  // A remembered view drives the next start URL for that connection.
  assert.equal(
    resolveStartUrl({
      allowedOrigin: "http://localhost:3100",
      prefix: reloaded.getCompanyPrefix(LOCAL_PROFILE_ID, {}),
      lastViewPath: reloaded.getLastViewPath(LOCAL_PROFILE_ID),
    }),
    "http://localhost:3100/HAV/issues",
  );
});

test("the store refuses to remember a view path that is not origin-relative", () => {
  const { store, reload } = tempStore();

  store.recordLastViewPath(LOCAL_PROFILE_ID, "/HAV/office");
  for (const bad of ["https://evil.example.com/x", "//evil.example.com", "relative", ""]) {
    store.recordLastViewPath(LOCAL_PROFILE_ID, bad);
    assert.equal(store.getLastViewPath(LOCAL_PROFILE_ID), "/HAV/office");
  }

  assert.equal(reload().getLastViewPath(LOCAL_PROFILE_ID), "/HAV/office");
});

test("a persisted file with a hostile view path is sanitized on load", () => {
  const { tempDir, store, reload } = tempStore();
  store.recordLastViewPath(LOCAL_PROFILE_ID, "/HAV/office");

  const file = getConnectionsFilePath(tempDir);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.state.localLastViewPath = "https://evil.example.com/HAV/office";
  raw.state.officeCompanyPrefix = "bad prefix";
  fs.writeFileSync(file, JSON.stringify(raw));

  const reloaded = reload();
  assert.equal(reloaded.getLastViewPath(LOCAL_PROFILE_ID), null);
  assert.equal(reloaded.getCompanyPrefix(LOCAL_PROFILE_ID, {}), DEFAULT_COMPANY_PREFIX);
  assert.equal(
    resolveStartUrl({
      allowedOrigin: "http://localhost:3100",
      prefix: reloaded.getCompanyPrefix(LOCAL_PROFILE_ID, {}),
      lastViewPath: reloaded.getLastViewPath(LOCAL_PROFILE_ID),
    }),
    "http://localhost:3100/HAV/office",
  );
});
