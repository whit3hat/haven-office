import { createHash } from "node:crypto";
import { normalizeRemoteUrl } from "./validate";
import type { ConnectionMode, ConnectionProfile } from "./types";

export interface WindowPolicy {
  mode: ConnectionMode;
  startUrl: string;
  allowedOrigin: string;
  partition: string;
  preloadPath?: string;
}

export function isNavigationAllowed(targetUrl: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    return parsed.origin === allowedOrigin;
  } catch {
    return false;
  }
}

export function shouldOpenExternally(targetUrl: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.origin === allowedOrigin) {
      return false;
    }

    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function remotePartitionForProfile(profileId: string): string {
  return `persist:paperclip-remote-${profileId}`;
}

/**
 * The partition an unsaved remote gets: keyed on the origin, so a typed URL
 * keeps its own cookie jar rather than sharing one with every other ad-hoc
 * connection.
 */
export function remotePartitionForOrigin(origin: string): string {
  const hash = createHash("sha256").update(origin).digest("hex").slice(0, 12);
  return `persist:paperclip-remote-${hash}`;
}

/** A saved profile owns its jar; anything else is keyed on the origin. */
export function remotePartitionKey(profileId: string | null, origin: string): string {
  return profileId ? remotePartitionForProfile(profileId) : remotePartitionForOrigin(origin);
}

/**
 * The saved profile that unambiguously owns a remote URL's origin, if any.
 *
 * Verifying and connecting have to read the same cookie jar, and for a host the
 * user has already saved and signed in to, that jar is the profile's — the
 * origin partition is empty, so probing it reports a signed-in user as signed
 * out. A typed URL therefore adopts the saved profile for its origin.
 *
 * Two profiles on one origin (a duplicate, or two accounts on one host) own
 * nothing between them: picking either would silently choose an account. Those
 * fall back to the origin partition, and the user picks from the saved list,
 * where the profile is explicit.
 */
export function savedProfileIdForRemoteUrl(input: {
  remoteUrl: string;
  profiles: readonly ConnectionProfile[];
}): string | null {
  let origin: string;
  try {
    origin = normalizeRemoteUrl(input.remoteUrl).origin;
  } catch {
    return null;
  }

  const owners = input.profiles.filter((profile) => {
    if (profile.mode !== "remote_existing" || !profile.remoteUrl) {
      return false;
    }

    try {
      return normalizeRemoteUrl(profile.remoteUrl).origin === origin;
    } catch {
      return false;
    }
  });

  return owners.length === 1 ? owners[0].id : null;
}

export function localPartition(): string {
  return "persist:paperclip-local";
}
