# Fork baseline verification

Recorded 2026-10-12 against `35dbf60cdc9f077212d848ad6645ac390ec40d0d` (one documentation
commit on top of upstream `42d9decb` / `v3.2.15`). See [`UPSTREAM.md`](../UPSTREAM.md) for
provenance. This file is the reference the branding, start-path and packaging tasks build on
(HAV-32 tasks H2–H4). It is a record of what was observed, not a target.

## Environment

| | |
|---|---|
| OS | Linux 7.0.2-3-pve, x86_64 |
| Node | **v24.21.0** (CI pins `node-version: 22`) |
| pnpm | 9.15.9 (matches `pnpm/action-setup@v4` `version: 9`) |
| Electron (dev dep) | 41.10.7 |

**Node version deviation.** `.github/workflows/release.yml` builds on Node 22; only Node
24.21.0 is installed on this runner and there is no nvm. Everything below therefore passed on
Node 24, not on the CI version. Nothing in the install or the suites tripped on it, but a
Node-22-only result is still unverified here. Release builds run on the CI runner, so the
pinned version is what ships.

## Install

```sh
pnpm install
```

Clean. `Lockfile is up to date, resolution step is skipped`, `Packages: +747`,
`Done in 25.9s using pnpm v9.15.9`. The `electron` postinstall ran and completed.

One advisory, not an error:

```
The following dependencies have build scripts that were ignored: @embedded-postgres/linux-x64,
cpu-features, protobufjs, sqlite3, ssh2
```

These are transitive deps of `@paperclipai/server` and are skipped because
`pnpm.onlyBuiltDependencies` in `package.json` lists only the darwin embedded-postgres
packages plus `electron`, `electron-winstaller` and `esbuild`. That is upstream's deliberate
allowlist for macOS packaging. It means **the bundled server's native modules are not built on
Linux**, so a locally spawned server has not been exercised here. Relevant to H4 if Linux
packaging is ever wanted; irrelevant to a remote-connection build.

## Tests

All 10 `node:test` suites under `test/` are platform-independent and all pass. None are
macOS-only — the macOS-specific suites test the *asset-preparation scripts* against
fixtures, not macOS itself, so they run fine on Linux.

```sh
pnpm test:connections                 # 37 tests, 37 pass, 0 fail (596ms)
pnpm test:release-safety               # 13 tests, 13 pass, 0 fail (218ms)
pnpm test:prepare-release-assets:mac   #  3 tests,  3 pass, 0 fail (81ms)
```

`test:connections` and `test:release-safety` both run `pnpm build` (`tsc`) first; `tsc`
completed with no diagnostics in both.

Suite-to-script map — every suite is covered, `prepare-macos-release-assets` twice:

| Suite | Script |
|---|---|
| `connection-validate` | `test:connections` |
| `connection-preflight` | `test:connections` |
| `connection-profiles` | `test:connections` |
| `window-policy` | `test:connections` |
| `navigation-gestures` | `test:connections` |
| `local-server-lifecycle` | `test:connections` |
| `local-server-health` | `test:connections` |
| `runtime-safety` | `test:release-safety` |
| `esbuild-normalization` | `test:release-safety` |
| `prepare-macos-release-assets` | `test:release-safety`, `test:prepare-release-assets:mac` |

`test/manual/dual-instance-e2e.mjs` is not wired to any `test:*` script and was not run — it
launches two Electron instances and needs a display.

## Remote preflight

`preflightRemoteConnection` from `src/connection/preflight.ts`, compiled to
`dist/connection/preflight.js` by `pnpm build`, called against the lab server:

```js
import { preflightRemoteConnection } from "./dist/connection/preflight.js";
console.log(JSON.stringify(
  await preflightRemoteConnection({ remoteUrl: "https://paperclip.lab.havenco.xyz" }),
  null, 2));
```

```json
{
  "ok": true,
  "normalizedUrl": "https://paperclip.lab.havenco.xyz/",
  "origin": "https://paperclip.lab.havenco.xyz",
  "insecureTransport": false,
  "paperclipDetected": true,
  "deploymentMode": "authenticated",
  "deploymentExposure": "private",
  "authReady": null,
  "bootstrapStatus": "ready",
  "bootstrapInviteActive": false,
  "sessionState": "signed_out",
  "version": null
}
```

This reproduces the 2026-10-12 result taken against upstream's copy of the module, field for
field. `sessionState: "signed_out"` is expected — sign-in happens inside the Electron window,
not during preflight. `authReady: null` and `version: null` are the server redacting those
fields on a private deployment; `preflight.ts` accepts that shape, and
`test/connection-preflight.test.mjs` covers it explicitly ("preflight accepts redacted
authenticated health when deploymentExposure is present without authReady").

## Not verifiable from this runner

- **Node 22.** Only Node 24.21.0 here. See above.
- **macOS packaging and signing.** `electron-builder` cannot produce or sign a `.app` /
  `.dmg` off macOS. Everything under `scripts/*macos*.mjs` plus `release:mac:local`,
  `dist:mac`, `smoke:mac:packaged` and the notarization workflows need a macOS runner. Their
  pure-logic halves are covered by the suites above; the packaging itself is not.
- **The bundled local server.** Native deps unbuilt on Linux (see Install), and
  `local-server-*` coverage is unit-level only. A real spawned server is untested here.
- **Anything needing a window.** No display on this runner, so no Electron launch, no
  `test/manual/dual-instance-e2e.mjs`, and no visual confirmation that the Paperclip web app
  renders in the shell.
- **Whether `paperclip-office` is installed on the lab server.** `GET
  https://paperclip.lab.havenco.xyz/api/plugins` returns `403 {"error":"Board access
  required"}` both with an agent API key and unauthenticated. An agent cannot read the plugin
  list; this needs a board member. If it turns out not to be installed, one `plugin install`
  against that server covers it.
