#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LOCAL_NETWORK_USAGE_DESCRIPTION, LOCAL_NETWORK_USAGE_KEY } from "./macos-info-plist.mjs";
import { TRAY_TEMPLATE_ASSETS } from "./packaged-smoke-assertions.mjs";
import { assertBundledPluginsPresent, bundledPluginVersions } from "./stage-plugins.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");
const rootPackageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));

const DEFAULT_ARCHES = ["x64", "arm64"];
const PRODUCT_NAME = "Haven Office";
const APP_ID = "xyz.havenco.haven-office";
const COPYRIGHT = "Copyright © 2026 havenCo. Based on aronprins/paperclip-desktop, © 2026 Aron Prins (MIT).";
const PUBLISH_OWNER = "whit3hat";
const PUBLISH_REPO = "haven-office";
// app-builder-lib treats the identity "-" as an ad-hoc signature.
const ADHOC_IDENTITY = "-";

const args = process.argv.slice(2);

function takeOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function hasFlag(name) {
  return args.includes(name);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

// macOS ships a 256-descriptor soft limit per process, and electron-builder
// walks the whole staged tree in parallel while it writes the dmg and the
// updater zip. A bundle this size — embedded Postgres, the agent SDKs, the
// server's own node_modules — exhausts it: `Release Desktop` #2 died with
// `EMFILE: too many open files` immediately after the ad-hoc signature landed.
//
// Node cannot raise its own rlimit, so the packaging child is spawned through a
// shell that walks the soft limit up to whatever the hard limit allows first.
// A child inherits the raised limit; everything else about the call is
// unchanged, and `"$@"` hands the argv over without a quoting round-trip.
const FILE_LIMIT_LADDER = [65536, 32768, 16384, 8192, 4096, 2048];

const RAISE_FILE_LIMIT_SH = `
for limit in ${FILE_LIMIT_LADDER.join(" ")}; do
  if ulimit -n "$limit" 2>/dev/null; then break; fi
done
echo "[release-local] file descriptor soft limit: $(ulimit -n)"
exec "$@"
`.trim();

export function withRaisedFileLimit(command, commandArgs, { platform = process.platform } = {}) {
  // Only macOS sets the limit low enough to matter; Linux runners start at
  // 65536 and the indirection would just obscure the failing command.
  if (platform !== "darwin") return { command, commandArgs };

  // The literal `sh` is $0 for the inline script, so the real argv starts at $1.
  return { command: "/bin/sh", commandArgs: ["-c", RAISE_FILE_LIMIT_SH, "sh", command, ...commandArgs] };
}

function runQuiet(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: projectRoot,
    ...options,
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${commandArgs.join(" ")} failed.\n${output}`);
  }

  return result.stdout ?? "";
}

function parseTeamId(identityName) {
  return identityName.match(/\(([A-Z0-9]+)\)\s*$/)?.[1] ?? null;
}

function findKeychainCodesigningIdentities() {
  const output = runQuiet("security", ["find-identity", "-v", "-p", "codesigning"]);
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+\)\s+[0-9A-F]+\s+"(.+)"\s*$/))
    .filter(Boolean)
    .map((match) => match[1])
    .filter((name) => name.startsWith("Developer ID Application: "));
}

/**
 * macOS signing for Haven Office has two paths, because an Apple Developer ID
 * is a board decision that may not have landed yet (HAV-32):
 *
 *   signed   — an explicit `APPLE_CODESIGN_IDENTITY`/`CSC_NAME`, or exactly one
 *              "Developer ID Application" identity in the active keychain.
 *              Hardened runtime on, entitlements applied, notarization handled
 *              afterwards by `notarize-submit.yml`.
 *   unsigned — `ALLOW_UNSIGNED_MACOS_BUILD=true` with no explicit identity. The
 *              app is still *ad-hoc* signed (`codesign --sign -`): a bundle with
 *              no signature at all refuses to launch on Apple Silicon, while an
 *              ad-hoc one launches behind the ordinary Gatekeeper "unidentified
 *              developer" warning. Hardened runtime, entitlements and secure
 *              timestamps are off on this path — all three need a real identity.
 *
 * An explicit identity always wins, so setting `ALLOW_UNSIGNED_MACOS_BUILD` on a
 * machine that does have a Developer ID cannot silently downgrade a real release.
 */
export function resolveMacSigningIdentity({
  env = process.env,
  listCodesigningIdentities = findKeychainCodesigningIdentities,
} = {}) {
  const explicitIdentity = env.APPLE_CODESIGN_IDENTITY?.trim() || env.CSC_NAME?.trim() || "";
  const explicitTeamId = env.APPLE_TEAM_ID?.trim() || null;

  if (explicitIdentity) {
    return {
      name: explicitIdentity,
      teamId: explicitTeamId || parseTeamId(explicitIdentity),
      adhoc: false,
    };
  }

  if (env.ALLOW_UNSIGNED_MACOS_BUILD === "true") {
    return { name: null, teamId: null, adhoc: true };
  }

  const identities = listCodesigningIdentities();

  const matchingIdentities = explicitTeamId
    ? identities.filter((name) => name.includes(`(${explicitTeamId})`))
    : identities;

  if (matchingIdentities.length === 0) {
    throw new Error(
      "No Developer ID Application signing identity found in the active keychain. " +
      "Set ALLOW_UNSIGNED_MACOS_BUILD=true to build an explicitly unsigned, ad-hoc signed app instead.",
    );
  }

  if (matchingIdentities.length > 1) {
    throw new Error(
      `Multiple Developer ID Application identities found (${matchingIdentities.join(", ")}). Set APPLE_CODESIGN_IDENTITY explicitly.`,
    );
  }

  return {
    name: matchingIdentities[0],
    teamId: explicitTeamId || parseTeamId(matchingIdentities[0]),
    adhoc: false,
  };
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function removeGeneratedMetadata(dir) {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;

    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      removeGeneratedMetadata(full);
      continue;
    }

    if (entry === ".DS_Store" || entry === "builder-debug.yml") {
      rmSync(full, { force: true });
    }
  }
}

function removeBrokenSymlinks(dir) {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;

    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) {
      try {
        const target = readlinkSync(full);
        const resolved = target.startsWith("/") ? target : join(dir, target);
        if (!existsSync(resolved)) {
          rmSync(full, { force: true });
        }
      } catch {
        rmSync(full, { force: true });
      }
      continue;
    }

    if (stat.isDirectory()) {
      removeBrokenSymlinks(full);
    }
  }
}

function pruneNodeBinShims(dir) {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;

    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;

    if (entry === ".bin" && full.includes("/node_modules/")) {
      rmSync(full, { recursive: true, force: true });
      continue;
    }

    pruneNodeBinShims(full);
  }
}

function relativizeCopiedSymlinks(dir, sourceRoot, targetRoot) {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;

    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) {
      const target = readlinkSync(full);
      if (target.startsWith(sourceRoot)) {
        const mappedTarget = join(targetRoot, target.slice(sourceRoot.length).replace(/^\/+/, ""));
        const relativeTarget = relative(dirname(full), mappedTarget) || ".";
        rmSync(full, { force: true });
        symlinkSync(relativeTarget, full);
      }
      continue;
    }

    if (stat.isDirectory()) {
      relativizeCopiedSymlinks(full, sourceRoot, targetRoot);
    }
  }
}

function copyReleaseContents(fromDir, toDir) {
  ensureDir(toDir);
  for (const entry of readdirSync(fromDir)) {
    run("ditto", [join(fromDir, entry), join(toDir, entry)]);
  }
}

function generateIcns(sourcePng, targetIcns, stageRoot) {
  const iconsetDir = join(stageRoot, "icon.iconset");
  ensureDir(iconsetDir);

  for (const size of [16, 32, 128, 256, 512]) {
    run("sips", ["-z", String(size), String(size), sourcePng, "--out", join(iconsetDir, `icon_${size}x${size}.png`)]);
    const retinaSize = size * 2;
    run(
      "sips",
      [
        "-z",
        String(retinaSize),
        String(retinaSize),
        sourcePng,
        "--out",
        join(iconsetDir, `icon_${size}x${size}@2x.png`),
      ],
    );
  }

  run("iconutil", ["-c", "icns", iconsetDir, "-o", targetIcns]);
}

function buildStagePackageJson() {
  const runtimeDependencies = Object.fromEntries(
    Object.keys(rootPackageJson.dependencies ?? {}).map((name) => {
      const installed = JSON.parse(
        readFileSync(join(projectRoot, "node_modules", ...name.split("/"), "package.json"), "utf8"),
      );
      return [name, installed.version];
    }),
  );

  return {
    name: rootPackageJson.name,
    version: rootPackageJson.version,
    private: true,
    description: rootPackageJson.description,
    author: rootPackageJson.author,
    homepage: rootPackageJson.homepage,
    main: "dist/main.js",
    dependencies: runtimeDependencies,
  };
}

export function buildStageConfig(arch, signingInfo) {
  const macSigning = signingInfo.adhoc
    ? {
        // Ad-hoc signature. Hardened runtime stays off: with library validation
        // on, an ad-hoc signed app refuses to load the ad-hoc signed `.node`
        // bindings under Resources/app-server. `timestamp: "none"` is required
        // too — codesign cannot reach a timestamp authority without a real
        // identity, and @electron/osx-sign passes a bare `--timestamp` by default.
        identity: ADHOC_IDENTITY,
        hardenedRuntime: false,
        timestamp: "none",
      }
    : {
        hardenedRuntime: true,
        entitlements: "build/entitlements.mac.plist",
        entitlementsInherit: "build/entitlements.mac.inherit.plist",
      };

  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    copyright: COPYRIGHT,
    afterPack: join(projectRoot, "scripts", "stage-after-pack.mjs"),
    directories: {
      output: "release",
      buildResources: "build",
    },
    files: [
      "dist/**/*",
      "package.json",
    ],
    extraResources: [
      {
        from: "app-server/server",
        to: "app-server/server",
        filter: ["**/*"],
      },
      {
        from: "app-server/node-bin",
        to: "app-server/node-bin",
        filter: ["**/*"],
      },
      // Plugins preinstalled into the local server on first launch. This entry
      // was missing until v2026.10.9: the repo-level electron-builder.yml had
      // it, but the staged macOS build generates its own config and this is
      // the file that builds every .dmg we publish. Without it
      // `<Resources>/app-server/plugins` does not exist, readStagedPlugins
      // returns an empty list, provisioning no-ops, and the office 404s.
      // Deliberately outside app-server/packages/plugins so the server treats
      // them as ordinary local-path installs and never tries to build them
      // inside the read-only bundle.
      ...(bundledPluginVersions.length === 0
        ? []
        : [
            {
              from: "app-server/plugins",
              to: "app-server/plugins",
              filter: ["**/*"],
            },
          ]),
      // The menu-bar template icon, at the resources root rather than under
      // app-server, which is where src/main.ts's trayIconPath() looks for it.
      // Same omission as the plugins entry above and for the same reason: the
      // repo-level electron-builder.yml stages these, but this generated config
      // is what builds every published .dmg. Without them the Tray is built
      // from an empty NativeImage — a menu-bar item that exists and draws
      // nothing, reporting no error anywhere.
      ...TRAY_TEMPLATE_ASSETS.map((name) => ({ from: `build/${name}`, to: name })),
    ],
    publish: {
      provider: "github",
      owner: PUBLISH_OWNER,
      repo: PUBLISH_REPO,
      releaseType: "release",
    },
    mac: {
      category: "public.app-category.developer-tools",
      icon: "build/icon.icns",
      target: [
        {
          target: "dmg",
          arch: [arch],
        },
        {
          target: "zip",
          arch: [arch],
        },
      ],
      gatekeeperAssess: false,
      notarize: false,
      // Declares Local Network intent so macOS 15+ can list the app in
      // Privacy & Security → Local Network. Without it the app is denied
      // access to any private address and there is no row to grant — which is
      // how a remote on 192.168.4.8 read as "Host unreachable" while curl in
      // Terminal got HTTP 200 from the same Mac. See scripts/macos-info-plist.mjs.
      extendInfo: {
        [LOCAL_NETWORK_USAGE_KEY]: LOCAL_NETWORK_USAGE_DESCRIPTION,
      },
      signIgnore: [
        "/Contents/Resources/app-server/.*",
      ],
      ...macSigning,
    },
    dmg: {
      contents: [
        { x: 130, y: 220 },
        { x: 410, y: 220, type: "link", path: "/Applications" },
      ],
    },
    electronVersion: rootPackageJson.devDependencies.electron.replace(/^[^\d]*/, ""),
  };
}

function ensureProjectDependencies(skipInstall) {
  if (skipInstall) return;
  if (existsSync(join(projectRoot, "node_modules", ".bin", "electron-builder"))) {
    return;
  }

  console.log("[release-local] Installing root dependencies...");
  run("pnpm", ["install", "--frozen-lockfile"]);
}

function buildProjectArtifacts(skipBuild) {
  if (skipBuild) return;

  console.log("[release-local] Building desktop TypeScript...");
  run("pnpm", ["build"]);

  console.log("[release-local] Preparing bundled server runtimes...");
  run("pnpm", ["prepare-server"]);

  console.log("[release-local] Building bundled UI...");
  run("pnpm", ["build-ui"]);
}

function assertExists(target, label) {
  if (!existsSync(target)) {
    throw new Error(`${label} not found: ${target}`);
  }
}

function stageRuntimeFiles(stageAppDir, arch, stageRoot) {
  const buildResourcesDir = join(stageAppDir, "build");
  const stageServerDir = join(stageAppDir, "app-server", "server");
  const stageNodeDir = join(stageAppDir, "app-server", "node-bin");

  const desktopDistDir = join(projectRoot, "dist");
  const bundleServerDir = join(projectRoot, "build", "server-bundle", `mac-${arch}`, "server");
  const bundlePluginsDir = join(projectRoot, "build", "server-bundle", `mac-${arch}`, "plugins");
  const nodeRuntimeDir = join(projectRoot, "build", "node-bin", `mac-${arch}`);

  assertExists(desktopDistDir, "Desktop build output");
  assertExists(bundleServerDir, `Server bundle for mac-${arch}`);
  assertExists(nodeRuntimeDir, `Node runtime for mac-${arch}`);

  cpSync(desktopDistDir, join(stageAppDir, "dist"), { recursive: true });
  cpSync(bundleServerDir, stageServerDir, { recursive: true });
  cpSync(nodeRuntimeDir, stageNodeDir, { recursive: true });
  relativizeCopiedSymlinks(stageServerDir, bundleServerDir, stageServerDir);
  pruneNodeBinShims(stageServerDir);
  removeBrokenSymlinks(stageServerDir);

  // The bundled plugins. Fail here rather than ship an app whose office route
  // 404s: `prepare-server` stages these, and provisioning treats an absent
  // directory as "nothing to install" without an error.
  if (bundledPluginVersions.length > 0) {
    const stagePluginsDir = join(stageAppDir, "app-server", "plugins");
    assertExists(bundlePluginsDir, `Bundled plugins for mac-${arch}`);
    cpSync(bundlePluginsDir, stagePluginsDir, { recursive: true });
    assertBundledPluginsPresent({ pluginsRoot: stagePluginsDir });
    console.log(
      `[release-local] Staged ${bundledPluginVersions.length} bundled plugin(s) for preinstall: `
      + bundledPluginVersions.map(({ name, version }) => `${name}@${version}`).join(", "),
    );
  }

  ensureDir(buildResourcesDir);
  cpSync(join(projectRoot, "build", "icon.png"), join(buildResourcesDir, "icon.png"));
  // The tray's template image. buildStageConfig() stages these out of the
  // stage's own `build/` directory, so copying them is not optional.
  for (const name of TRAY_TEMPLATE_ASSETS) {
    const source = join(projectRoot, "build", name);
    assertExists(source, `Menu-bar template icon build/${name}`);
    cpSync(source, join(buildResourcesDir, name));
  }
  cpSync(join(projectRoot, "build", "entitlements.mac.plist"), join(buildResourcesDir, "entitlements.mac.plist"));
  cpSync(
    join(projectRoot, "build", "entitlements.mac.inherit.plist"),
    join(buildResourcesDir, "entitlements.mac.inherit.plist"),
  );
  generateIcns(join(buildResourcesDir, "icon.png"), join(buildResourcesDir, "icon.icns"), stageRoot);
}

function installStageRuntimeDependencies(stageAppDir) {
  console.log(`[release-local] Installing staged runtime dependencies in ${stageAppDir}...`);
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: stageAppDir,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  rmSync(join(stageAppDir, "package-lock.json"), { force: true });
}

function buildStage(stageAppDir, arch, signingInfo) {
  console.log(`[release-local] Packaging staged macOS ${arch} build...`);

  const env = { ...process.env };
  if (signingInfo.adhoc) {
    // `stage-after-pack.mjs` reads these to decide how to sign the nested
    // app-server binaries that electron-builder's `signIgnore` skips.
    env.ALLOW_UNSIGNED_MACOS_BUILD = "true";
    delete env.APPLE_CODESIGN_IDENTITY;
    delete env.CSC_NAME;
  } else {
    env.APPLE_CODESIGN_IDENTITY = signingInfo.name;
    if (signingInfo.teamId) {
      env.APPLE_TEAM_ID = signingInfo.teamId;
    }
  }
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === "") {
    delete env.CSC_IDENTITY_AUTO_DISCOVERY;
  }

  const packaging = withRaisedFileLimit("pnpm", [
    "exec",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    "--config",
    join(stageAppDir, "electron-builder.json"),
    "--mac",
    `--${arch}`,
    "--publish",
    "never",
  ]);

  run(packaging.command, packaging.commandArgs, {
    env,
  });
}

function verifyStageArtifacts(archOutputDir, signingInfo) {
  console.log(`[release-local] Verifying staged macOS artifacts in ${archOutputDir}...`);

  const env = { ...process.env };
  if (signingInfo.adhoc) {
    // There is no identity or team to assert on the unsigned path. The rest of
    // verify-macos-release.mjs still runs: every Mach-O payload must carry a
    // valid signature, and packaged native architectures must match the
    // bundled Node binary.
    delete env.APPLE_CODESIGN_IDENTITY;
    delete env.APPLE_TEAM_ID;
  } else {
    env.APPLE_CODESIGN_IDENTITY = signingInfo.name;
    if (signingInfo.teamId) {
      env.APPLE_TEAM_ID = signingInfo.teamId;
    }
  }

  run("node", ["scripts/verify-macos-release.mjs", archOutputDir], {
    cwd: projectRoot,
    env,
  });
}

function collectArtifacts(archOutputDir) {
  return readdirSync(archOutputDir)
    .filter((entry) => !entry.endsWith(".json"))
    .map((entry) => join(archOutputDir, entry))
    .sort();
}

function buildArch(arch, outputRoot, keepStage, signingInfo) {
  const stageRoot = mkdtempSync(join(tmpdir(), `paperclip-macos-stage-${arch}-`));
  const stageAppDir = join(stageRoot, "app");
  const archOutputDir = join(outputRoot, arch);

  rmSync(archOutputDir, { recursive: true, force: true });
  ensureDir(stageAppDir);

  try {
    console.log(`[release-local] Staging macOS ${arch} app in ${stageRoot}...`);
    stageRuntimeFiles(stageAppDir, arch, stageRoot);

    writeFileSync(
      join(stageAppDir, "package.json"),
      `${JSON.stringify(buildStagePackageJson(), null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(stageAppDir, "electron-builder.json"),
      `${JSON.stringify(buildStageConfig(arch, signingInfo), null, 2)}\n`,
      "utf8",
    );

    installStageRuntimeDependencies(stageAppDir);
    buildStage(stageAppDir, arch, signingInfo);

    const stageReleaseDir = join(stageAppDir, "release");
    assertExists(stageReleaseDir, `Release output for ${arch}`);
    copyReleaseContents(stageReleaseDir, archOutputDir);
    removeGeneratedMetadata(archOutputDir);
    verifyStageArtifacts(archOutputDir, signingInfo);

    const stageManifest = {
      arch,
      stageRoot,
      stageAppDir,
      outputDir: archOutputDir,
      kept: keepStage,
    };
    writeFileSync(join(archOutputDir, "stage-manifest.json"), `${JSON.stringify(stageManifest, null, 2)}\n`, "utf8");

    return {
      arch,
      outputDir: archOutputDir,
      stageRoot,
      artifacts: collectArtifacts(archOutputDir),
    };
  } finally {
    if (!keepStage) {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

function resolveArches() {
  const arch = takeOption("--arch");
  if (!arch) return DEFAULT_ARCHES;
  if (!DEFAULT_ARCHES.includes(arch)) {
    throw new Error(`Unsupported arch '${arch}'. Expected one of: ${DEFAULT_ARCHES.join(", ")}.`);
  }
  return [arch];
}

function main() {
  const arches = resolveArches();
  const outputRoot = resolve(projectRoot, takeOption("--output-root") || "release/local-macos");
  const keepStage = hasFlag("--keep-stage");
  const skipInstall = hasFlag("--skip-install");
  const skipBuild = hasFlag("--skip-build");
  const signingInfo = resolveMacSigningIdentity();

  ensureProjectDependencies(skipInstall);
  buildProjectArtifacts(skipBuild);

  if (signingInfo.adhoc) {
    console.log(
      "[release-local] UNSIGNED BUILD: no Apple identity, using an ad-hoc signature. " +
      "macOS will warn that the app is from an unidentified developer on first open.",
    );
  } else {
    console.log(`[release-local] Using macOS signing identity: ${signingInfo.name}`);
    if (signingInfo.teamId) {
      console.log(`[release-local] Using Apple team ID: ${signingInfo.teamId}`);
    }
  }

  const results = [];
  for (const arch of arches) {
    results.push(buildArch(arch, outputRoot, keepStage, signingInfo));
  }

  console.log("[release-local] Built staged macOS artifacts:");
  for (const result of results) {
    console.log(`[release-local]   ${result.arch}: ${result.outputDir}`);
    for (const artifact of result.artifacts) {
      console.log(`[release-local]     - ${artifact}`);
    }
    if (keepStage) {
      console.log(`[release-local]     stage: ${result.stageRoot}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
