import { isNavigationAllowed } from "./window-policy";
import type { ConnectionProfile, ConnectionState } from "./types";

// Shipped default for a havenCo install. This is configuration with a default,
// not a hardcoded path: a per-connection `companyPrefix`, the
// HAVEN_OFFICE_COMPANY_PREFIX environment variable, or `officeCompanyPrefix` in
// connections.json all override it, so the same build works against any
// Paperclip server.
export const DEFAULT_COMPANY_PREFIX = "HAV";
export const COMPANY_PREFIX_ENV_VAR = "HAVEN_OFFICE_COMPANY_PREFIX";
export const DEFAULT_DESKTOP_VIEW_KEY = "office";

const COMPANY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const MAX_VIEW_PATH_LENGTH = 512;

export interface DesktopView {
  key: string;
  label: string;
  accelerator?: string;
  pathTemplate: string;
}

// The company-scoped views the native menu offers. Adding a view is a config
// edit here, not a change to the navigation code.
export const DESKTOP_VIEWS: readonly DesktopView[] = [
  { key: "office", label: "Office", accelerator: "CmdOrCtrl+1", pathTemplate: "/{prefix}/office" },
  { key: "board", label: "Board", accelerator: "CmdOrCtrl+2", pathTemplate: "/{prefix}/issues" },
];

export function normalizeCompanyPrefix(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return COMPANY_PREFIX_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Most specific wins: the connection profile, then an explicit environment
 * override, then the persisted global setting, then the shipped default.
 */
export function resolveCompanyPrefix(input: {
  profile?: Pick<ConnectionProfile, "companyPrefix"> | null;
  state?: Pick<ConnectionState, "officeCompanyPrefix"> | null;
  env?: Record<string, string | undefined>;
}): string {
  return (
    normalizeCompanyPrefix(input.profile?.companyPrefix)
    ?? normalizeCompanyPrefix(input.env?.[COMPANY_PREFIX_ENV_VAR])
    ?? normalizeCompanyPrefix(input.state?.officeCompanyPrefix)
    ?? DEFAULT_COMPANY_PREFIX
  );
}

/**
 * Accepts only an origin-relative path. Anything that could resolve to another
 * origin (`//host`, `/\host`, an absolute URL, a scheme) is rejected here and
 * again by `resolveWithinOrigin`.
 */
export function normalizeViewPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.length > MAX_VIEW_PATH_LENGTH
    || !trimmed.startsWith("/")
    || trimmed.startsWith("//")
    || trimmed.includes("\\")
    || /[\s\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

export function desktopView(viewKey: string): DesktopView | null {
  return DESKTOP_VIEWS.find((view) => view.key === viewKey) ?? null;
}

export function desktopViewPath(viewKey: string, prefix: string): string | null {
  const view = desktopView(viewKey);
  const normalizedPrefix = normalizeCompanyPrefix(prefix);
  if (!view || !normalizedPrefix) {
    return null;
  }

  return view.pathTemplate.replace("{prefix}", normalizedPrefix);
}

/**
 * Resolves an origin-relative path against the allowed origin and re-checks it
 * with the window policy. Returns null when the result would leave the origin,
 * so every caller goes through `isNavigationAllowed` rather than around it.
 */
export function resolveWithinOrigin(viewPath: string, allowedOrigin: string): string | null {
  const normalized = normalizeViewPath(viewPath);
  if (!normalized) {
    return null;
  }

  try {
    const resolved = new URL(normalized, allowedOrigin).toString();
    return isNavigationAllowed(resolved, allowedOrigin) ? resolved : null;
  } catch {
    return null;
  }
}

export function resolveDesktopViewUrl(input: {
  allowedOrigin: string;
  prefix: string;
  viewKey: string;
}): string | null {
  const viewPath = desktopViewPath(input.viewKey, input.prefix);
  return viewPath ? resolveWithinOrigin(viewPath, input.allowedOrigin) : null;
}

/**
 * The URL the window should open on: the remembered view when there is one,
 * otherwise the office, otherwise the origin root.
 */
export function resolveStartUrl(input: {
  allowedOrigin: string;
  prefix: string;
  lastViewPath?: string | null;
}): string {
  const candidates = [
    normalizeViewPath(input.lastViewPath),
    desktopViewPath(DEFAULT_DESKTOP_VIEW_KEY, input.prefix),
    "/",
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const resolved = resolveWithinOrigin(candidate, input.allowedOrigin);
    if (resolved) {
      return resolved;
    }
  }

  return input.allowedOrigin;
}

/**
 * The storable part of a visited URL: path + query + fragment, and only when
 * the URL is inside the allowed origin. Origins are never persisted, so a
 * remembered view can never move the window to another host.
 */
export function toViewPath(targetUrl: string, allowedOrigin: string): string | null {
  if (!isNavigationAllowed(targetUrl, allowedOrigin)) {
    return null;
  }

  try {
    const parsed = new URL(targetUrl);
    return normalizeViewPath(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return null;
  }
}
