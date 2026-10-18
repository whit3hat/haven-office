/**
 * Staging for the plugins that get preinstalled into the bundled local server.
 *
 * Split out of prepare-server.mjs so it can be exercised on its own: the rest
 * of that script needs darwin native dependencies, this part does not, so a
 * Linux runner can still prove the layout the installer depends on. See
 * docs/local-mode-plugin.md.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Plugins preinstalled into the bundled local server, pinned here rather than
 * in devDependencies on purpose: the shell never imports them, and listing one
 * as a dependency pulls its peers (react, pixi.js) into the install tree, which
 * changes the peer set @paperclipai/server resolves with — and that server is
 * exactly what prepare-server.mjs stages. These are fetched straight from the
 * registry with `npm pack`, so they never enter node_modules. Adding one is an
 * edit to this list; docs/local-mode-plugin.md has the contract it must meet.
 */
export const bundledPluginVersions = [
  { name: "paperclip-office", version: "0.1.2", migrationsDir: "migrations" },
];

/**
 * Written into a declared migrations directory that ships no `.sql` files.
 *
 * The server resolves `database.migrationsDir` and `readdir`s it during install
 * (plugin-database.js listSqlMigrationFiles). It only ever reads `*.sql`, so
 * this file is inert — but the directory has to *exist*, and
 * paperclip-office@0.1.2 ships `migrations/` holding nothing but `.gitkeep`.
 * A directory whose only member is a dotfile does not reliably survive four
 * copy hops and a zip: electron-builder lists `.gitkeep` in its own
 * `excludedNames`, which is a fair warning that tooling filters exactly this
 * name, and nothing anywhere creates an empty directory for you.
 *
 * So the directory is given a member that survives rather than hoping the
 * dotfile does. The name is deliberately not a dotfile and carries no extension
 * in electron-builder's `excludedExts`.
 */
const MIGRATIONS_PLACEHOLDER_NAME = "KEEP-DIRECTORY.md";
const MIGRATIONS_PLACEHOLDER_BODY = `# Keep this directory

This plugin declares \`database.migrationsDir\` but ships no \`.sql\` migrations.
The bundled server \`readdir\`s this directory while installing the plugin and
fails the whole install with \`ENOENT ... scandir\` if it is missing, so the
directory must exist inside the packaged app even when it is logically empty.

Upstream keeps it with a \`.gitkeep\`, which does not reliably survive packaging.
Only \`*.sql\` files are ever read, so this file has no runtime effect.
Written by scripts/stage-plugins.mjs.
`;

/** `.sql` is the only extension the server's migration loader reads. */
function hasSqlMigrations(migrationsPath) {
  try {
    return readdirSync(migrationsPath).some((entry) => entry.endsWith(".sql"));
  } catch {
    return false;
  }
}

/**
 * Download each plugin's published tarball into `downloadDir` and extract it to
 * `<downloadDir>/<name>`.
 *
 * `npm pack` is used rather than `npm install` on purpose: the published
 * tarball is exactly the package's `files` whitelist, every entrypoint is
 * already an esbuild bundle with no bare runtime imports, and its declared
 * `dependencies` are compiled in. Installing would add a node_modules tree the
 * plugin never loads, and would drag the plugin's peers into this project's
 * dependency graph.
 */
export function fetchBundledPluginPackages({
  downloadDir,
  cwd,
  plugins = bundledPluginVersions,
  log = console.log,
}) {
  mkdirSync(downloadDir, { recursive: true });

  for (const { name, version } of plugins) {
    log(`[prepare-server] Downloading plugin ${name}@${version}...`);
    const packed = execFileSync(
      "npm",
      ["pack", `${name}@${version}`, "--pack-destination", downloadDir, "--json"],
      { cwd, encoding: "utf8" },
    );
    const [entry] = JSON.parse(packed);
    const tarball = path.join(downloadDir, entry.filename);

    const extractDir = path.join(downloadDir, name);
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", extractDir, "--strip-components=1"], {
      stdio: "inherit",
    });
    rmSync(tarball, { force: true });
  }

  return downloadDir;
}

/**
 * Assert that `pluginDir` holds the plugin layout the server's local-path
 * installer requires: a package.json at the pinned name and version whose
 * `paperclipPlugin` entrypoints all exist on disk. The server never builds a
 * plugin from inside a packaged app, so a missing entrypoint has to fail a
 * build, not a first launch.
 *
 * Shared by the staging step and by verify-macos-release.mjs, which runs the
 * same assertion against `Contents/Resources/app-server/plugins` in the packed
 * .app. Staging the directory correctly and *shipping* it are two different
 * things, and v2026.10.6 and v2026.10.7 shipped without it.
 *
 * Throws on any violation; the caller turns that into a non-zero exit.
 */
export function assertStagedPluginPackage({ pluginDir, name, version, migrationsDir }) {
  const manifestPath = path.join(pluginDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`plugin ${name} is missing its package.json at ${manifestPath}`);
  }

  const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (pkg.name !== name) {
    throw new Error(`plugin directory ${pluginDir} declares name ${pkg.name}, expected ${name}`);
  }

  if (pkg.version !== version) {
    throw new Error(
      `plugin ${name} staged version ${pkg.version} does not match the pinned ${version}`,
    );
  }

  const entrypoints = pkg.paperclipPlugin;
  if (!entrypoints || typeof entrypoints !== "object") {
    throw new Error(`${name} declares no "paperclipPlugin" entrypoints`);
  }

  const declaredKeys = Object.keys(entrypoints).sort();
  if (declaredKeys.length === 0) {
    throw new Error(`${name} declares no "paperclipPlugin" entrypoints`);
  }

  for (const key of declaredKeys) {
    const declared = entrypoints[key];
    if (!existsSync(path.join(pluginDir, declared))) {
      throw new Error(
        `${name} entrypoint "${key}" (${declared}) is missing from ${pluginDir}`,
      );
    }
  }

  // The directory the server readdirs while installing. Checked here, beside
  // the entrypoints, because this assertion is what verify-macos-release runs
  // against the packed .app — and it is exactly what v2026.10.10 was missing.
  // That release passed verification, shipped, and then failed its own smoke
  // test with `ENOENT: no such file or directory, scandir .../migrations`,
  // because this function only ever looked at entrypoints. A declared
  // migrations directory is as load-bearing as an entrypoint: without it the
  // install transaction rolls back and the office route 404s.
  if (migrationsDir) {
    const migrationsPath = path.join(pluginDir, migrationsDir);
    if (!existsSync(migrationsPath) || !statSync(migrationsPath).isDirectory()) {
      throw new Error(
        `${name} declares a migrations directory "${migrationsDir}" that is missing from ${pluginDir}. `
        + "The bundled server readdirs it while installing and fails the install with ENOENT, "
        + "so the office route would 404. See scripts/stage-plugins.mjs.",
      );
    }
  }

  return { name, version, path: pluginDir, entrypoints: declaredKeys };
}

/**
 * Assert that every pinned plugin is present under `pluginsRoot` with a valid
 * layout. Used against the packed .app, where an absent directory means the
 * packaging step dropped the plugins — which provisioning then treats as
 * "nothing to install" and the office route 404s.
 */
export function assertBundledPluginsPresent({ pluginsRoot, plugins = bundledPluginVersions }) {
  if (plugins.length === 0) {
    return [];
  }

  if (!existsSync(pluginsRoot)) {
    throw new Error(
      `Bundled plugins are missing: ${pluginsRoot} does not exist, so `
      + `${plugins.map(({ name }) => name).join(", ")} would not be installed and the office route 404s.`,
    );
  }

  return plugins.map(({ name, version, migrationsDir }) =>
    assertStagedPluginPackage({ pluginDir: path.join(pluginsRoot, name), name, version, migrationsDir }),
  );
}

/**
 * Copy the fetched plugins into `<bundleDir>/plugins` and assert the layout the
 * server's local-path installer requires.
 *
 * Throws on any violation; the caller turns that into a non-zero exit.
 */
export function stageBundledPlugins({
  bundleDir,
  sourceDir,
  plugins = bundledPluginVersions,
  log = console.log,
}) {
  const pluginsDir = path.join(bundleDir, "plugins");
  const staged = [];
  if (plugins.length === 0) {
    return staged;
  }

  mkdirSync(pluginsDir, { recursive: true });

  for (const { name, version, migrationsDir } of plugins) {
    const source = path.join(sourceDir, name);
    const target = path.join(pluginsDir, name);
    cpSync(source, target, { recursive: true, dereference: true, force: true });

    // Make the declared migrations directory survive packaging instead of
    // hoping its `.gitkeep` does. Only written when the plugin ships no real
    // migrations, so a future version that adds them is copied untouched.
    if (migrationsDir) {
      const migrationsPath = path.join(target, migrationsDir);
      mkdirSync(migrationsPath, { recursive: true });
      if (!hasSqlMigrations(migrationsPath)) {
        writeFileSync(
          path.join(migrationsPath, MIGRATIONS_PLACEHOLDER_NAME),
          MIGRATIONS_PLACEHOLDER_BODY,
          "utf8",
        );
      }
    }

    const checked = assertStagedPluginPackage({ pluginDir: target, name, version, migrationsDir });

    log(
      `[prepare-server] Staged plugin ${name}@${version} with entrypoints ${checked.entrypoints.join(", ")}.`,
    );
    staged.push(checked);
  }

  return staged;
}
