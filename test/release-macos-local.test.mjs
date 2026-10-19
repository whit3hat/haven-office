import assert from "node:assert/strict";
import test from "node:test";

import { spawnSync } from "node:child_process";

import { TRAY_TEMPLATE_ASSETS } from "../scripts/packaged-smoke-assertions.mjs";
import { buildStageConfig, resolveMacSigningIdentity, withRaisedFileLimit } from "../scripts/release-macos-local.mjs";

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

test("the staged config ships the bundled plugins, on both signing paths", () => {
  // The repo-level electron-builder.yml has had this mapping all along, but it
  // is not the file that builds a published .dmg — this generated one is, and
  // it lacked the entry through v2026.10.7. Those builds therefore packed no
  // `<Resources>/app-server/plugins`, plugin provisioning found nothing to do,
  // and the office route 404d in every installed copy.
  for (const signing of [
    { name: "Developer ID Application: havenCo (ABCDE12345)", teamId: "ABCDE12345", adhoc: false },
    { name: null, teamId: null, adhoc: true },
  ]) {
    const config = buildStageConfig("arm64", signing);
    const destinations = config.extraResources.map((entry) => entry.to);

    assert.ok(
      destinations.includes("app-server/plugins"),
      `no app-server/plugins in ${JSON.stringify(destinations)}`,
    );
    assert.deepEqual(
      config.extraResources.find((entry) => entry.to === "app-server/plugins"),
      { from: "app-server/plugins", to: "app-server/plugins", filter: ["**/*"] },
    );
  }
});

test("the staged config ships the menu-bar template icon, on both signing paths", () => {
  // Found the same way as the plugins entry above, one release later: the
  // repo-level electron-builder.yml stages both tray files, this generated
  // config did not, and `new Tray(nativeImage.createFromPath(missing))`
  // succeeds and draws nothing. HAV-43 landed the tray; without this entry
  // every published .dmg would have had an invisible menu-bar item.
  for (const signing of [
    { name: "Developer ID Application: havenCo (ABCDE12345)", teamId: "ABCDE12345", adhoc: false },
    { name: null, teamId: null, adhoc: true },
  ]) {
    const config = buildStageConfig("arm64", signing);

    for (const name of TRAY_TEMPLATE_ASSETS) {
      assert.deepEqual(
        config.extraResources.find((entry) => entry.to === name),
        { from: `build/${name}`, to: name },
        `no ${name} at the resources root in ${JSON.stringify(config.extraResources.map((e) => e.to))}`,
      );
    }
  }
});

test("the packaging child is left alone off macOS", () => {
  const call = withRaisedFileLimit("pnpm", ["exec", "electron-builder"], { platform: "linux" });

  assert.equal(call.command, "pnpm");
  assert.deepEqual(call.commandArgs, ["exec", "electron-builder"]);
});

test("on macOS the packaging child is wrapped in a descriptor-limit raise", () => {
  const call = withRaisedFileLimit("pnpm", ["exec", "electron-builder", "--mac"], { platform: "darwin" });

  assert.equal(call.command, "/bin/sh");
  assert.equal(call.commandArgs[0], "-c");
  assert.match(call.commandArgs[1], /ulimit -n/);
  assert.match(call.commandArgs[1], /exec "\$@"/);
  // $0 placeholder, then the original argv in order.
  assert.deepEqual(call.commandArgs.slice(2), ["sh", "pnpm", "exec", "electron-builder", "--mac"]);
});

test("the limit ladder descends, so a low hard limit still gets the best it allows", () => {
  const { commandArgs } = withRaisedFileLimit("pnpm", [], { platform: "darwin" });
  const ladder = commandArgs[1].match(/^for limit in (.+); do$/m)[1].split(" ").map(Number);

  assert.ok(ladder.length > 1);
  assert.deepEqual(ladder, [...ladder].sort((a, b) => b - a));
  assert.ok(ladder.at(-1) > 256, "the lowest rung must still beat the macOS default of 256");
});

test("the wrapper runs the real command, with arguments that contain spaces intact", () => {
  // Exercised here rather than asserted on: the `"$@"` handoff is the whole
  // point, and a staged path like `/var/folders/.../Haven Office.app` is
  // exactly the argument a quoting bug would split.
  const { command, commandArgs } = withRaisedFileLimit(
    process.execPath,
    ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "Haven Office.app", "--mac"],
    { platform: "darwin" },
  );

  const result = spawnSync(command, commandArgs, { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.match(lines[0], /^\[release-local\] file descriptor soft limit: \d+$/);
  assert.deepEqual(JSON.parse(lines[1]), ["Haven Office.app", "--mac"]);
});
