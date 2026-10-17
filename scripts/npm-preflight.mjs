/**
 * npm version preflight for the bundled-server install.
 *
 * prepare-server.mjs stages @paperclipai/server with `npm install` into a
 * throwaway directory. npm 10's dependency resolver crashes on that tree with
 * `Cannot read properties of null (reading 'edgesOut')` and installs nothing —
 * reproduced on npm 10.9.9, the version bundled with Node 22, and fixed on
 * 11.19.0. The crash names no package and no cause, so this turns it into a
 * failure that says what to do instead. Dropping this file is safe the day the
 * build's Node version ships npm >= 11 on its own.
 */

import { execFileSync as defaultExecFileSync } from "node:child_process";

export const MINIMUM_NPM_MAJOR = 11;

/**
 * Major version from `npm --version` output, or null when it is not a version
 * we can read (a prerelease build, a wrapper that prints something else).
 */
export function parseNpmMajor(output) {
  const match = /^\s*v?(\d+)\.\d+\.\d+/.exec(String(output ?? ""));
  return match ? Number(match[1]) : null;
}

export function isSupportedNpmVersion(output) {
  const major = parseNpmMajor(output);
  return major === null ? null : major >= MINIMUM_NPM_MAJOR;
}

/**
 * Throw unless the `npm` on PATH can install the bundled server. Returns the
 * version string it saw. An unreadable version is not treated as a failure:
 * the point is to catch the known-broken majors, not to police the toolchain.
 */
export function assertSupportedNpm({ execFileSync = defaultExecFileSync, npmCommand = "npm" } = {}) {
  const version = String(
    execFileSync(npmCommand, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  ).trim();

  if (isSupportedNpmVersion(version) === false) {
    throw new Error(
      [
        `npm ${version} cannot install the bundled server.`,
        `npm ${parseNpmMajor(version)}'s dependency resolver crashes on @paperclipai/server's`,
        `tree with "Cannot read properties of null (reading 'edgesOut')".`,
        `Use npm >= ${MINIMUM_NPM_MAJOR}: npm install -g npm@${MINIMUM_NPM_MAJOR}`,
        "(CI pins it in .github/workflows/release.yml.)",
      ].join(" "),
    );
  }

  return version;
}
