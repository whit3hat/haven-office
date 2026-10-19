# Building a Haven desktop tool from this repo

This is the template document. `haven-office` is the first Haven desktop tool, and it is
also the shape every later one should take: a thin, branded Electron shell over a Paperclip
server, with as little of our own code in it as we can get away with.

Read this before you start a second tool. It answers four things, in order:

1. [The one rule that decides whether to build a desktop tool at all](#1-the-plugin-versus-native-test)
2. [How to start a new tool from this fork, to a running skeleton](#2-from-fork-to-running-skeleton)
3. [What is ours and what is upstream](#3-what-is-ours-and-what-is-upstream) — and
   [how to pull upstream's packaging fixes](#4-pulling-upstream-fixes)
4. [What `src/paperclip/` gives you, and where the auth seam is](#5-the-paperclip-data-layer)

---

## 1. The plugin-versus-native test

Before you write anything native, ask the question from the Phase plan (HAV-32, plan § 2),
verbatim:

> **Can a plugin running inside the Paperclip web app do this?**

If yes, it belongs in [`paperclip-office`](https://github.com/whit3hat/paperclip-office) —
or in whatever plugin is appropriate — **not here**.

That one rule is what keeps this fork small, and "small" is the whole strategy: the window in
`paperclip-desktop` *is* the Paperclip web app, so any plugin installed on the server renders
inside it with **no new desktop code at all** (see [`UPSTREAM.md`](../UPSTREAM.md), *Why this
repo exists*). Every line that lives here instead is a line that has to survive an upstream
rebase, be packaged, be signed, be smoke-tested on a real Mac, and be shipped in a `.dmg` a
human has to install by hand.

Things that pass the test (i.e. go native):

| Need | Why a plugin cannot do it |
| --- | --- |
| A menu-bar / tray item that is visible with no window open | There is no page running when the window is closed. |
| A native OS notification, with a dedupe and rate policy | Web notifications need the page open and the permission model is the browser's. |
| Reading the OS keychain | `safeStorage` is a main-process API. |
| Starting, supervising and shutting down a local server process | No renderer can fork a process. |
| Deciding which origins the window may navigate to | A security boundary the page cannot be trusted to enforce on itself. |
| Packaging, code signing, auto-update | Not a web concern at all. |

Things that fail it (i.e. stay a plugin): any view, any report, any form, any board widget,
anything that is "a page with data on it". If your answer is "it would be *nicer* as a native
window", that is not a pass.

---

## 2. From fork to running skeleton

Target: a window that opens on a Paperclip server, running from source, before you have
changed any behaviour. Expect this to take under an hour on a Mac.

### 2.1 Copy, don't GitHub-fork

`haven-office` is a plain downstream copy of `aronprins/paperclip-desktop`, not a GitHub
fork — the whole history and all upstream tags are in it. Keep that shape; a new tool starts
from *this* repo for the same reason:

```sh
git clone https://github.com/whit3hat/haven-office.git haven-<tool>
cd haven-<tool>
git remote set-url origin https://github.com/whit3hat/haven-<tool>.git
git remote add upstream https://github.com/aronprins/paperclip-desktop.git
git fetch upstream --tags
```

Keep the default branch named **`master`**. Every inherited workflow (`release.yml`,
`smoke-packaged-macos.yml`, `notarize-*.yml`) defaults its ref input to `master`; renaming it
silently breaks those dispatches. This is recorded in [`UPSTREAM.md`](../UPSTREAM.md).

### 2.2 Install and run

Requirements: Node.js 20+ (CI pins 22), pnpm 9.15+.

```sh
pnpm install
pnpm build          # tsc — compiles src/ to dist/
pnpm dev            # Electron, dev mode
```

Two caveats worth knowing before you debug something that is not broken:

- **Local mode does not run on Linux**, including in a container. The bundled
  `@embedded-postgres/linux-x64` binaries are present but cannot execute (`Postgres init
  script exited with code 127`), so `startServer()` never comes up. Details and the exact
  failure are in [`docs/local-mode-plugin.md`](local-mode-plugin.md) § *Not verified from
  this runner*. **Remote mode works anywhere** — point the launcher at a Paperclip server
  you already run, which is the fastest path to a window with real data in it.
- **Unsigned macOS builds are refused on first open** by Gatekeeper, and macOS 15+ also
  prompts for Local Network access before the app can reach a server on your LAN. Both are
  expected, both cost real time the first time you hit them, and both are walked through in
  [`docs/install-runbook.md`](install-runbook.md) §§ 3a and 4b.

### 2.3 Rename the product

The product identity is load-bearing in more places than a global search-and-replace will
make obvious. Change these deliberately:

| Where | What |
| --- | --- |
| `package.json` | `name`, `description`, `homepage`, `version` (CalVer — see below) |
| `electron-builder.yml` | `appId`, `productName`, `copyright`, and `publish.owner` / `publish.repo` — the auto-updater reads releases from there |
| `src/main.ts` | `app.setName(...)` and the window titles |
| `src/runtime-safety.ts` | `productionPaperclipDataPaths()` hardcodes the product name because `app.setName()` decides which `userData` directory is "production". **This is a safety guard** — it is what stops a dev run from writing into a real install's data. Rename it here or the guard stops guarding. |
| `src/updater-signing.ts` | `RELEASES_PAGE_FALLBACK`, the releases URL shown when an unsigned build cannot update itself |
| `src/connection/start-path.ts` | `DEFAULT_COMPANY_PREFIX`, `COMPANY_PREFIX_ENV_VAR`, and `DESKTOP_VIEWS` — see § 2.4 |
| `src/launcher-html.ts` | The launcher UI's own copy and branding |
| `scripts/macos-info-plist.mjs` | The Local Network usage string macOS shows the user by name |
| `build/` | `icon.png`, `icon.ico`, `trayTemplate.png`, `trayTemplate@2x.png`; `build/branding/make-icons.py` regenerates the first two from source marks |

Re-derive that list for yourself at any time, rather than trusting this table to stay current:

```sh
grep -rIln -e 'Haven Office' -e 'haven-office' -e 'HAVEN_OFFICE' \
  --include='*.ts' --include='*.mjs' --include='*.yml' --include='*.json' \
  . --exclude-dir=node_modules --exclude-dir=dist
```

Versions are **CalVer, `YYYY.M.N`, tagged `v<version>`** — not semver. Upstream's entire `3.x`
tag range already exists in the repo, so continuing its numbering is not available to us
([`docs/install-runbook.md`](install-runbook.md#version-numbers)).

### 2.4 Point it at a view

A Haven tool opens on a company-scoped view, not the server root. That is configuration, in
one file:

```ts
// src/connection/start-path.ts
export const DEFAULT_COMPANY_PREFIX = "HAV";          // overridable per connection,
export const COMPANY_PREFIX_ENV_VAR = "HAVEN_OFFICE_COMPANY_PREFIX";  // or by env,
export const DESKTOP_VIEWS = [                        // or by connections.json
  { key: "office", label: "Office", accelerator: "CmdOrCtrl+1", pathTemplate: "/{prefix}/office" },
  { key: "board",  label: "Board",  accelerator: "CmdOrCtrl+2", pathTemplate: "/{prefix}/issues" },
];
```

Adding a view is an edit to `DESKTOP_VIEWS`, not a change to the navigation code; the native
menu and the tray menu both read it. Covered by `test/start-path.test.mjs`.

### 2.5 Know the test commands

Everything here is `node:test`, no framework. Nothing touches a live server.

```sh
pnpm test:connections       # persistence, preflight, origin policy, start path
pnpm test:paperclip         # the data layer (§ 5) against fixtures
pnpm test:tray              # the pure menu-bar modules
pnpm test:release-safety    # packaging, signing, updater, smoke assertions
```

---

## 3. What is ours and what is upstream

Everything in `src/`, `scripts/` and `test/` is one of three things, and the distinction
decides how carefully you touch it.

**Ask git, not this document.** The repo was seeded from upstream commit `42d9decb`
(`v3.2.15`, 3 Oct 2026), so the boundary is a command:

```sh
git diff --name-status 42d9decb169383af0802f14255ec801aa44cb623..HEAD -- src scripts test
```

`A` is ours outright. `M` is an upstream file we have edited. Anything absent is **pristine
upstream** — as of 2026-10-19 that is all of:

```
src/connection/local-server-health.ts      src/launcher-preload.ts
src/connection/local-server-lifecycle.ts   src/navigation-gestures.ts
src/connection/validate.ts                 src/preload.ts
src/connection/window-policy.ts            src/splash-preload.ts
```

- **Pristine upstream** — rebases onto them are free today. Editing one makes every future
  rebase of that file our problem. If you need different behaviour, prefer a new file of ours
  that wraps it over an edit in place, and if you do edit it, say why in the commit.
- **Ours outright** (`src/paperclip/`, `src/tray/`, `src/connection/start-path.ts`,
  `src/updater-signing.ts`, the `scripts/*` listed in [`UPSTREAM.md`](../UPSTREAM.md)) — edit
  freely, keep it tested off a Mac.
- **Upstream, modified by us** (`src/main.ts`, `src/launcher-html.ts`,
  `src/connection/preflight.ts`, the release scripts, the workflows) — the rebase cost is
  already paid, but keep the diff as small and as localized as you can. Upstream's recent
  history is almost entirely packaging, signing and notarization hardening; we want to
  inherit that, not re-solve it.

Two specific traps, both documented in [`UPSTREAM.md`](../UPSTREAM.md):

- **`patches/`** is the most fragile thing in a downstream repo. We carry exactly one
  (`@electron/osx-sign@1.3.3`, bounding an unbounded `Promise.all` that `EMFILE`s on a bundle
  our size). Each patch gets a reason *and an exit condition* there, and
  `test/osx-sign-walk-patch.test.mjs` fails loudly when the upstream fix lands.
- **Our server bundle is much larger than upstream's**, because we stage `@paperclipai/server`
  and its entire `node_modules` into the app. Several macOS packaging fix-ups exist only for
  that reason and have no upstream counterpart (`scripts/esbuild-normalization.mjs`,
  `scripts/native-build-intermediates.mjs`, `scripts/macho.mjs`, the file-descriptor raise in
  `scripts/release-macos-local.mjs`). Expect to keep all of them across a rebase.

---

## 4. Pulling upstream fixes

```sh
git fetch upstream
git log --oneline HEAD..upstream/master      # what is new
git pull upstream master                     # or: git rebase upstream/master
pnpm install                                 # patches re-apply here; a failure is the signal
pnpm test:release-safety                      # packaging/signing is what upstream changes
```

Then build a real `.dmg` and smoke it on a Mac before shipping — the packaging suites run on
Linux and prove the scripts, not the bundle. The release procedure start to finish is
[`docs/install-runbook.md`](install-runbook.md#7-cutting-a-release) § 7.

Releases are **manually dispatched**, not tag-triggered: bump the version, push a `v…` tag,
then run **Release Desktop** with `ref=<that tag>`. Dispatching with `ref=master` builds and
verifies but publishes nothing — which is the cheap way to test a packaging change.

**One hard-won rule about the smoke test.** Phase 1 published three releases that were
packaged, verified and smoke-tested with no office plugin in them, because the smoke test
proved the server answered `/get-session` — which a server with no plugin does just as
happily. If a feature is "present in the source, absent from the bundle" in a way nothing
would notice, add the assertion to `scripts/packaged-smoke-assertions.mjs` (it is split out of
`scripts/smoke-test-packaged-macos.mjs` precisely so it can run on a Linux runner) and a case
to `test/packaged-smoke-assertions.test.mjs`. Do not trust the build.

---

## 5. The Paperclip data layer

`src/paperclip/` is the reusable part — the reason a second Haven tool is mostly
configuration. It is a typed, Electron-free REST client for a Paperclip server, with the
auth problem already solved. Design notes and the full decision record:
[`docs/paperclip-data-layer.md`](paperclip-data-layer.md).

```ts
import { createPaperclipClient, firstAvailableStrategy, watch } from "./paperclip";
```

| File | Contents |
| --- | --- |
| `index.ts` | The public surface. **Deliberately does not re-export `./electron`**, so importing it never drags `electron` into a test, a script, or a future non-Electron tool. |
| `client.ts` | `createPaperclipClient`. Takes a `fetch`. Nothing throws — every call returns a `PaperclipResult`. |
| `auth.ts` | The auth seam. See below. No Electron. |
| `board-key-store.ts` | The `safeStorage`-encrypted fallback credential, behind an injected `SafeStorageLike`. |
| `transport.ts` | Fetch-with-timeout and error classification, shared with `src/connection/preflight.ts`. Sole owner of `blocked_by_os`. |
| `result.ts` | `PaperclipResult`, the failure reasons, `isActionableFailure`. |
| `types.ts` | Hand-written response types, each with its provenance. |
| `watch.ts` | Adaptive polling (`WATCH_INTERVALS`). |
| `electron.ts` | **The only file that imports `electron`**: session partition → cookie reader, transport, keychain. Reach for it explicitly from the main process. |

Worked example, runnable: `scripts/paperclip-attention.mjs`.

### Where the auth seam is

`src/paperclip/auth.ts`. One interface, two implementations, and the surface must not care
which is in play:

```ts
export interface AuthStrategy {
  readonly kind: AuthStrategyKind;         // "session_cookie" | "board_api_key"
  authorize(target: URL): Promise<AuthDecision>;
}
```

- **`sessionCookieStrategy(readCookies)` won, and is wired up by default** (P1's decision,
  recorded in [`docs/paperclip-data-layer.md`](paperclip-data-layer.md) § 1). It reuses the
  Chromium session the user already signed into inside the window, so there is nothing for
  the user to manage.
- **`boardApiKeyStrategy(loadKey)`** is the fallback, a board API key in the OS keychain, for
  if cookie reuse is ever unavailable.
- `firstAvailableStrategy([...])` tries them in order. The cookie costs nothing and needs no
  setup, so it wins whenever it is there.

Three things about this seam that are easy to get wrong, and are already right:

1. **An agent API key will never work for these endpoints.** The views a Haven tool wants are
   board-scoped: `GET /api/companies/{id}/attention` calls `assertBoard(req)` and then refuses
   anything without `req.actor.userId`, so an agent key gets `403 Board access required`. A
   *board* key resolves to a `userId` and does satisfy the same check. The app has to act as
   the signed-in user.
2. **Do not hardcode the session cookie name.** Paperclip configures better-auth with
   `cookiePrefix: "paperclip-{instanceId}"`, so the cookie is
   `paperclip-<instanceId>.session_token` and `instanceId` differs per server — plus
   `__Secure-` on an https origin. `isSessionCookie()` matches the shape.
3. **Neither strategy imports Electron.** The cookie strategy takes a reader function, the key
   strategy takes a loader. That is what makes both unit-testable off a Mac, and it is the
   pattern to copy.

### The pattern to copy for anything native

`src/tray/` is the worked example of the structure every native surface here should have:
**the logic is pure, and exactly one file touches Electron.**

| File | Electron? |
| --- | --- |
| `attention-items.ts` | no — what is active, what order, what is new since last tick |
| `notification-policy.ts` | no — dedupe, burst debounce, rate cap |
| `surface-state.ts` | no — collapses nine client failure reasons into four user-visible repairs |
| `menu-model.ts` | no — a plain-object description of the menu |
| `settings-store.ts` | no — JSON next to `connections.json`; a missing file is first run, not an error |
| `tray-controller.ts` | **yes** — turns the model into a real `Tray`/`Menu`/`Notification` |

So "does the right row appear, in the right order, pointing at the right thing" is a
`node:test` question (`pnpm test:tray`), answerable on Linux, instead of something you
discover by opening the menu bar on a Mac. On a repo whose only real install target needs a
human with a Mac and a Gatekeeper right-click, that difference is most of the iteration speed
you have.

---

## Related documents

- [`README.md`](../README.md) — what the app is, quickstart, licences
- [`UPSTREAM.md`](../UPSTREAM.md) — provenance, sync path, conventions, the dependency patch
- [`docs/install-runbook.md`](install-runbook.md) — install, first run, releases, troubleshooting
- [`docs/paperclip-data-layer.md`](paperclip-data-layer.md) — the auth decision and the attention payload
- [`docs/local-mode-plugin.md`](local-mode-plugin.md) — preinstalling plugins into the bundled server
- [`docs/development/architecture.md`](development/architecture.md) — build pipeline, updater, state
- [`docs/baseline.md`](baseline.md) — what the fork measured as working, at the seed commit
