/**
 * Staging for the plugins that get preinstalled into the bundled local server.
 *
 * Split out of prepare-server.mjs so it can be exercised on its own: the rest
 * of that script needs darwin native dependencies, this part does not, so a
 * Linux runner can still prove the layout the installer depends on. See
 * docs/local-mode-plugin.md.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
export const bundledPluginVersions = [{ name: "paperclip-office", version: "0.1.2" }];

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
 * Copy the fetched plugins into `<bundleDir>/plugins` and assert the layout the
 * server's local-path installer requires: a package.json at the pinned version
 * whose `paperclipPlugin` entrypoints all exist on disk. The server never
 * builds a plugin from inside a packaged app, so a missing entrypoint has to
 * fail the build, not the first launch.
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

  for (const { name, version } of plugins) {
    const source = path.join(sourceDir, name);
    const target = path.join(pluginsDir, name);
    cpSync(source, target, { recursive: true, dereference: true, force: true });

    const pkg = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
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
      if (!existsSync(path.join(target, declared))) {
        throw new Error(
          `${name} entrypoint "${key}" (${declared}) is missing from the published package`,
        );
      }
    }

    log(
      `[prepare-server] Staged plugin ${name}@${version} with entrypoints ${declaredKeys.join(", ")}.`,
    );
    staged.push({ name, version, path: target, entrypoints: declaredKeys });
  }

  return staged;
}
