import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isNavigationAllowed,
  shouldOpenExternally,
  remotePartitionForProfile,
  remotePartitionForOrigin,
  remotePartitionKey,
  savedProfileIdForRemoteUrl,
} = require("../dist/connection/window-policy.js");

function remoteProfile(id, remoteUrl) {
  return { id, name: id, mode: "remote_existing", remoteUrl };
}

test("window policy only allows same-origin navigation", () => {
  const allowedOrigin = "https://paperclip-host.tailnet.ts.net";
  assert.equal(isNavigationAllowed("https://paperclip-host.tailnet.ts.net/dashboard", allowedOrigin), true);
  assert.equal(isNavigationAllowed("https://example.com", allowedOrigin), false);
});

test("window policy opens external http links outside the allowed origin", () => {
  const allowedOrigin = "http://localhost:3100";
  assert.equal(shouldOpenExternally("https://docs.paperclip.ing", allowedOrigin), true);
  assert.equal(shouldOpenExternally("http://localhost:3100/settings", allowedOrigin), false);
  assert.equal(shouldOpenExternally("mailto:test@example.com", allowedOrigin), false);
});

test("remote partitions are isolated per profile", () => {
  assert.equal(remotePartitionForProfile("abc123"), "persist:paperclip-remote-abc123");
});

test("an unsaved remote is partitioned by origin, not shared with other remotes", () => {
  const origin = remotePartitionForOrigin("https://haven.tailnet.ts.net");
  assert.match(origin, /^persist:paperclip-remote-[0-9a-f]{12}$/);
  assert.equal(origin, remotePartitionForOrigin("https://haven.tailnet.ts.net"));
  assert.notEqual(origin, remotePartitionForOrigin("https://other.tailnet.ts.net"));
});

test("a profile owns its partition and anything else falls back to the origin", () => {
  const origin = "https://haven.tailnet.ts.net";
  assert.equal(remotePartitionKey("abc123", origin), "persist:paperclip-remote-abc123");
  assert.equal(remotePartitionKey(null, origin), remotePartitionForOrigin(origin));
});

test("a typed URL adopts the saved profile that owns its origin", () => {
  const profiles = [
    remoteProfile("haven", "https://haven.tailnet.ts.net"),
    remoteProfile("other", "https://other.tailnet.ts.net"),
    { id: "local_embedded", name: "Local", mode: "local_embedded" },
  ];

  // The path differs and the trailing slash differs; the origin is what owns
  // the cookie jar, so this is still the saved connection.
  assert.equal(
    savedProfileIdForRemoteUrl({ remoteUrl: "https://haven.tailnet.ts.net/HAV/issues", profiles }),
    "haven",
  );
  assert.equal(
    savedProfileIdForRemoteUrl({ remoteUrl: "https://unsaved.tailnet.ts.net", profiles }),
    null,
  );
});

test("two profiles on one origin own nothing between them", () => {
  // Picking either would silently choose an account, so the typed URL keeps the
  // origin partition and the user picks a profile from the saved list instead.
  const profiles = [
    remoteProfile("haven", "https://haven.tailnet.ts.net"),
    remoteProfile("haven-copy", "https://haven.tailnet.ts.net/HAV"),
  ];

  assert.equal(
    savedProfileIdForRemoteUrl({ remoteUrl: "https://haven.tailnet.ts.net", profiles }),
    null,
  );
});

test("an unparseable URL or profile never resolves to a partition", () => {
  const profiles = [remoteProfile("broken", "not-a-url"), remoteProfile("haven", "https://haven.tailnet.ts.net")];
  assert.equal(savedProfileIdForRemoteUrl({ remoteUrl: "not-a-url", profiles }), null);
  assert.equal(savedProfileIdForRemoteUrl({ remoteUrl: "https://haven.tailnet.ts.net", profiles }), "haven");
});
