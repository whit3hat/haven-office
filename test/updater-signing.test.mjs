import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CODESIGN_DISPLAY_ARGS,
  canApplyUpdateInPlace,
  classifyCodesignOutput,
  describeSignatureKind,
  detectMacSignatureKind,
  macBundleRootFromExecutable,
  releasesPageUrlFromFeed,
} = require("../dist/updater-signing.js");

// Real shapes of `codesign --display --verbose=2 --requirements - <bundle>`.
// codesign writes the display block to stderr and the requirement text to
// stdout, which is why both streams are classified together.
const ADHOC = {
  status: 0,
  stdout: 'designated => cdhash H"e6a1f7c3a9b24d5f8e0c1b3a7d9f2e4c6a8b0d12"\n',
  stderr: [
    "Executable=/Applications/Haven Office.app/Contents/MacOS/Haven Office",
    "Identifier=xyz.havenco.haven-office",
    "Format=app bundle with Mach-O thin (arm64)",
    "CodeDirectory v=20400 size=1337 flags=0x2(adhoc) hashes=30+7 location=embedded",
    "Signature=adhoc",
    "Info.plist entries=29",
    "TeamIdentifier=not set",
    "Sealed Resources version=2 rules=13 files=412",
    "",
  ].join("\n"),
};

const DEVELOPER_ID = {
  status: 0,
  stdout:
    'designated => identifier "xyz.havenco.haven-office" and anchor apple generic and ' +
    "certificate leaf[subject.OU] = ABCDE12345\n",
  stderr: [
    "Executable=/Applications/Haven Office.app/Contents/MacOS/Haven Office",
    "Identifier=xyz.havenco.haven-office",
    "Format=app bundle with Mach-O universal (x86_64 arm64)",
    "CodeDirectory v=20500 size=1337 flags=0x10000(runtime) hashes=30+7 location=embedded",
    "Signature size=9043",
    "Authority=Developer ID Application: Haven Co (ABCDE12345)",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "Timestamp=18 Oct 2026 at 16:00:00",
    "TeamIdentifier=ABCDE12345",
    "Runtime Version=14.0.0",
    "",
  ].join("\n"),
};

const UNSIGNED = {
  status: 1,
  stdout: "",
  stderr: "/Applications/Haven Office.app: code object is not signed at all\n",
};

test("an ad-hoc signed bundle is recognised as ad-hoc, not as signed", () => {
  assert.equal(classifyCodesignOutput(ADHOC), "adhoc");
  assert.equal(canApplyUpdateInPlace(classifyCodesignOutput(ADHOC)), false);
});

test("a Developer ID bundle can be updated in place", () => {
  assert.equal(classifyCodesignOutput(DEVELOPER_ID), "identified");
  assert.equal(canApplyUpdateInPlace(classifyCodesignOutput(DEVELOPER_ID)), true);
});

test("a bundle with no signature at all is recognised", () => {
  assert.equal(classifyCodesignOutput(UNSIGNED), "unsigned");
  assert.equal(canApplyUpdateInPlace(classifyCodesignOutput(UNSIGNED)), false);
});

test("a bare cdhash requirement is ad-hoc even without codesign's Signature line", () => {
  // Older codesign builds, and `--requirements -` captured on its own, do not
  // print the display block. The requirement alone still settles it: a
  // requirement pinned to one build's hash can never match the next build.
  assert.equal(
    classifyCodesignOutput({
      status: 0,
      stdout: 'designated => cdhash H"1111111111111111111111111111111111111111"\n',
      stderr: "",
    }),
    "adhoc",
  );
});

test("an identity is believed from Authority alone when no requirement is printed", () => {
  assert.equal(
    classifyCodesignOutput({
      status: 0,
      stdout: "",
      stderr: "Authority=Developer ID Application: Haven Co (ABCDE12345)\n",
    }),
    "identified",
  );
});

test("output that says nothing useful is unknown, and unknown does not update in place", () => {
  for (const output of [
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: "something unexpected\n", stderr: "Format=app bundle\n" },
    { status: null, stdout: "", stderr: "" },
  ]) {
    const kind = classifyCodesignOutput(output);
    assert.equal(kind, "unknown", `expected unknown for ${JSON.stringify(output)}`);
    assert.equal(canApplyUpdateInPlace(kind), false);
  }
});

test("flags=0x2(adhoc) is not mistaken for the Signature=adhoc line", () => {
  // The CodeDirectory line mentions adhoc on a signed build's output too in
  // some configurations, so the adhoc check is anchored to its own line.
  assert.equal(
    classifyCodesignOutput({
      status: 0,
      stdout: 'designated => identifier "x" and anchor apple generic\n',
      stderr: "CodeDirectory v=20500 size=9 flags=0x10000(runtime) hashes=1+1\nAuthority=Developer ID Application: Haven Co\n",
    }),
    "identified",
  );
});

test("every signing state has a sentence a human can read", () => {
  for (const kind of ["identified", "adhoc", "unsigned", "unknown"]) {
    const description = describeSignatureKind(kind);
    assert.equal(typeof description, "string");
    assert.ok(description.length > 0);
  }
});

test("the signature is read from the .app bundle, which is what Squirrel checks", () => {
  assert.equal(
    macBundleRootFromExecutable("/Applications/Haven Office.app/Contents/MacOS/Haven Office"),
    "/Applications/Haven Office.app",
  );
  // Nested bundles: the outermost .app is the running application.
  assert.equal(
    macBundleRootFromExecutable(
      "/Applications/Haven Office.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
    ),
    "/Applications/Haven Office.app/Contents/Frameworks/Helper.app",
  );
  // An unpacked build is not in a bundle at all.
  assert.equal(macBundleRootFromExecutable("/usr/local/bin/node"), "/usr/local/bin/node");
});

test("the download page is read from the updater feed, so it cannot disagree with it", () => {
  const feed = ["provider: github", "owner: whit3hat", "repo: haven-office", "updaterCacheDirName: haven-office-updater", ""].join("\n");
  assert.equal(
    releasesPageUrlFromFeed(feed),
    "https://github.com/whit3hat/haven-office/releases/latest",
  );
});

test("a missing or unparseable feed falls back to this repo's releases page", () => {
  for (const feed of [null, "", "provider: generic\nurl: https://example.test/feed\n"]) {
    assert.equal(
      releasesPageUrlFromFeed(feed),
      "https://github.com/whit3hat/haven-office/releases/latest",
    );
  }
});

test("detection passes the display and requirements flags codesign needs", async () => {
  let seen = null;
  const kind = await detectMacSignatureKind("/Applications/Haven Office.app", async (args) => {
    seen = args;
    return ADHOC;
  });

  assert.equal(kind, "adhoc");
  assert.deepEqual(seen, [...CODESIGN_DISPLAY_ARGS, "/Applications/Haven Office.app"]);
  assert.ok(seen.includes("--requirements"));
});

test("a codesign that cannot run at all degrades to a manual download", async () => {
  const kind = await detectMacSignatureKind("/Applications/Haven Office.app", async () => {
    throw new Error("spawn /usr/bin/codesign ENOENT");
  });

  assert.equal(kind, "unknown");
  assert.equal(canApplyUpdateInPlace(kind), false);
});
