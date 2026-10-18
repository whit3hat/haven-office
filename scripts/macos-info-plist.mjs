import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Why this file exists: macOS Local Network privacy.
 *
 * Since macOS 15 (Sequoia) a GUI app that opens a socket to a private-network
 * address — 192.168.x.x, 10.x.x.x, or any name that resolves to one — is denied
 * until the user grants it Local Network access. The denial is enforced against
 * the *app*, not the request, and it surfaces to the process as an ordinary
 * transport failure: `EHOSTUNREACH` from Node, `ERR_NETWORK_ACCESS_DENIED` or a
 * silent timeout from Chromium. Nothing in the error says "permission".
 *
 * That is exactly the shape of havenCo's own report: `curl` in Terminal reached
 * https://paperclip.lab.havenco.xyz/api/health and got HTTP 200, while Haven
 * Office on the same Mac at the same moment reported the host unreachable.
 * Terminal already holds the grant; the app held nothing.
 *
 * An app can only appear in System Settings → Privacy & Security → Local
 * Network, and so can only be granted, if its Info.plist declares a purpose
 * string. Ours declared none, in either electron-builder config, so there was
 * no way for the owner to approve it — the row did not exist to toggle.
 *
 * Declaring the key is necessary. It is not reliably sufficient: Electron apps
 * are widely reported to miss the first-connection prompt even with the key
 * present, because the responsible-process identity resolves to the Electron
 * framework rather than the app bundle. So the runbook keeps the manual grant
 * as the documented step, and this key is what makes that step possible.
 */
export const LOCAL_NETWORK_USAGE_DESCRIPTION =
  "Haven Office connects to the Paperclip server you add as a remote connection. "
  + "Lab and self-hosted servers normally live on your local network, so macOS "
  + "requires this permission before Haven Office can reach them.";

export const LOCAL_NETWORK_USAGE_KEY = "NSLocalNetworkUsageDescription";

/**
 * Read one string value out of a packed Info.plist.
 *
 * electron-builder rewrites Info.plist as XML, but Electron ships some bundles
 * as binary plists and a future toolchain change could switch ours. Guessing
 * wrong would make this check pass vacuously, which is the failure mode this
 * whole guard exists to prevent — so a binary plist goes through `plutil`
 * (always present on macOS, which is where the verifier runs) and anything we
 * cannot parse raises rather than returning "absent" or "present".
 */
export function readInfoPlistString(plistPath, key) {
  const raw = readFileSync(plistPath);

  if (raw.subarray(0, 8).toString("latin1") === "bplist00") {
    try {
      return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plistPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      // plutil exits non-zero when the key is absent, which is a real answer.
      const stderr = typeof error?.stderr === "string" ? error.stderr : "";
      if (/does not exist|No value at that key path/i.test(stderr)) {
        return null;
      }
      throw new Error(`Could not read ${key} from binary plist ${plistPath}: ${stderr || error?.message}`);
    }
  }

  const text = raw.toString("utf8");
  if (!text.includes("<plist")) {
    throw new Error(`${plistPath} is neither an XML nor a binary plist; cannot verify ${key}.`);
  }

  // Deliberately anchored on the <key> element rather than a bare substring
  // search: the purpose string itself mentions the key's subject matter, and a
  // substring match would accept a plist that merely talks about it.
  const pattern = new RegExp(
    `<key>\\s*${key}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`,
  );
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Fail the build when the packed app could never be granted Local Network
 * access. Without this the app installs, launches, passes every other check,
 * and then cannot reach a lab remote — with no row in System Settings to fix
 * it. That is the defect that reached the owner, so it is checked before a
 * release is published, not after.
 */
export function assertLocalNetworkUsageDescription({ appPath }) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  const value = readInfoPlistString(plistPath, LOCAL_NETWORK_USAGE_KEY);

  if (!value) {
    throw new Error(
      `${LOCAL_NETWORK_USAGE_KEY} is missing from ${plistPath}. On macOS 15+ this app can `
      + "never be granted Local Network access, so it cannot reach a Paperclip server on a "
      + "private address and will report the host as unreachable with no way for the user to "
      + "approve it. Add it via the mac.extendInfo block in the electron-builder config.",
    );
  }

  return { path: plistPath, key: LOCAL_NETWORK_USAGE_KEY, value };
}
