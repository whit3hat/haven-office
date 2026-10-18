// Guards the downstream patch in patches/@electron__osx-sign@1.3.3.patch.
//
// `@electron/osx-sign`'s walkAsync() recurses through the whole .app with an
// unbounded Promise.all, and getFilePathIfBinary() opens every regular file to
// sniff its Mach-O header. Haven Office embeds a full server runtime, so that
// fan-out exceeded the process file-descriptor limit and `Release Desktop` #3
// died with `EMFILE: too many open files` during the signing step — after the
// limit had already been raised to 65536 (run 39079436117).
//
// opts.signIgnore cannot prevent it: dist/cjs/sign.js walks first and filters
// afterwards. So the patch bounds the concurrent sniffs instead.
//
// These tests measure the real thing rather than trusting the patch text: they
// run walkAsync over a synthetic tree and sample /proc/self/fd to see how many
// descriptors are actually open at once. That makes the test Linux-only, which
// is fine — Linux is the only place our agents can run it, and the bug it
// guards is macOS-only but platform-independent in its cause.

import assert from "node:assert/strict";
import test from "node:test";

import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const PATCHED = "@electron/osx-sign/dist/cjs/util";
// Resolved the way electron-builder resolves it: from app-builder-lib, which is
// what codeSign/macCodeSign.js dynamically imports. If the patch stops applying
// this resolves to an unpatched copy and the bound test fails loudly.
// app-builder-lib is not a direct dependency, so walk in via electron-builder
// rather than assuming pnpm hoisted it to the root.
const APP_BUILDER_LIB = require.resolve("app-builder-lib", {
  paths: [require.resolve("electron-builder")],
});

const FILES_PER_DIR = 120;
const DIR_COUNT = 24;
const TOTAL_FILES = FILES_PER_DIR * DIR_COUNT;

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "osx-sign-walk-"));
  for (let d = 0; d < DIR_COUNT; d += 1) {
    const dir = join(root, `nested-${d}`, "deeper");
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_DIR; f += 1) {
      // Text, so isBinaryFile() reads it and returns false — the walk still had
      // to open it, which is the whole point.
      writeFileSync(join(dir, `file-${f}.d.ts`), "export {};\n");
    }
  }
  return root;
}

function countOpenFds() {
  return readdirSync("/proc/self/fd").length;
}

// Samples the live descriptor count while `run` is in flight. setInterval on a
// 1ms tick is not a precise sampler, but it does not need to be: the unbounded
// walk holds thousands of descriptors open for the whole run, so any sampling
// at all catches it.
async function peakOpenFds(run) {
  const baseline = countOpenFds();
  let peak = 0;
  const sample = () => {
    const open = countOpenFds() - baseline;
    if (open > peak) peak = open;
  };
  const timer = setInterval(sample, 1);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  return peak;
}

test("the patch is actually applied to the copy electron-builder resolves", () => {
  const patchedPath = require.resolve(PATCHED, { paths: [APP_BUILDER_LIB] });
  assert.match(
    patchedPath,
    /patch_hash=/,
    `electron-builder resolved an unpatched @electron/osx-sign at ${patchedPath}. ` +
      "Check pnpm.patchedDependencies in package.json and the patchedDependencies block in pnpm-lock.yaml.",
  );
});

test("walkAsync keeps its open descriptors bounded while sniffing every file", async (t) => {
  if (process.platform !== "linux") {
    t.skip("descriptor sampling reads /proc/self/fd");
    return;
  }

  const { walkAsync } = require(require.resolve(PATCHED, { paths: [APP_BUILDER_LIB] }));
  const root = makeTree();

  try {
    let found;
    const peak = await peakOpenFds(async () => {
      found = await walkAsync(root);
    });

    // Nothing in the tree is a Mach-O binary, so the walk yields nothing — but
    // it only knows that by opening all of them.
    assert.deepEqual(found, []);

    // The patch caps concurrent sniffs at 32. Allow generous headroom for
    // directory handles and whatever else the runner has in flight; the
    // unpatched behaviour is three orders of magnitude away from this.
    assert.ok(
      peak < 256,
      `expected the patched walk to hold well under 256 descriptors open, saw ${peak} ` +
        `across ${TOTAL_FILES} files`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the unpatched walk is the thing that blows the descriptor limit", async (t) => {
  if (process.platform !== "linux") {
    t.skip("descriptor sampling reads /proc/self/fd");
    return;
  }

  // pnpm keeps the pristine copy beside the patched one, in a store directory
  // whose name is the patched one minus the `_patch_hash=…` segment. Derive it
  // from the path pnpm actually handed us rather than hard-coding a layout. If
  // pnpm stops keeping it there this test has nothing to compare against, so
  // skip — the bound assertion above is what protects the build.
  const patchedPath = require.resolve(PATCHED, { paths: [APP_BUILDER_LIB] });
  const unpatchedPath = patchedPath.replace(/_patch_hash=[^/]+/, "");
  if (unpatchedPath === patchedPath || !existsSync(unpatchedPath)) {
    t.skip("no unpatched @electron/osx-sign copy to compare against");
    return;
  }

  const unpatched = require(unpatchedPath);
  if (String(unpatched.walkAsync).includes("acquireBinarySniffSlot")) {
    t.skip("the comparison copy is patched too");
    return;
  }

  const root = makeTree();
  try {
    const peak = await peakOpenFds(async () => {
      await unpatched.walkAsync(root);
    });

    // This is the regression this patch exists for. Asserting it here means the
    // test documents the bug with a measurement instead of a comment, and it
    // catches a future osx-sign release that fixes the fan-out upstream (at
    // which point the patch can be dropped).
    assert.ok(
      peak > 256,
      `expected the unpatched walk to fan out past 256 descriptors over ${TOTAL_FILES} files, ` +
        `saw only ${peak}. If upstream bounded walkAsync, drop the patch.`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
