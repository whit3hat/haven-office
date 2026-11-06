/**
 * Verify Remote against a redirecting host, on Chromium, without a human.
 *
 * This is docs/paperclip-data-layer.md § 4 item 5. It asks one thing: when
 * `/api/health` answers a 3xx, does Verify Remote report the redirect target,
 * or does it collapse a declined redirect into "host unreachable"? The answer
 * lives in Electron's net stack, so it cannot be settled by `node --test` —
 * test/manual-redirect-fetch.test.mjs drives a fake ClientRequest and proves
 * our half only. For two weeks this item sat on an owner check for that reason.
 * It did not need one: Electron will run headless and answer it in a second.
 *
 * CommonJS on purpose. This is an Electron main entry and it loads `dist/`,
 * which tsc emits as CommonJS; the rest of scripts/ is .mjs and stays that way.
 *
 *   pnpm verify:redirect
 *   pnpm verify:redirect -- --target=http://my-proxy.example
 *
 * Linux needs a Chromium sysroot and the headless Ozone backend; see
 * § "Running the redirect check off a Mac" in docs/paperclip-data-layer.md.
 *
 * Exit 0 = item 5 passes. Exit 1 = it regressed, and the printed sentence is
 * what the owner's badge would say.
 */
const { app, net: electronNet, session } = require("electron");

const {
  createManualRedirectFetch,
} = require("../dist/connection/manual-redirect-fetch");
const {
  createPartitionProbeFetch,
} = require("../dist/connection/partition-probe-fetch");
const { preflightRemoteConnection } = require("../dist/connection/preflight");
const { partitionCookieReader } = require("../dist/paperclip/electron");
const {
  remotePartitionKey,
  savedProfileIdForRemoteUrl,
} = require("../dist/connection/window-policy");
const {
  ConnectionStore,
  getConnectionsFilePath,
} = require("../dist/connection/profiles");

/**
 * A host that redirects `/api/health` and is deliberately *not* a saved remote:
 * a saved profile would put the probe and the window on different cookie jars
 * and the result would stop transferring between builds. Overridable because
 * the check is about the behaviour, not about this URL.
 */
const DEFAULT_TARGET = "http://github.com";

const target =
  process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
  ?? process.env.HAVEN_REDIRECT_PROBE_TARGET
  ?? DEFAULT_TARGET;

/**
 * The platform whose wording we want. A transport failure is described
 * differently on macOS (the Local Network hint), and the owner reads the macOS
 * one, so report that regardless of where this runs.
 */
const platform = process.env.HAVEN_REDIRECT_PROBE_PLATFORM ?? "darwin";

app.disableHardwareAcceleration();

const failures = [];

function check(ok, description, detail) {
  console.log(`${ok ? "pass" : "FAIL"}  ${description}`);
  if (detail) {
    console.log(`      ${detail}`);
  }
  if (!ok) {
    failures.push(description);
  }
}

app.whenReady()
  .then(async () => {
    const origin = new URL(target).origin;

    // Exactly what main.ts does in buildPreflightTransports: a typed remote
    // with no saved profile resolves to null, and so to the origin-hash
    // partition. Asserted rather than assumed, because the whole "this answer
    // transfers between builds" argument rests on it.
    //
    // The real saved list, not `[]`: if the target happens to be a saved remote
    // on *this* machine, the probe and the window would read different cookie
    // jars and the result would stop transferring. That is a property of the
    // machine, so it has to be read from the machine. A missing connections
    // file is the normal case on CI and yields the local profile only.
    const profiles = new ConnectionStore(
      getConnectionsFilePath(app.getPath("userData")),
    ).listProfiles();
    const profileId = savedProfileIdForRemoteUrl({ remoteUrl: target, profiles });
    const partition = remotePartitionKey(profileId, origin);
    const preflightSession = session.fromPartition(partition);

    console.log(
      `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} `
        + `on ${process.platform}, reporting as ${platform}`,
    );
    console.log(`target ${target}  partition ${partition}\n`);

    check(
      profileId === null,
      "the target is not a saved remote, so the answer transfers between builds",
      `${profiles.length} saved profile(s); savedProfileIdForRemoteUrl -> `
        + `${JSON.stringify(profileId)}`,
    );

    const health = createManualRedirectFetch({
      createRequest: ({ method, url, redirect }) =>
        electronNet.request({ method, url, redirect, session: preflightSession }),
    });
    const probe = createPartitionProbeFetch({
      session: preflightSession,
      createRequest: (init) => electronNet.request(init),
      readCookies: partitionCookieReader(preflightSession),
    });

    // The plain health transport. This is the one whose result becomes the
    // sentence, since preflight stopped carrying credentials on /api/health.
    await expectDeclinedRedirect(health, origin, "the health transport reports the 3xx");

    // The credentialed transport against the same host. This is the
    // credentials:"include" x redirect:"manual" interaction item 5 names; it no
    // longer sits on the health probe, but it is still live on the session one.
    await expectDeclinedRedirect(
      probe,
      origin,
      'the cookie-bearing probe reports the 3xx too (credentials:"include")',
    );

    const result = await preflightRemoteConnection({
      remoteUrl: target,
      fetchImpl: health,
      sessionFetchImpl: probe,
      platform,
    });

    // The point of the whole item: a redirecting host is reachable-but-wrong,
    // not unreachable. `unreachable` here is the HAV-44 false fail.
    check(
      result.reason === "not_paperclip",
      'the failure reason is "not_paperclip", not "unreachable"',
      `reason -> ${result.reason}`,
    );

    const detail = result.detail ?? "";
    check(
      detail.includes("redirected (HTTP"),
      "the sentence names the redirect, not a dead host",
    );
    check(
      /redirected \(HTTP \d{3}\) to \S/.test(detail),
      "the sentence names where the redirect points",
    );

    console.log("\nThe sentence under the badge:");
    console.log(detail);

    if (failures.length > 0) {
      console.log(`\n${failures.length} check(s) failed. Item 5 has regressed.`);
    } else {
      console.log("\nItem 5 holds on this build.");
    }
    app.exit(failures.length > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("the probe harness itself failed:", error);
    app.exit(1);
  });

/**
 * A declined redirect must arrive as a resolved 3xx response carrying its
 * `Location`. Rejecting is the regression: that is what every build from
 * v2026.10.13 to v2026.10.14 did, for every host, because Electron 41 emits
 * `close` synchronously inside `request.end()` (see 2ab0b743).
 */
async function expectDeclinedRedirect(fetchImpl, origin, description) {
  try {
    const response = await fetchImpl(`${origin}/api/health`, { redirect: "manual" });
    const location = response.headers.get("location");
    check(
      response.status >= 300 && response.status < 400 && Boolean(location),
      description,
      `HTTP ${response.status} -> ${JSON.stringify(location)}`,
    );
  } catch (error) {
    check(false, description, `rejected instead: ${error.message}`);
  }
}
