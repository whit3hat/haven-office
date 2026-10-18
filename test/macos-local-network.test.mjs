import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_NETWORK_USAGE_DESCRIPTION,
  LOCAL_NETWORK_USAGE_KEY,
  assertLocalNetworkUsageDescription,
  readInfoPlistString,
} from "../scripts/macos-info-plist.mjs";
import { buildStageConfig } from "../scripts/release-macos-local.mjs";

const projectRoot = new URL("..", import.meta.url).pathname;

function makeApp(plistBody) {
  const root = mkdtempSync(join(tmpdir(), "haven-plist-"));
  const appPath = join(root, "Haven Office.app");
  mkdirSync(join(appPath, "Contents"), { recursive: true });
  if (plistBody !== null) {
    writeFileSync(join(appPath, "Contents", "Info.plist"), plistBody, "utf8");
  }
  return { root, appPath };
}

function xmlPlist(entries) {
  const body = Object.entries(entries)
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

test("a packed app that declares the purpose string is accepted", () => {
  const { root, appPath } = makeApp(
    xmlPlist({
      CFBundleIdentifier: "xyz.havenco.office",
      [LOCAL_NETWORK_USAGE_KEY]: LOCAL_NETWORK_USAGE_DESCRIPTION,
    }),
  );

  try {
    const result = assertLocalNetworkUsageDescription({ appPath });
    assert.equal(result.key, LOCAL_NETWORK_USAGE_KEY);
    assert.equal(result.value, LOCAL_NETWORK_USAGE_DESCRIPTION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the defect itself: an app with no purpose string is rejected by name", () => {
  const { root, appPath } = makeApp(xmlPlist({ CFBundleIdentifier: "xyz.havenco.office" }));

  try {
    assert.throws(
      () => assertLocalNetworkUsageDescription({ appPath }),
      (error) =>
        error instanceof Error
        && error.message.includes(LOCAL_NETWORK_USAGE_KEY)
        && /Local Network/.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty purpose string is rejected — the key alone is not the contract", () => {
  const { root, appPath } = makeApp(
    xmlPlist({ [LOCAL_NETWORK_USAGE_KEY]: "   " }),
  );

  try {
    assert.throws(() => assertLocalNetworkUsageDescription({ appPath }), /is missing from/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plist mentioning the key only inside another value does not count", () => {
  // Guards the obvious lazy implementation: a substring search over the file
  // would pass here, and the purpose string itself talks about local networks.
  const { root, appPath } = makeApp(
    xmlPlist({ CFBundleGetInfoString: `see ${LOCAL_NETWORK_USAGE_KEY} docs` }),
  );

  try {
    assert.throws(() => assertLocalNetworkUsageDescription({ appPath }), /is missing from/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unparseable plist raises rather than reporting absent or present", () => {
  const { root, appPath } = makeApp("this is not a plist at all\n");

  try {
    assert.throws(
      () => readInfoPlistString(join(appPath, "Contents", "Info.plist"), LOCAL_NETWORK_USAGE_KEY),
      /neither an XML nor a binary plist/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both signing paths of the generated mac config declare the purpose string", () => {
  // The plugins defect in v2026.10.6 was exactly this: the reviewed config and
  // the config that ships were different files. buildStageConfig is the one
  // that builds every published .dmg.
  for (const signingInfo of [{ adhoc: true }, { adhoc: false, identity: "Developer ID Application: x" }]) {
    for (const arch of ["arm64", "x64"]) {
      const config = buildStageConfig(arch, signingInfo);
      assert.equal(
        config.mac.extendInfo?.[LOCAL_NETWORK_USAGE_KEY],
        LOCAL_NETWORK_USAGE_DESCRIPTION,
        `missing ${LOCAL_NETWORK_USAGE_KEY} for ${arch} adhoc=${signingInfo.adhoc}`,
      );
    }
  }
});

test("the root electron-builder.yml declares the same purpose string", () => {
  // Two configs drifting apart is the defect class this repo already shipped
  // once. Compared literally rather than merely checked for presence.
  const yml = readFileSync(join(projectRoot, "electron-builder.yml"), "utf8");
  const match = /NSLocalNetworkUsageDescription:\s*>-\n([\s\S]*?)\n\s*entitlements:/.exec(yml);
  assert.ok(match, "NSLocalNetworkUsageDescription folded block not found in electron-builder.yml");

  const folded = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  assert.equal(folded, LOCAL_NETWORK_USAGE_DESCRIPTION);
});
