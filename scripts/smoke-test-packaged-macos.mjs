#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  assertBundledPluginsInstalled,
  assertTrayAssetsStaged,
  assertTrayReady,
} from "./packaged-smoke-assertions.mjs";
import { formatFailureDetail } from "./smoke-output-diagnostics.mjs";
import { bundledPluginVersions } from "./stage-plugins.mjs";

const args = process.argv.slice(2);
const appPath = takeOption("--app");
const timeoutMs = Number.parseInt(takeOption("--timeout-ms") || "90000", 10);
// Every byte the app wrote, kept whether or not the run passed. The failure
// message quotes the lines that matter; this is for the ones nobody predicted.
const outputLogPath = path.resolve(takeOption("--output-log") || "smoke-app-output.log");
// Plugin provisioning starts only once the server is healthy and then installs
// from a local path, so it gets its own budget rather than eating the startup
// one. Separate numbers also keep the failure message honest about which half
// ran out of time.
const pluginTimeoutMs = Number.parseInt(takeOption("--plugin-timeout-ms") || "180000", 10);
// The tray is built on the connection-boot path, so its line arrives after the
// server is healthy. Its own budget, for the same reason plugin provisioning
// has one: a shared number makes the failure message lie about which half ran
// out of time.
const trayTimeoutMs = Number.parseInt(takeOption("--tray-timeout-ms") || "60000", 10);
const keepData = hasFlag("--keep-data");

if (!appPath) {
  fail("Missing --app '/path/to/Haven Office.app' or packaged executable.");
}

const executablePath = resolveExecutable(appPath);
if (!existsSync(executablePath)) {
  fail(`Packaged executable does not exist: ${executablePath}`);
}

// Before spending a runner on launching the app: a bundle check needs nothing
// running, and a missing menu-bar icon is cheaper to report here than to infer
// from an app that started normally and showed nothing.
try {
  assertTrayAssetsStaged({ appPath });
} catch (error) {
  fail(error.message);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-packaged-smoke-"));
const userDataDir = path.join(tempRoot, "user-data");
const paperclipHome = path.join(tempRoot, "paperclip-home");
mkdirSync(userDataDir, { recursive: true });
mkdirSync(paperclipHome, { recursive: true });
seedLocalAutoStart(userDataDir);

const outputChunks = [];
let child = null;
let settled = false;
let verified = false;

try {
  const result = await runSmokeTest();
  console.log(`[smoke-macos] Packaged app started local server on ${result.url}`);
  console.log(`[smoke-macos] Isolated userData: ${userDataDir}`);
  console.log(`[smoke-macos] Isolated PAPERCLIP_HOME: ${paperclipHome}`);
} finally {
  await stopChild();
  // Before the temp tree goes: a failing run's most useful artifact is the
  // output the failure message had to summarise.
  writeOutputLog();
  if (!keepData) {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.log(`[smoke-macos] Kept smoke-test data: ${tempRoot}`);
  }
}

function takeOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function hasFlag(name) {
  return args.includes(name);
}

function resolveExecutable(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!resolved.endsWith(".app")) {
    return resolved;
  }

  const macosDir = path.join(resolved, "Contents", "MacOS");
  const entries = readdirSync(macosDir).filter((entry) => !entry.startsWith("."));
  if (entries.length !== 1) {
    fail(`Expected exactly one executable under ${macosDir}.`);
  }
  return path.join(macosDir, entries[0]);
}

function seedLocalAutoStart(targetUserDataDir) {
  const connectionsFile = {
    version: 1,
    state: {
      activeProfileId: "local_embedded",
      alwaysShowChooser: false,
      autoConnectLastProfile: true,
      chooserMode: "local_embedded",
      localProfileName: "Local",
      localLastHealth: "healthy",
    },
    remoteProfiles: [],
  };

  writeFileSync(
    path.join(targetUserDataDir, "connections.json"),
    `${JSON.stringify(connectionsFile, null, 2)}\n`,
    "utf8",
  );
}

function runSmokeTest() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for packaged server startup.\n${tailOutput()}`));
    }, timeoutMs);

    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    child = spawn(executablePath, [], {
      env: {
        ...childEnv,
        PAPERCLIP_DESKTOP_REQUIRE_ISOLATED_DATA: "1",
        PAPERCLIP_DESKTOP_USER_DATA_DIR: userDataDir,
        PAPERCLIP_HOME: paperclipHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      handleOutput(chunk, resolve, reject, timeout);
    });
    child.stderr.on("data", (chunk) => {
      handleOutput(chunk, resolve, reject, timeout);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (verified) return;
      clearTimeout(timeout);
      const phase = settled ? "while its endpoints were being verified" : "before server startup";
      reject(new Error(`Packaged app exited ${phase} (code=${code}, signal=${signal}).\n${tailOutput()}`));
    });
  });
}

function handleOutput(chunk, resolve, reject, timeout) {
  const text = chunk.toString();
  outputChunks.push(text);
  const output = outputChunks.join("");

  const productionPath = findProductionPathLeak(output);
  if (productionPath) {
    clearTimeout(timeout);
    reject(new Error(`Packaged smoke test touched or logged production data path: ${productionPath}\n${tailOutput()}`));
    return;
  }

  const match = output.match(
    /(?:Server listening on|Server startup recovery complete on)\s+(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)/,
  );
  if (!match || settled) {
    return;
  }

  settled = true;
  // The startup race is over; endpoint verification carries its own deadlines,
  // and plugin provisioning can legitimately outlast the startup budget.
  clearTimeout(timeout);
  const port = Number.parseInt(match[1], 10);
  const url = `http://127.0.0.1:${port}`;
  void verifyServerEndpoints(url)
    .then(() => {
      verified = true;
      resolve({ url });
    })
    .catch((error) => {
      verified = true;
      reject(new Error(`Server started but smoke endpoint failed: ${error.message}\n${tailOutput()}`));
    });
}

async function verifyServerEndpoints(url) {
  await requestOk(`${url}/get-session`);
  await requestNonEmptyJsonArray(`${url}/api/skills/catalog`);
  await requestNonEmptyJsonArray(`${url}/api/teams/catalog`);

  // The menu-bar item is built once the connection boots, which is the first
  // point at which the app has an origin to poll. Checked before the plugin
  // wait because it resolves in seconds and its failure is unambiguous.
  await assertTrayReady({
    readOutput: () => outputChunks.join(""),
    timeoutMs: trayTimeoutMs,
  });

  // The office is the view the app opens on, and it 404s unless the bundled
  // plugin was installed into this profile. Provisioning is deliberately
  // non-fatal, so a server that answers every endpoint above can still have
  // no office — nothing in CI noticed that until a human install did.
  await assertBundledPluginsInstalled({
    origin: url,
    plugins: bundledPluginVersions,
    timeoutMs: pluginTimeoutMs,
  });
}

function findProductionPathLeak(output) {
  for (const candidate of productionPaperclipDataPaths()) {
    if (output.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

function productionPaperclipDataPaths() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Haven Office"),
      path.join(home, "Library", "Application Support", "Paperclip"),
      path.join(home, ".paperclip"),
    ];
  }
  return [path.join(home, ".paperclip")];
}

function requestOk(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 10_000 }, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`${url} returned HTTP ${response.statusCode}`));
      }
    });
    request.on("timeout", () => {
      request.destroy(new Error(`${url} timed out`));
    });
    request.on("error", reject);
  });
}

function requestNonEmptyJsonArray(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 10_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${url} returned HTTP ${response.statusCode}`));
          return;
        }

        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!Array.isArray(payload) || payload.length === 0) {
            reject(new Error(`${url} did not return a non-empty JSON array`));
            return;
          }
          resolve();
        } catch (error) {
          reject(new Error(`${url} returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`${url} timed out`));
    });
    request.on("error", reject);
  });
}

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

/**
 * The detail block appended to every failure.
 *
 * Was a bare 80-line tail, which is why the v2026.10.10 plugin failure reported
 * that no plugin was installed without reporting the `[plugins]` line that said
 * why: three minutes of per-request server logging had pushed it out of the
 * window. See scripts/smoke-output-diagnostics.mjs.
 */
function tailOutput() {
  return formatFailureDetail(outputChunks.join(""), { logPath: outputLogPath });
}

function writeOutputLog() {
  const output = outputChunks.join("");
  if (output.length === 0) {
    return;
  }

  try {
    writeFileSync(outputLogPath, output, "utf8");
    console.log(`[smoke-macos] Full app output: ${outputLogPath}`);
  } catch (error) {
    // Never turn a reporting problem into the reported problem.
    console.error(`[smoke-macos] Could not write ${outputLogPath}: ${error.message}`);
  }
}

function fail(message) {
  console.error(`[smoke-macos] ${message}`);
  process.exit(1);
}
