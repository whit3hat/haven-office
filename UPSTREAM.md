# Upstream provenance

`haven-office` is havenCo's downstream of
[aronprins/paperclip-desktop](https://github.com/aronprins/paperclip-desktop) (MIT),
seeded from upstream commit `42d9decb169383af0802f14255ec801aa44cb623` (`v3.2.15`,
3 Oct 2026). It is a plain downstream copy, not a GitHub fork — the whole history and
all upstream tags are here, and `git pull upstream master` is the sync path.

```sh
git remote add upstream https://github.com/aronprins/paperclip-desktop.git
git fetch upstream
git pull upstream master     # or: git rebase upstream/master
```

## Conventions

- **The default branch is `master`, deliberately.** Every upstream workflow
  (`release.yml`, `smoke-packaged-macos.yml`, `notarize-*.yml`) defaults its ref input
  to `master`. Renaming to `main` would silently break those dispatches and make every
  rebase noisier. Keep `master`.
- **Keep our changes few and localized** — branding, the office start path, and server
  staging — so rebases onto upstream stay cheap. Upstream's recent history is almost
  entirely packaging, signing and notarization hardening; we want to inherit that, not
  re-solve it.
- Upstream releases are **manually dispatched** (`workflow_dispatch`), not tag-triggered.
  `release.yml` takes a `ref`; `smoke-packaged-macos.yml` and `notarize-*.yml` take a
  release `tag`.
- **Our server bundle is much larger than upstream's**, because we stage
  `@paperclipai/server` and its whole `node_modules` into the app. Several macOS packaging
  fix-ups exist only for that reason and have no upstream counterpart:
  `scripts/esbuild-normalization.mjs`, `scripts/native-build-intermediates.mjs`,
  `scripts/macho.mjs`, and the file-descriptor raise in `scripts/release-macos-local.mjs`.
  Expect to keep them across a rebase; each is explained in
  [`docs/install-runbook.md`](docs/install-runbook.md) § 7.

### Patched dependencies

We carry one dependency patch, in `patches/`, wired up through
`pnpm.patchedDependencies`. Patches are the most fragile thing in a downstream repo —
they fail loudly on a version bump — so each one gets a reason and an exit condition here.

- **`@electron/osx-sign@1.3.3`** — bounds `walkAsync()`'s concurrent file-header sniffs to
  32. Unpatched it fans out over the entire `.app` with an unbounded `Promise.all`, holding
  one descriptor per file, which exceeds any `RLIMIT_NOFILE` on a bundle our size (83,897
  files) and fails the signing step with `EMFILE`. `signIgnore` does not help: the walk
  happens before the filter.
  **Drop it when** a release of `@electron/osx-sign` bounds the walk upstream;
  `test/osx-sign-walk-patch.test.mjs` fails and says so when that happens. Background in
  [`docs/install-runbook.md`](docs/install-runbook.md) § 7.

## Why this repo exists

The window in `paperclip-desktop` *is* the Paperclip web app, so any plugin installed on
the server renders inside it with no new code — including
[paperclip-office](https://github.com/whit3hat/paperclip-office), which renders at
`/{company}/office`. A Haven desktop office is therefore a packaging-and-branding job
on top of this shell. Plan and task breakdown live on havenCo issue HAV-32.

## Licences

Upstream is MIT. Its `LICENSE` carries MIT © 2025 Paperclip AI and its README states
MIT © 2026 Aron Prins; both notices stay. Our own additions are Apache-2.0, which is
compatible. `paperclip-office`'s vendored munder-difflin attribution travels with that
plugin, not with this repo.
