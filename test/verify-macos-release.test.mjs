import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// verify-macos-release.mjs runs its work at the top level and shells out to
// codesign, hdiutil and xcrun, so it cannot be imported or executed here —
// importing it would run a release verification against a directory that does
// not exist, on a platform without any of those tools. These are source-level
// guards instead. They are weak about behaviour and strong about the one thing
// that actually went wrong historically: a published artifact whose contents
// nothing looked inside.
const source = readFileSync(fileURLToPath(new URL("../scripts/verify-macos-release.mjs", import.meta.url)), "utf8");

function artifactLoopBody(kind) {
  const start = source.indexOf(`for (const ${kind}Path of ${kind}Artifacts) {`);
  assert.notEqual(start, -1, `expected a loop over ${kind}Artifacts`);
  const next = source.indexOf("\nfor (const ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("every published artifact kind has its contents checked, not just its signature", () => {
  // The .dmg is the only artifact the owner ever downloads. Until this guard
  // it was also the only one of the three whose contents nothing verified:
  // collectChecks ran on the raw .app and on the .app inside each .zip, the
  // dmg got codesign and nothing else, and the packaged smoke test extracts
  // the *-mac.zip. Every content assertion we owned was proving something
  // about an artifact nobody installs.
  for (const kind of ["dmg", "zip"]) {
    assert.match(
      artifactLoopBody(kind),
      /collectChecks\(/,
      `the ${kind} branch must look inside the artifact, not only at its signature`,
    );
  }

  assert.match(source, /verification\.appBundles\.push\(\{\s*path: relative\(appPath\),\s*checks: collectChecks\(appPath\)/);
});

test("the dmg is mounted read-only and always detached", () => {
  const body = artifactLoopBody("dmg");

  // -readonly so verification cannot mutate a release artifact, -nobrowse so a
  // release build on someone's Mac does not pop a Finder window per arch.
  assert.match(body, /"hdiutil",\s*\[\s*"attach",\s*dmgPath,\s*"-nobrowse",\s*"-readonly"/);

  // The detach has to be in a finally: a dmg left mounted by a failed
  // verification wedges the next run, which then fails for the wrong reason.
  const finallyIndex = body.indexOf("} finally {");
  assert.notEqual(finallyIndex, -1, "the mount must be wrapped in try/finally");
  assert.match(body.slice(finallyIndex), /hdiutil",\s*\["detach"/);

  // tryRun, not run: a detach that fails must not mask the verification error
  // that caused the finally to run in the first place.
  assert.match(body.slice(finallyIndex), /tryRun\("hdiutil",\s*\["detach"/);
});

test("a dmg with no .app inside is an error rather than a silent pass", () => {
  // The failure that keeps recurring in this repo is absence read as success —
  // nativeImage returns an empty image for a missing icon, a find that matches
  // nothing returns undefined. Both look like "fine" unless something throws.
  assert.match(artifactLoopBody("dmg"), /throw new Error\(`No \.app bundle found inside \$\{dmgPath\}`\)/);
});
