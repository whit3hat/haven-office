/**
 * Whether the running macOS app can have an update applied in place.
 *
 * Electron's `autoUpdater` is Squirrel.Mac, and Squirrel.Mac validates the
 * downloaded bundle against the *running* app's designated requirement:
 * `SQRLCodeSignature.currentApplicationSignature` calls `SecCodeCopySelf` plus
 * `SecCodeCopyDesignatedRequirement`, and `-verifyBundleAtURL:` then runs
 * `SecStaticCodeCheckValidityWithErrors(..., requirement)` against it
 * (Squirrel/SQRLCodeSignature.m). Electron 41's own documentation states the
 * consequence outright: "Your application must be signed for automatic updates
 * on macOS. This is a requirement of Squirrel.Mac."
 *
 * An ad-hoc signature has no identity to anchor to, so its designated
 * requirement is the literal code-directory hash of that one build. The next
 * version has a different hash, the requirement can never be satisfied, and the
 * install fails — after the user has already agreed to restart. Our v1 ships
 * ad-hoc signed (HAV-32, no Apple Developer ID), so this is the normal case
 * here, not an edge case.
 *
 * This module has no `electron` import on purpose: it is unit tested from
 * `dist/`, where `require("electron")` is not available.
 */

export type MacSignatureKind = "identified" | "adhoc" | "unsigned" | "unknown";

export interface CodesignOutput {
  /** Exit status of `codesign`, or null if it was killed by a signal. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `codesign` writes most of this to stderr, so both streams are classified. */
export const CODESIGN_DISPLAY_ARGS = ["--display", "--verbose=2", "--requirements", "-"];

const RELEASES_PAGE_FALLBACK = "https://github.com/whit3hat/haven-office/releases/latest";

/**
 * Classify what `codesign --display --verbose=2 --requirements -` reported.
 *
 * Only `identified` — a designated requirement anchored to an identity rather
 * than to one build's hash — can survive a version change, so only `identified`
 * permits an in-place update. Everything else degrades to "tell the human where
 * to download it", which is honest in every direction: the worst case of
 * guessing `manual` wrongly is a manual download, while the worst case of
 * guessing in-place wrongly is a failed install at quit.
 */
export function classifyCodesignOutput(output: CodesignOutput): MacSignatureKind {
  const combined = `${output.stdout}\n${output.stderr}`;

  if (/code object is not signed at all/i.test(combined)) {
    return "unsigned";
  }

  // `Signature=adhoc` is codesign's own word for it and needs no parsing.
  if (/^\s*Signature\s*=\s*adhoc\s*$/im.test(combined)) {
    return "adhoc";
  }

  const designated = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("designated =>"));

  if (designated) {
    // A bare cdhash is the signature of an ad-hoc signature: the requirement is
    // pinned to this exact build and nothing else can ever satisfy it.
    if (/\bcdhash\b/i.test(designated)) {
      return "adhoc";
    }

    if (/\banchor\b/i.test(designated)) {
      return "identified";
    }
  }

  // No designated requirement in the output, but a signing authority is proof
  // enough of a real identity.
  if (/^\s*Authority\s*=/im.test(combined)) {
    return "identified";
  }

  return "unknown";
}

/** Squirrel.Mac can only replace the app when the requirement outlives a build. */
export function canApplyUpdateInPlace(kind: MacSignatureKind): boolean {
  return kind === "identified";
}

export function describeSignatureKind(kind: MacSignatureKind): string {
  switch (kind) {
    case "identified":
      return "signed with a code-signing identity";
    case "adhoc":
      return "ad-hoc signed (no code-signing identity)";
    case "unsigned":
      return "not signed at all";
    default:
      return "of an unrecognised signing state";
  }
}

/**
 * The `.app` bundle that contains a packaged executable.
 *
 * Squirrel checks the running *bundle*, not the Mach-O inside it, so the
 * signature has to be read from the same place. Returns the executable path
 * unchanged when it is not inside a bundle, which is what an unpacked `tsc`
 * build looks like.
 */
export function macBundleRootFromExecutable(executablePath: string): string {
  const segments = executablePath.split("/");

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].endsWith(".app")) {
      return segments.slice(0, index + 1).join("/");
    }
  }

  return executablePath;
}

/**
 * The releases page to send someone to, read from the updater feed so it cannot
 * disagree with where the app actually looks for updates.
 */
export function releasesPageUrlFromFeed(appUpdateYml: string | null): string {
  if (!appUpdateYml) {
    return RELEASES_PAGE_FALLBACK;
  }

  const owner = /^\s*owner:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m.exec(appUpdateYml);
  const repo = /^\s*repo:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m.exec(appUpdateYml);

  if (!owner || !repo) {
    return RELEASES_PAGE_FALLBACK;
  }

  return `https://github.com/${owner[1]}/${repo[1]}/releases/latest`;
}

export type CodesignRunner = (args: Array<string>) => Promise<CodesignOutput>;

/**
 * Read the running bundle's signing state. Never throws: a `codesign` that
 * cannot be run at all is `unknown`, which degrades to a manual download.
 */
export async function detectMacSignatureKind(
  bundlePath: string,
  runCodesign: CodesignRunner,
): Promise<MacSignatureKind> {
  try {
    const output = await runCodesign([...CODESIGN_DISPLAY_ARGS, bundlePath]);
    return classifyCodesignOutput(output);
  } catch {
    return "unknown";
  }
}
