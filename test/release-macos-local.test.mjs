import assert from "node:assert/strict";
import test from "node:test";

import { buildStageConfig, resolveMacSigningIdentity } from "../scripts/release-macos-local.mjs";

const NO_IDENTITIES = () => [];
const ONE_IDENTITY = () => ["Developer ID Application: havenCo (ABCDE12345)"];

test("an explicit identity wins over the keychain and over the unsigned escape hatch", () => {
  const signing = resolveMacSigningIdentity({
    env: {
      APPLE_CODESIGN_IDENTITY: "Developer ID Application: havenCo (ABCDE12345)",
      ALLOW_UNSIGNED_MACOS_BUILD: "true",
    },
    listCodesigningIdentities: NO_IDENTITIES,
  });

  assert.equal(signing.adhoc, false);
  assert.equal(signing.name, "Developer ID Application: havenCo (ABCDE12345)");
  assert.equal(signing.teamId, "ABCDE12345");
});

test("a single keychain identity is used when nothing is set explicitly", () => {
  const signing = resolveMacSigningIdentity({ env: {}, listCodesigningIdentities: ONE_IDENTITY });

  assert.equal(signing.adhoc, false);
  assert.equal(signing.name, "Developer ID Application: havenCo (ABCDE12345)");
  assert.equal(signing.teamId, "ABCDE12345");
});

test("no identity anywhere is an error that names the unsigned escape hatch", () => {
  assert.throws(
    () => resolveMacSigningIdentity({ env: {}, listCodesigningIdentities: NO_IDENTITIES }),
    /ALLOW_UNSIGNED_MACOS_BUILD=true/,
  );
});

test("ALLOW_UNSIGNED_MACOS_BUILD selects the ad-hoc path without touching the keychain", () => {
  const signing = resolveMacSigningIdentity({
    env: { ALLOW_UNSIGNED_MACOS_BUILD: "true" },
    listCodesigningIdentities: () => {
      throw new Error("the keychain must not be consulted on the unsigned path");
    },
  });

  assert.deepEqual(signing, { name: null, teamId: null, adhoc: true });
});

test("only the literal string true opts into the unsigned path", () => {
  assert.throws(
    () =>
      resolveMacSigningIdentity({
        env: { ALLOW_UNSIGNED_MACOS_BUILD: "1" },
        listCodesigningIdentities: NO_IDENTITIES,
      }),
    /No Developer ID Application signing identity/,
  );
});

test("the signed stage config keeps hardened runtime, entitlements and keychain discovery", () => {
  const { mac } = buildStageConfig("arm64", {
    name: "Developer ID Application: havenCo (ABCDE12345)",
    teamId: "ABCDE12345",
    adhoc: false,
  });

  assert.equal(mac.hardenedRuntime, true);
  assert.equal(mac.entitlements, "build/entitlements.mac.plist");
  assert.equal(mac.entitlementsInherit, "build/entitlements.mac.inherit.plist");
  assert.equal(mac.notarize, false);
  assert.ok(!("identity" in mac), "the signed path must let electron-builder resolve the identity");
  assert.ok(!("timestamp" in mac), "the signed path must keep secure timestamps");
});

test("the unsigned stage config asks for an ad-hoc signature and drops what it cannot support", () => {
  const { mac } = buildStageConfig("arm64", { name: null, teamId: null, adhoc: true });

  assert.equal(mac.identity, "-");
  assert.equal(mac.hardenedRuntime, false);
  assert.equal(mac.timestamp, "none");
  assert.ok(!("entitlements" in mac), "entitlements require a real identity");
  assert.ok(!("entitlementsInherit" in mac), "entitlements require a real identity");
  assert.equal(mac.notarize, false);
});

test("both paths still skip the app-server tree and target both dmg and zip", () => {
  for (const signing of [
    { name: "Developer ID Application: havenCo (ABCDE12345)", teamId: "ABCDE12345", adhoc: false },
    { name: null, teamId: null, adhoc: true },
  ]) {
    const config = buildStageConfig("x64", signing);

    assert.deepEqual(config.mac.signIgnore, ["/Contents/Resources/app-server/.*"]);
    assert.deepEqual(
      config.mac.target.map((entry) => entry.target),
      ["dmg", "zip"],
    );
    assert.deepEqual(config.mac.target[0].arch, ["x64"]);
    assert.equal(config.publish.owner, "whit3hat");
    assert.equal(config.publish.repo, "haven-office");
  }
});
