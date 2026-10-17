import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_NPM_MAJOR,
  assertSupportedNpm,
  isSupportedNpmVersion,
  parseNpmMajor,
} from "../scripts/npm-preflight.mjs";

const fakeNpm = (output) => () => output;

test("reads the major out of npm --version output", () => {
  assert.equal(parseNpmMajor("10.9.9"), 10);
  assert.equal(parseNpmMajor("11.19.0\n"), 11);
  assert.equal(parseNpmMajor(" v11.6.2 "), 11);
});

test("an unreadable version is not a verdict", () => {
  assert.equal(parseNpmMajor("next"), null);
  assert.equal(parseNpmMajor(""), null);
  assert.equal(parseNpmMajor(undefined), null);
  assert.equal(isSupportedNpmVersion("next"), null);
});

test("npm 10 is the version that fails the bundled-server install", () => {
  assert.equal(isSupportedNpmVersion("10.9.9"), false);
  assert.equal(isSupportedNpmVersion("9.8.1"), false);
  assert.equal(isSupportedNpmVersion("11.19.0"), true);
  assert.equal(isSupportedNpmVersion(`${MINIMUM_NPM_MAJOR}.0.0`), true);
});

test("assertSupportedNpm returns the version it accepted", () => {
  assert.equal(assertSupportedNpm({ execFileSync: fakeNpm("11.19.0\n") }), "11.19.0");
});

test("assertSupportedNpm rejects npm 10 with an actionable message", () => {
  assert.throws(
    () => assertSupportedNpm({ execFileSync: fakeNpm("10.9.9\n") }),
    (error) => {
      assert.match(error.message, /npm 10\.9\.9 cannot install the bundled server/);
      assert.match(error.message, /edgesOut/);
      assert.match(error.message, new RegExp(`npm install -g npm@${MINIMUM_NPM_MAJOR}`));
      return true;
    },
  );
});

test("assertSupportedNpm does not block on a version it cannot read", () => {
  assert.equal(assertSupportedNpm({ execFileSync: fakeNpm("some-wrapper\n") }), "some-wrapper");
});
