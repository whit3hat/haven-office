#!/usr/bin/env node
/**
 * Read a Paperclip attention feed through `src/paperclip/`.
 *
 * This is the worked example for the data layer, and it is runnable rather
 * than a snippet in a doc — a sample that nobody executes is a sample that
 * stops compiling. It runs on plain Node with no Electron and no display,
 * which is itself the point: the client takes an injected `fetch` and an
 * `AuthStrategy`, so the Electron session is a detail of
 * `src/paperclip/electron.ts` and not a dependency of the client.
 *
 *   pnpm build
 *   node scripts/paperclip-attention.mjs --url https://paperclip.lab.havenco.xyz \
 *     --company <companyId>
 *
 * Credentials come from the environment, never from an argument — an argument
 * lands in shell history and in `ps`:
 *
 *   PAPERCLIP_BOARD_COOKIE  a Cookie header copied from a signed-in browser
 *   PAPERCLIP_BOARD_API_KEY a board API key
 *
 * In the app neither is needed: the cookie comes out of the window's own
 * session partition and the user never handles a credential. Those variables
 * exist so this script can exercise the same code path from a terminal.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "paperclip");

let createPaperclipClient;
let strategies;
try {
  ({ createPaperclipClient } = require(path.join(dist, "client.js")));
  strategies = require(path.join(dist, "auth.js"));
} catch (error) {
  console.error("Could not load dist/paperclip. Run `pnpm build` first.");
  console.error(String(error && error.message ? error.message : error));
  process.exit(2);
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const origin = arg("url", process.env.PAPERCLIP_API_URL);
const companyId = arg("company", process.env.PAPERCLIP_COMPANY_ID);

if (!origin || !companyId) {
  console.error("Usage: node scripts/paperclip-attention.mjs --url <origin> --company <companyId>");
  process.exit(2);
}

/**
 * Pick the strategy the environment can actually satisfy.
 *
 * Same ordering the app uses: the cookie wins when there is one, because it
 * needs no setup.
 */
function resolveAuth() {
  const cookieHeader = process.env.PAPERCLIP_BOARD_COOKIE;
  const apiKey = process.env.PAPERCLIP_BOARD_API_KEY;

  if (cookieHeader) {
    // Off a Mac there is no Chromium jar to read, so stand in for it with the
    // header. In the app this reader is `partitionCookieReader(session)`.
    const cookies = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        return { name: part.slice(0, eq), value: part.slice(eq + 1) };
      });
    return strategies.sessionCookieStrategy(async () => cookies);
  }

  if (apiKey) {
    return strategies.boardApiKeyStrategy(async () => apiKey);
  }

  return strategies.firstAvailableStrategy([
    strategies.sessionCookieStrategy(async () => []),
    strategies.boardApiKeyStrategy(async () => null),
  ]);
}

const client = createPaperclipClient({
  origin,
  companyId,
  auth: resolveAuth(),
});

console.log(`Reading ${origin} as company ${companyId} via ${client.authKind}\n`);

// Decision-first, newest activity first — the ordering a menu-bar surface wants.
const result = await client.getAttention({ sort: "decide", limit: 10 });

// The whole contract: a failure is a value with a reason, never a throw. The
// reason is what a surface switches on to choose its copy.
if (!result.ok) {
  console.error(`Could not read the attention feed [${result.reason}]`);
  console.error(result.detail);
  const advice = {
    signed_out: "Sign in to Paperclip in the Haven Office window, then try again.",
    forbidden:
      "That credential authenticated but is not a board user. An agent key gets "
      + "403 here; the app has to act as the signed-in user.",
    no_credential: "Set PAPERCLIP_BOARD_COOKIE or PAPERCLIP_BOARD_API_KEY.",
    blocked_by_os: "macOS is refusing this process the local network, not the server.",
    tls_error: "The certificate was refused. Check the lab CA on this machine.",
    unreachable: "Check DNS, the VPN, and the port.",
    bad_response: "Something between here and Paperclip answered for it.",
  }[result.reason];
  if (advice) {
    console.error(`\n${advice}`);
  }
  process.exit(1);
}

const feed = result.data;
console.log(`${feed.totalCount} item(s), ${feed.deskBadgeCount} needing attention today`);
console.log(`generated ${feed.generatedAt}\n`);

for (const item of feed.items) {
  const when = item.decideBy ? `decide by ${item.decideBy}` : `active ${item.activityAt}`;
  const snoozed = item.dismissal?.isActive ? " [snoozed]" : "";
  console.log(`• [${item.severity}] ${item.subject.title ?? item.sourceKind}${snoozed}`);
  console.log(`    ${item.whyNow}`);
  console.log(`    ${when}`);
  if (item.decisionVerbs.length > 0) {
    console.log(`    actions: ${item.decisionVerbs.map((verb) => verb.label).join(" / ")}`);
  }
  // What the surface navigates to, and what it would dismiss.
  console.log(`    open: ${item.subject.href ?? "(no href)"}`);
  console.log(`    dismissalKey: ${item.dismissalKey}`);
}

if (feed.nextCursor) {
  console.log(`\nMore available: pass { cursor: "${feed.nextCursor}" }`);
}
