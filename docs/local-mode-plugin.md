# Preinstalling plugins into the bundled local server

Recorded 2026-10-13 against `@paperclipai/server` **2026.1001.0** (the version pinned in
`package.json` devDependencies) and `paperclip-office` **0.1.2** from npm.
See [`UPSTREAM.md`](../UPSTREAM.md) for provenance and [`baseline.md`](baseline.md) for what
this runner can and cannot verify.

**Result: the mechanism works; shipping it did not, until `v2026.10.10`.** A fresh
local-mode install preinstalls `paperclip-office` with no terminal step. The SDK version skew
in the task framing turned out to be a non-issue, for a concrete reason recorded below.

> **`v2026.10.6` and `v2026.10.7` shipped with no plugins directory in the `.app`**, so this
> never ran in either of them and the office 404d. The packaging gap and its three fixes are
> in *Not verified from this runner* below and in the runbook's § 7. Nothing in this document's
> install mechanism was wrong — it was simply never handed anything to install.

## Where the plugin directory is

Three different paths matter, and conflating them is the trap:

| | Path | Writable at runtime? |
|---|---|---|
| `PAPERCLIP_HOME` | `~/.paperclip` if `~/.paperclip/instances/default/db` exists, else Electron's `userData` | yes |
| The server's **install** directory (`DEFAULT_LOCAL_PLUGIN_DIR`) | `os.homedir()/.paperclip/plugins` | yes |
| The **staged** plugin bundle (ours) | `<Resources>/app-server/plugins/<package>` | no — inside the signed `.app` |

`PAPERCLIP_HOME` does **not** control the plugin directory. `plugin-loader.js` hardcodes
`DEFAULT_LOCAL_PLUGIN_DIR = path.join(os.homedir(), ".paperclip", "plugins")`, and nothing in
the server reads an env var to relocate it — the only override is the `localPluginDir` option
passed in-process to `createApp`, which a packaged server never sets. So populating a plugin
directory at stage time is not possible: the directory the server would scan lives in the
user's home, not in the app bundle.

That is fine, because **the plugin does not have to live in that directory.** A plugin is
installable from any absolute path, and the install records that `packagePath` and loads the
plugin from there forever after. So we stage the plugin read-only inside the app bundle and
install it *by path*.

### What the bundle looks like

`scripts/stage-plugins.mjs`, called from `scripts/prepare-server.mjs`, downloads each pinned
plugin's published tarball with `npm pack` and extracts it into the per-variant server
bundle:

```
build/server-bundle/<os>-<arch>/plugins/paperclip-office/
  package.json          # paperclipPlugin: { manifest, worker, ui }
  dist/manifest.js
  dist/worker.js
  dist/ui/index.js
  migrations/KEEP-DIRECTORY.md
  README.md LICENSE NOTICE
```

**`migrations/` must exist, and that is load-bearing.** The manifest declares
`database.migrationsDir: "migrations"`, and the server `readdir`s that directory inside the
install transaction (`plugin-database.js` `listSqlMigrationFiles`). If it is absent the
`readdir` raises `ENOENT`, the transaction rolls back, the plugin never registers, and the
office route 404s while every other endpoint answers normally — exactly what shipped in
`v2026.10.10`.

`paperclip-office@0.1.2` publishes the directory holding only `.gitkeep`, which is not a safe
thing to carry through four copy hops and a zip; electron-builder lists `.gitkeep` in its own
`excludedNames`, and nothing in the chain creates an empty directory for you. So
`stageBundledPlugins` writes a non-dotfile `KEEP-DIRECTORY.md` instead — **only** when the
plugin ships no `.sql` files, so a future version with real migrations is copied untouched.
Only `*.sql` is ever read, so the placeholder is inert. `assertStagedPluginPackage` fails the
build when the declared directory is missing from the packed `.app`, which is the check
`verify-macos-release` runs; it previously looked at entrypoints only.

`migrationsDir` is pinned in `bundledPluginVersions` beside the version, not read from the
plugin's manifest module: nothing here executes plugin code, in the build or at runtime.

`electron-builder.yml` maps that to `<Resources>/app-server/plugins`, which the existing
macOS `signIgnore` rule (`/Contents/Resources/app-server/.*`) already covers.

`npm pack` rather than `npm install` is deliberate. The published tarball is exactly the
package's `files` whitelist, every entrypoint is already an esbuild bundle, and the only bare
imports left in the built output are:

- `dist/worker.js` — `node:async_hooks`, `node:fs`, `node:path`, `node:readline`, `node:url`
  (builtins only)
- `dist/ui/index.js` — `react`, `react/jsx-runtime`, `@paperclipai/plugin-sdk/ui`, all
  provided by the host UI at runtime
- `dist/manifest.js` — none

So the declared `dependencies` (`pixi.js`, `zustand`) are compiled in and a `node_modules`
tree would be dead weight. Staged size is 3.2 MB (`du -sh` over the staged directory).

Staging lives in its own module rather than inline in `prepare-server.mjs` so it can be run
on its own: the rest of that script needs darwin native dependencies, this part does not.
`test/stage-plugins.test.mjs` (in `pnpm test:release-safety`) therefore downloads the real
pinned package and stages it on any runner, and fails the build on a version drift, a
missing `paperclipPlugin` entrypoint, or a package that declares none.

The staging step is **outside** `app-server/packages/plugins` on purpose. That path is the
server's `BUNDLED_LOCAL_PLUGIN_ROOT`, and `ensureLocalPluginBuilt` will try to *build* a
plugin found under it when an entrypoint is missing — which must never be attempted inside a
read-only signed bundle. From `app-server/plugins` the server treats it as an ordinary
local-path install and returns from the autobuild check immediately.

## The install mechanism

`src/connection/plugin-provisioning.ts`, called from `bootLocal` in `src/main.ts` after the
server reports healthy and **before** the window loads — the start path from H3 defaults to
`/{prefix}/office`, which 404s until the plugin is installed.

Per staged plugin:

1. `GET /api/plugins` — read what the server already has.
2. Not present → `POST /api/plugins/install` with
   `{ packageName: "<abs staged path>", isLocalPath: true }`.
3. Present with an older version → `POST /api/plugins/:id/upgrade` with `{}`.
   `upgradePlugin` falls back to the stored `packagePath` for local installs and re-reads the
   manifest from disk, so an app update that ships a newer plugin reconciles itself.
4. Present at the same version → no-op.
5. `uninstalled`, `disabled`, `upgrade_pending`, `error` → left alone. Those are the owner's
   or the server's decisions and a relaunch must not silently undo them. This matches
   upstream's own posture for self-hosted instances ("self-hosted leaves an operator's
   uninstall alone").

### Why HTTP works with no credentials

`POST /api/plugins/install` calls `assertInstanceAdmin`, which passes when
`req.actor.source === "local_implicit"`. `actorMiddleware` assigns exactly that actor on every
request when `deploymentMode === "local_trusted"`:

```js
req.actor = opts.deploymentMode === "local_trusted"
  ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
  : { type: "none", source: "none" };
```

`local_trusted` is the server's **default** `deploymentMode` (`config.js`), and `main.ts`
does not set `PAPERCLIP_DEPLOYMENT_MODE` for the bundled server. So the install succeeds on a
fresh profile, before any sign-in or board claim — which is precisely what "no terminal step"
requires. The endpoint is only reachable on loopback, which is the security posture
`local_trusted` already assumes; this adds no new surface.

Two safety properties the module keeps:

- **Plugin code never executes in the Electron main process.** Identity comes from the staged
  `package.json` (`name`, `version`); the manifest module is never imported. The server
  imports it, inside its own process, where it already validates it.
- **Failure is never fatal.** A provisioning failure is logged and skipped. The app opens and
  the office route 404s, which beats refusing to launch.

## SDK compatibility: checked, and not a problem

The concern was that `paperclip-office` is built against `@paperclipai/plugin-sdk`
**2026.831.1** while the bundled server is **2026.1001.0**. It does not matter, for two
independent reasons:

1. `@paperclipai/plugin-sdk` is a **devDependency** of `paperclip-office`, not a runtime
   dependency. esbuild compiles it into `dist/worker.js`. No version of the SDK is resolved at
   runtime, so there is no version to disagree about. (The UI bundle does import
   `@paperclipai/plugin-sdk/ui` as an external, but that is resolved by the *host's* UI — the
   server's own copy — so it is the host's version by construction.)
2. The actual host/plugin contract is `manifest.apiVersion`. The host accepts
   `SUPPORTED_VERSIONS = [PLUGIN_API_VERSION]`, and the plugin declares `apiVersion: 1`.

Verified by running the server's own validators over the plugin's real manifest:

```
host PLUGIN_API_VERSION    : 1
plugin manifest.apiVersion : 1
plugin id / version        : paperclip-office / 0.1.2
entrypoints                : {"worker":"./dist/worker.js","ui":"./dist/ui"}
ui                         : {"slots":[{"type":"page","id":"office","displayName":"Office","exportName":"OfficePage","routePath":"office"}, …]}
host requirement           : null
host supported apiVersions : [1]
manifest schema validation : PASS
capability consistency     : PASS
```

That is `pluginManifestValidator().parse()` and
`pluginCapabilityValidator().validateManifestCapabilities()` from
`@paperclipai/server@2026.1001.0` against `paperclip-office@0.1.2`'s `dist/manifest.js`. The
manifest declares no `host` minimum version, so the `minimumHostVersion` gate does not apply.

The `routePath: "office"` slot is what renders at `/{company}/office`, matching the start
path H3 ships.

## Art and licensing

The published package ships **no LimeZu art** — the `files` whitelist excludes `assets/` and
the `prepack` strips art. Its Scandi wood tilesheet is inlined into `dist/ui/index.js` as a
single 189 KB base64 PNG, so the default style travels with the package and needs no
assets directory. `NOTICE` ships in the tarball and travels with the plugin, not with this
repo, as `UPSTREAM.md` says.

Note the npm package is published from `Kshitijm7/paperclip-office`, the upstream of our
`whit3hat/paperclip-office`. We consume the published upstream version; the pin lives in
`bundledPluginVersions` in `scripts/prepare-server.mjs`.

### Why the pin is not a devDependency

It would be the obvious place, and it is wrong here. `paperclip-office` declares
`react` as a peer and `pixi.js`/`zustand` as dependencies. Adding it to `devDependencies`
makes pnpm hoist `react@18.3.1` into the install tree, which changes the peer set
`@paperclipai/server` resolves with:

```
-  '@paperclipai/server@2026.1001.0(…)(postgres@3.4.9)(sqlite3@5.1.7)':
+  '@paperclipai/server@2026.1001.0(…)(postgres@3.4.9)(react@18.3.1)(sqlite3@5.1.7)':
```

That server is exactly what this script stages into the bundle, so the dependency entry
perturbs the artifact it is supposed to describe — plus ~10 MB of pixi/react in
`node_modules` that nothing imports. `npm pack` fetches the tarball straight from the
registry and never consults `node_modules`, so the pin has no reason to be there.

The cost is that Dependabot will not bump it. Accepted: the bundled plugin's release cadence
is ours, and a bump is a one-line edit to `bundledPluginVersions`.

## Resource cost

Staged size 3.2 MB per architecture. At runtime the plugin worker is one extra Node process
spawned by the server's worker manager, on top of the server and embedded Postgres the local
mode already runs. Rough budget: tens of MB of RSS for the worker; the heavy part
(pixi.js rendering) runs in the renderer, inside the window that is already open.

## How to configure and roll back

| Lever | Effect |
|---|---|
| `HAVEN_OFFICE_PREINSTALL_PLUGINS=0` | Skips provisioning entirely. No requests, no install. |
| `HAVEN_OFFICE_PLUGINS_DIR=<path>` | Points provisioning at another staged plugin directory. |
| `bundledPluginVersions` in `scripts/prepare-server.mjs` | Which plugins ship, and at which version. Emptying the list ships none. |

Rollback for a released build: set `HAVEN_OFFICE_PREINSTALL_PLUGINS=0`, or uninstall the
plugin from Settings — provisioning respects `uninstalled` and will not reinstall it on the
next launch. Rollback for the source change: revert the commit; `prepare-server` then stages
no `plugins` directory and `readStagedPlugins` returns an empty list, so the provisioning call
is a no-op even in an already-built bundle.

## Not verified from this runner

- ~~**The packaged app.**~~ **Verified 2026-10-18, and it was broken.** The step this section
  called out as unproven — the `<Resources>/app-server/plugins` mapping — was in fact missing,
  and `v2026.10.6` and `v2026.10.7` shipped with no plugins directory at all. The mapping
  exists in the root `electron-builder.yml`, but `dist:mac` goes through
  `scripts/release-macos-local.mjs`, which generates its own config, and that config did not
  have it. `readStagedPlugins` returned `[]`, provisioning no-opped **silently**, and the
  office 404d in every installed copy. Fixed in `v2026.10.10`: the stage ships and asserts the
  directory, `verify-macos-release.mjs` fails a build that would publish without it, and
  provisioning now logs when it finds nothing. Full write-up in the runbook's § 7. The
  read-only-bundle install itself is still unproven — it has never been reached.
- **A real spawned local server.** Attempted 2026-10-18 and it cannot be done from this
  container — for a more specific reason than previously recorded here. The reason was *not*
  that the native deps are absent: `build/server-bundle/linux-x64` does carry
  `@embedded-postgres/linux-x64` with real `initdb`/`postgres`/`pg_ctl` binaries. They cannot
  *execute* here. Replicating `startServer()` from `src/main.ts` (same argv, `PORT`,
  `PAPERCLIP_HOME`, `PAPERCLIP_TEAMS_CATALOG_DIR`, `PAPERCLIP_MIGRATION_AUTO_APPLY`) gets as far
  as:

      Using embedded PostgreSQL because no DATABASE_URL set (port=54330)
      Failed to initialize embedded PostgreSQL cluster ...: Postgres init script
      exited with code 127

  Exit 127 is the shell's "not found", and `ldd` on the bundled `initdb` names the cause:
  `libpq.so.5 => not found` and `libicuuc.so.60 => not found`. So the bundled server needs
  system libraries this container does not have, and installing them is not this agent's call.

  The consequence worth knowing: **the office route itself is still never exercised by any
  automated check.** The macOS smoke test asserts `paperclip-office` reaches `installed` in
  `/api/plugins`, which is the closest proxy, but no job fetches `/{prefix}/office` and asserts
  it answers. Closing that would need either a `DATABASE_URL` pointing at a real Postgres on a
  Linux runner, or an HTTP assertion added to the macOS smoke test, where a server is already
  running. The HTTP contract for the install itself is covered by
  `test/plugin-provisioning.test.mjs` against a fake fetch, and the authorization path was read
  from the server's own `actorMiddleware`/`assertInstanceAdmin` source.
- **Whether the office renders well.** The plugin loads; how it looks needs a window.

## Rejected alternatives

Both were real candidates. Recording why they lost.

**`PAPERCLIP_MANAGED_CONFIG` with `plugins.autoInstall`.** This is the clean, intended
auto-provisioning path — `ensureBundledPlugins` installs and loads each key at boot, in
process, with no HTTP. It is unusable here because setting that variable *at all* makes
`isCloudManagedInstance()` true, which switches on every cloud floor regardless of the
document's contents. On a desktop app that costs, concretely:

- `POST /api/adapters/...` installs → `403 adapter_install_platform_managed`. The owner could
  never install a coding-agent adapter, which is most of the point of running a local server.
- `POST /api/instance/database-backups` → `403 database_backups_platform_managed`.
- npm plugin installs → `403`; only bundled-catalog local paths remain installable.
- Further floors on companies, environments and instance settings.

Trading local adapter installs and local DB backups for one preinstalled plugin is not a
trade worth making. (The self-hosted key list is `SELF_HOSTED_AUTO_INSTALL_KEYS =
["kubernetes"]`, and the distribution catalog under `<catalogRoot>/distribution` is only
consulted for keys in the *managed* list, so there is no self-hosted way into this path.)

**Reusing the `kubernetes` slot.** `SELF_HOSTED_AUTO_INSTALL_KEYS` is `["kubernetes"]`, that
entry has `pathOverrideEnvVar: "PAPERCLIP_KUBERNETES_PLUGIN_PATH"`, and self-hosted resolution
passes `enforceCatalogRoot: false` — so the override may point anywhere, and
`ensureBundledPlugins` installs whatever manifest it finds there and then looks the result up
by the *discovered* manifest id. Pointing it at the office bundle would auto-install the
office at boot with no managed config and no cloud floors.

It would work today, and it is still the wrong call: the variable name lies about what it
does, it permanently burns the one self-hosted auto-install slot, and it depends on upstream
not tightening identity checks on a path explicitly documented as legacy compatibility. The
HTTP path above uses a public, documented API and fails loudly in our own logs when it breaks.
Worth revisiting only if upstream adds a real self-hosted auto-install key list.
