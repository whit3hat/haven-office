# Local Testing Guide: Remote Connection Mode

This guide captures the exact local test paths for the remote connection mode implementation on `feature/remote-connection-mode`.

## Quick remote-mode test

Use this when you want to verify the new launcher, chooser, remote connect flow, saved connections, and menu-based quick connect.

```bash
git checkout feature/remote-connection-mode
pnpm install
pnpm dev
```

Notes:

- `pnpm dev` compiles the Electron shell and launches it directly from `dist/main.js`
- this is the fastest path for testing remote mode
- use it to verify:
  - chooser flow
  - remote verification states
  - sign-in-required remotes
  - saved connections CRUD
  - Connection menu quick connect entries

## Full local package test

Use this when you want the packaged desktop app shape rather than the direct dev shell.

```bash
git checkout feature/remote-connection-mode
pnpm install
pnpm test:connections
pnpm run pack
```

Important:

- use `pnpm run pack`, not `pnpm pack`
- `pnpm pack` is pnpm's built-in tarball command and does not run the Electron Builder packaging script

What `pnpm run pack` does:

1. builds the Electron TypeScript
2. stages the bundled `@paperclipai/server`
3. stages the Paperclip UI
4. runs Electron Builder with `--dir`

## Result from the latest local run

These commands were run in this repo:

```bash
pnpm test:connections
pnpm run pack
```

Observed result:

- `pnpm test:connections` passed
- `pnpm run pack` successfully completed:
  - Electron TypeScript build
  - server bundle staging
  - UI staging from `@paperclipai/ui@2026.403.0`
- Electron Builder then stopped during macOS signing with:

```text
macOS release signing requires APPLE_CODESIGN_IDENTITY or CSC_NAME.
```

## Current artifact paths

Even though the signing hook failed, Electron Builder did create an unpacked app bundle directory before aborting:

```text
release/mac/Haven Office.app
```

This path exists from the latest local run.

## Signing requirement

The current macOS packaging flow requires one of these environment variables before a full packaged build can complete:

```bash
export APPLE_CODESIGN_IDENTITY="Developer ID Application: ..."
```

or

```bash
export CSC_NAME="Developer ID Application: ..."
```

Without one of those values, `pnpm run pack` will stop in `scripts/after-pack.mjs`.

## Recommended local test sequence

If you want the shortest reliable path today:

1. Run `pnpm dev` to test remote mode end-to-end.
2. Run `pnpm test:connections` to verify the connection logic and security checks.
3. Only run `pnpm run pack` if you have a signing identity configured or specifically want to inspect the partially-built unpacked app bundle.

## Testing when you do not have a remote Paperclip

You can still test a large part of the feature without a real remote.

### Expected negative-path tests

These are useful and should behave as follows:

- `https://localhost:3100`
  - expected to fail
  - the embedded local Paperclip server is plain HTTP, not HTTPS
  - if nothing is listening there yet, `host unreachable` is expected
- `http://localhost:3100`
  - once the embedded local mode is already running, this should identify Paperclip but reject it for remote mode
  - expected reason: `deploymentMode=local_trusted`
  - this is correct behavior, not a bug
- `https://example.com`
  - expected result: reachable but not Paperclip
- malformed URLs
  - expected result: inline validation failure

Important:

- the desktop app intentionally blocks `local_trusted` remotes in remote mode
- the normal embedded local startup uses `local_trusted` by default
- so `localhost` is not a valid positive remote-mode target for this feature

### Positive-path remote test without owning a real remote machine

If you want to test the success path on your own machine, start a second Paperclip instance manually in upstream `authenticated` mode on a different port.

At minimum, that instance needs:

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `BETTER_AUTH_SECRET=...`

Useful additional settings for a local authenticated test instance:

- `PORT=3200`
- `PAPERCLIP_AUTH_PUBLIC_BASE_URL=http://127.0.0.1:3200`
- `PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost`

That gives you a remote-mode target like:

```text
http://127.0.0.1:3200
```

This is the easiest way to test:

- verified authenticated remote
- sign-in-required state
- bootstrap/setup-required state
- saved remote profiles
- reconnect behavior
- remote window isolation

If that authenticated test instance has not been bootstrapped yet, or there is no active session yet, Desktop should still open the verified remote and let the upstream Paperclip UI handle setup or sign-in in-app.

## What to verify manually

- Local vs Remote chooser behavior
- `Remember my choice and don't ask again`
- remote verification success for authenticated Paperclip remotes
- sign-in-required remote behavior
- setup-required remote behavior in the remote Paperclip UI
- blocking of:
  - non-Paperclip endpoints
  - `local_trusted` remotes
  - malformed URLs
  - embedded credential URLs
- saved connections:
  - add
  - edit
  - duplicate
  - delete
  - reconnect from the Connection menu
- local boot path still opens the embedded server flow
