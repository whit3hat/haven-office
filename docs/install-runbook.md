# Haven Office — install and release runbook

Written for a teammate with a Mac and no prior context. Parts 1–5 are for installing and
using the app. Parts 6–8 are for whoever cuts the next release.

> **macOS only for now.** There is no Windows or Linux build published yet. The packaging
> for both exists in `release.yml` but nobody has run it, so treat it as untested.

---

## 1. What this is, and what it is not

**Haven Office is a window.** It is an [Electron](https://www.electronjs.org/) desktop shell
around a [Paperclip](https://github.com/paperclipai/paperclip) server, branded for havenCo
and pointed at havenCo's own releases. It can either

- run a **local** Paperclip server bundled inside the app (no terminal, no install steps), or
- connect to a **remote** Paperclip server you already run — for havenCo, that is
  `https://paperclip.lab.havenco.xyz`.

**It is not Paperclip, and it does not change Paperclip.** Everything the app can actually
*do* — agents, companies, issues, budgets, governance — is the upstream Paperclip server,
shipped unmodified via the `@paperclipai/server` npm package. If something inside the window
behaves oddly, that is almost always Paperclip, not this shell. See
[`UPSTREAM.md`](../UPSTREAM.md).

**It is not an official release of anything.** Not of Paperclip, and not of
[`aronprins/paperclip-desktop`](https://github.com/aronprins/paperclip-desktop), the shell
this repo is a downstream copy of. It is havenCo's internal distribution.

**It runs AI agents that can spend real money.** Read the disclaimer in
[`README.md`](../README.md#disclaimer--use-at-your-own-risk) before you connect it to
anything.

---

## 2. Before you start

| You need | Notes |
|---|---|
| A Mac | Apple Silicon (M1 or later) or Intel. macOS 11+ — the app is built against Electron 41. |
| ~1.5 GB free disk | The app bundles a Paperclip server, its `node_modules`, a Node runtime and an embedded Postgres. It is a large `.dmg` by normal standards. This is expected. |
| For remote mode: an account on `paperclip.lab.havenco.xyz` | That server is a **private** deployment in authenticated mode. If you have never signed in, ask for an invite before installing — the app cannot create one. |

Nothing else. No Node.js, no `pnpm`, no terminal.

---

## 3. Install the `.dmg`

1. Go to the [Releases page](https://github.com/whit3hat/haven-office/releases) and open the
   newest release.
2. Download the `.dmg` that matches your Mac:
   - **Apple Silicon** (M1/M2/M3/M4) → the file with `arm64` in the name,
     e.g. `Haven-Office-<version>-arm64.dmg`
   - **Intel** → the `.dmg` *without* `arm64`, e.g. `Haven-Office-<version>.dmg`

   Not sure which you have?  → Apple menu → **About This Mac**. "Apple M…" means Apple
   Silicon.
3. Double-click the `.dmg`. A window opens with the **Haven Office** app on the left and an
   **Applications** shortcut on the right.
4. Drag **Haven Office** onto **Applications**.
5. Eject the disk image (click the ⏏ next to it in Finder's sidebar). You can delete the
   `.dmg` afterwards.

### 3a. First open — the Gatekeeper warning

**Check the release notes for whether the build is signed.** They say so explicitly, and the
release workflow's run summary says which path it took.

**If the build is unsigned** (which it is until havenCo has an Apple Developer ID — tracked on
[HAV-32](/HAV/issues/HAV-32)), the first double-click will **not** open the app. macOS shows
something like:

> **"Haven Office" cannot be opened because Apple cannot check it for malicious software.**
> This software needs to be updated. Contact the developer for more information.

or

> **"Haven Office" can't be opened because it is from an unidentified developer.**

This is expected and it is not a sign that the download is broken. To open it:

1. Open **Applications** in Finder.
2. **Right-click** (or Control-click) **Haven Office** → **Open**.
3. The same warning appears, but now with an **Open** button. Click **Open**.

macOS remembers the decision. Every later launch is a normal double-click.

If right-click → **Open** does not offer that button on macOS 15 (Sequoia) or later, use
 **System Settings** → **Privacy & Security**, scroll to the bottom, and click **Open Anyway**
next to the Haven Office message, then try again.

<details>
<summary>What exactly is unsigned, and is it safe?</summary>

The app carries an *ad-hoc* code signature rather than no signature at all — a bundle with no
signature whatsoever refuses to launch on Apple Silicon outright. An ad-hoc signature proves
the app has not been modified since it was built, but it does not prove **who** built it, and
it has not been notarized (sent to Apple for an automated malware scan). That is what
Gatekeeper is objecting to.

So: the warning is accurate. The thing that makes it safe is that you downloaded the `.dmg`
from `github.com/whit3hat/haven-office`, built by a GitHub Actions run you can inspect, from a
commit you can read. Verify that rather than trusting the dialog. When havenCo has a Developer
ID the warning goes away on its own, with no change to this runbook other than this section
becoming moot.
</details>

**If the build is signed**, the app opens on the first double-click with no warning.

---

## 4. First run

The app opens a small launcher window with two tabs, **Local** and **Remote**.

### 4a. Local mode — a Paperclip server inside the app

Click **Launch** under *Run Local Server*. You will see four steps go by:
*Initializing → Starting database → Starting server → Loading interface*, plus a
*Preparing the office* step. The whole thing takes a minute or two on the very first launch,
because the embedded Postgres has to initialize its data directory.

The window then lands on the **office** view (`/HAV/office`), not the Paperclip dashboard
root. The office is a plugin (`paperclip-office`) that ships inside the app and is installed
into the local server automatically on first boot — there is no terminal step. See
[`local-mode-plugin.md`](local-mode-plugin.md) for how that works and how to turn it off.

Tick **Always start local on launch** if you want to skip the chooser next time.

Local data lives in:

- `~/.paperclip` if you already use the Paperclip CLI (the app shares its data), otherwise
- `~/Library/Application Support/Haven Office`

### 4b. Remote mode — connect to havenCo's server

This is the mode most of the team wants.

> **Prerequisite — that host name only exists on the lab network.** Measured
> 2026-10-18: `paperclip.lab.havenco.xyz` is **NXDOMAIN on public DNS** (the authoritative
> `havenco.xyz` zone is on Route 53 and has no record for it) and resolves, on the lab's own
> resolvers `192.168.4.2` / `192.168.4.3`, to the **private address `192.168.4.8`**. So the
> Mac you install on must (a) be on the lab LAN or VPN, and (b) be using the lab's DNS
> servers. Neither is something the app can arrange. Confirm both in one command before you
> click anything:
>
> ```sh
> curl -sS -m 8 -o /dev/null -w '%{http_code}\n' https://paperclip.lab.havenco.xyz/api/health
> ```
>
> `200` means you are good. `Could not resolve host` is DNS — compare `scutil --dns | grep
> nameserver` against the two addresses above. A timeout means DNS is fine but you are not on
> the network that can route to `192.168.4.8`.
>
> The certificate is a **real Let's Encrypt certificate** for that name (CN
> `paperclip.lab.havenco.xyz`, issuer `Let's Encrypt YE2`, expires 2027-01-02), so there is no
> lab CA to install and TLS should never be the problem here.

1. Click the **Remote** tab, then **Connect to Remote**.
2. In **Remote URL**, enter:

   ```
   https://paperclip.lab.havenco.xyz
   ```

3. Click **Verify Remote**. The app calls that server's `/api/health` and
   `/api/auth/get-session` before it will load anything, and should report
   *"Verified authenticated Paperclip remote detected."*
4. Optionally give it a **Display name** — e.g. `havenCo lab` — so it is easy to pick from
   saved connections later. Tick **Reconnect to this remote on launch** to make it the
   default.
5. Click **Connect & Save**.

The window opens the remote server in a restricted Electron window locked to that exact
origin: the app will not follow a link off `paperclip.lab.havenco.xyz`.

#### Signing in

Sign-in happens **inside** the app window, using the server's own login page — the shell has
no login of its own and stores no password. Use the same credentials you would use in a
browser against that URL.

If you have no account, you need an invite from a board member of that Paperclip instance.
The app cannot bootstrap one; verification will succeed and you will simply land on a
sign-out state.

Once signed in, the window lands on `/HAV/office`. The **View** menu switches between
**Office** and **Board**. The app remembers the last view per connection and reopens there.

> **HTTP is blocked by default.** If you ever point this at an `http://` URL, the app refuses
> until you explicitly tick *"I understand the risk and want to allow this HTTP connection"*.
> Do not do that for anything outside a local network.

### 4c. The first-launch check — please confirm these four things

The office-first start path has unit tests but has never been seen running: no agent on this
project has a Mac or a display, so the first person to install the `.dmg` is the first person
to watch the window open. If any of the four below is wrong, say so on the issue — it is a
regression in the start-path work, not an install problem, and it gets fixed in code.

| # | What to do | What should happen |
|---|---|---|
| 1 | Connect and sign in (§ 4b) | The window lands on **`/HAV/office`** — the office, not the issue board and not the dashboard root |
| 2 | Look at the office view | The office actually renders — rooms and desks, not a blank pane, a spinner that never resolves, or a 404 |
| 3 | Press **`Cmd+1`**, then **`Cmd+2`** | `Cmd+1` → the office (`/HAV/office`); `Cmd+2` → the board (`/HAV/issues`). Both are also in the **View** menu, which is the thing to try if a shortcut is swallowed by the page |
| 4 | Switch to **Board**, quit with `Cmd+Q`, reopen the app | It reopens on the **board**, not the office — the last view is remembered. Switch back to Office, quit, reopen, and it should come back on the office |

Two notes on what is *not* a fault:

- **The remembered view is per connection**, stored as `lastViewPath` against that saved
  connection profile ([`src/connection/profiles.ts`](../src/connection/profiles.ts)). Local
  mode and a remote each remember their own, so they can legitimately differ.
- **Only the path is stored, never the origin.** A remembered view can never send the window
  to a different host; if a stored path fails the origin check it is discarded and you land on
  the office instead. Falling back to the office is the designed behaviour, not an error.

---

## 5. Auto-updates

The app checks `whit3hat/haven-office` GitHub Releases for a newer version **on launch and
then every 4 hours**, and you can force a check from the menu (**Check for Updates…**).

- It does **not** download silently in the background on a manual check — it asks first.
- On a scheduled check it downloads automatically, then prompts you to restart.
- Choosing *Later* keeps the update staged; it installs the next time you quit.
- The update feed is `latest-mac.yml`, published as an asset on each release. A release
  without that file is invisible to the updater; see part 7.
- Before any release exists, update checks log a 404 and report "up to date". That is handled
  deliberately, not a bug.

Updates are only checked in packaged builds — a `pnpm dev` run never updates itself.

**An update inherits the signing state of the release it came from.** If the running app is
unsigned and the new release is unsigned, the update applies without a Gatekeeper prompt
(macOS already trusts the app you opened). The first *signed* release will replace the app
with a signed one, which is strictly an improvement.

---

## 6. What a human must add before a signed release is possible

**No agent holds Apple credentials and none are committed to this repo.** A person with
access to havenCo's Apple Developer account must add these as **repository secrets**
(Settings → Secrets and variables → Actions → Repository secrets) *and* make them available to
the `release` [GitHub Environment](https://github.com/whit3hat/haven-office/settings/environments),
because `build-mac`, `notarize-submit` and `notarize-status` all declare `environment: release`.

### Checklist — code signing (needed for a signed `.dmg`)

- [ ] **`APPLE_CODESIGN_IDENTITY`** — the full identity string, exactly as
      `security find-identity -v -p codesigning` prints it, including the team in
      parentheses. Example shape:
      `Developer ID Application: havenCo Ltd (ABCDE12345)`
- [ ] **`MAC_CERTIFICATE_P12_BASE64`** — the *Developer ID Application* certificate **and its
      private key**, exported from Keychain Access as a `.p12`, then base64-encoded
      (`base64 -i cert.p12 | pbcopy`). Whitespace and line breaks are tolerated.
- [ ] **`MAC_CERTIFICATE_PASSWORD`** — the password set on that `.p12` export.
- [ ] *(optional)* **`APPLE_TEAM_ID`** — the 10-character team ID. Omit it and the build
      parses it out of `APPLE_CODESIGN_IDENTITY`; set it only if that parse is wrong.

### Checklist — notarization (needed to remove the Gatekeeper warning)

Signing alone is not enough: Gatekeeper still warns about a signed-but-not-notarized app
downloaded from the internet. Notarization needs an **App Store Connect API key**
(Users and Access → Integrations → App Store Connect API), with the *Developer* role or
higher.

- [ ] **`APPLE_API_KEY_ID`** — the key ID, e.g. `2X9…`.
- [ ] **`APPLE_API_ISSUER`** — the issuer UUID shown on the same page.
- [ ] **`APPLE_API_KEY_P8`** — the contents of the downloaded `AuthKey_<KEYID>.p8`. Either the
      raw PEM text, or base64 of it; `notarize-submit.yml` accepts both and also repairs
      literal `\n` escapes.

### What each workflow actually reads

Everything below is inherited from upstream; this is an inventory, not a design.

| Workflow | Reads | Required for it to run? |
|---|---|---|
| `release.yml` → `build-mac` | `APPLE_CODESIGN_IDENTITY`, `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID` | **No.** All four absent → unsigned ad-hoc build. All three of the first group present → signed build. There is no half-state: the job prints which path it took to the run summary. |
| `release.yml` → `publish-mac` | `GITHUB_TOKEN` (automatic) | Nothing to add. |
| `release.yml` → `build-linux`, `build-windows` | nothing | Windows builds are **unsigned**; see [`windows-signing-guide.md`](development/windows-signing-guide.md). |
| `release.yml` → `publish-release` | `GITHUB_TOKEN` (automatic) | Windows/Linux only — it is skipped whenever `build-mac` runs. |
| `smoke-packaged-macos.yml` | `GITHUB_TOKEN` (automatic) | Nothing to add. Works against draft and published releases. |
| `notarize-submit.yml` | `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`, `GITHUB_TOKEN` | **Yes** — all three Apple values. The job fails immediately without them. |
| `notarize-status.yml` | `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` | **Yes**, same three. |

No workflow reads a repository *variable* (`vars.*`). Owner and repo are not configurable:
they are hard-coded as `whit3hat` / `haven-office` in `electron-builder.yml`, in
`buildStageConfig` in `scripts/release-macos-local.mjs`, and resolved from
`github.repository` everywhere else.

### Also needed from a human, regardless of signing

- [ ] A **`release` GitHub Environment** must exist on the repo. `build-mac`,
      `notarize-submit` and `notarize-status` declare `environment: release` and will fail to
      start without it. It needs no protection rules to work; add required reviewers if you
      want release builds gated.
- [ ] Someone with a **Mac** must actually install the `.dmg` and confirm the app opens and
      reaches a Paperclip server. No agent and no CI job can do this. The packaged smoke test
      (part 7, step 4) proves the bundled server boots; it does not prove the UI renders.

---

## 7. Cutting a release

**The workflows are manually dispatched (`workflow_dispatch`), not triggered by pushing a
tag.** That is deliberate and we kept upstream's shape:

- it matches upstream exactly, so rebasing onto upstream stays cheap — and keeping rebases
  cheap is the stated reason this repo exists as a thin downstream ([`UPSTREAM.md`](../UPSTREAM.md));
- a macOS release is not one button. Signing, notarization and stapling are separate
  credentialed steps that happen *between* build and publish, so an automatic trigger would
  have to be interrupted anyway;
- pushing a tag is cheap and reversible; starting a signed release by accident is not.

The cost is that every release needs someone to click **Run workflow**. For a team release
cadence measured in weeks, that is the right trade. Revisit it if releases become frequent
enough that the clicking is the bottleneck.

### Version numbers

Haven Office uses **CalVer: `YYYY.M.N`** — e.g. `2026.10.0`, tagged `v2026.10.0`.

It does **not** continue upstream's `3.x` numbering, for a concrete reason: this repo contains
the entire upstream history including every upstream tag, so `v3.2.15` and all its siblings
already exist on `origin` and cannot be reused. A `3.x` scheme would collide the moment
upstream ships the same number. CalVer cannot collide with upstream's `3.x` line, ever, and
it still sorts monotonically for `electron-updater`, which compares versions as semver.

`N` is the release number within that month, starting at `0`. The bundled upstream Paperclip
server version is independent of this and is recorded in
[`development/release-runbook.md`](development/release-runbook.md).

#### Not every tag is a release

**`v2026.10.6` is the first and, as of 2026-10-18, only published release.** `v2026.10.0`
through `v2026.10.5` are tags with **no release behind them**: each one is a `Release Desktop`
run that failed in macOS packaging or verification, and the tag was pushed before the run
proved itself. `GET /releases` returned `[]` for all six.

So **do not install from a tag** — a tag may have no assets at all. Install from the
[releases page](https://github.com/whit3hat/haven-office/releases), which only ever lists runs
that packaged, verified and published. What each of those six failures was, and the fix it
produced, is recorded in step 3 below.

### Steps

1. **Bump the version and push it.**

   ```sh
   pnpm pkg set "version=<YYYY.M.N>"
   git commit -am "release: v<YYYY.M.N>"
   git push origin master
   ```

   If you also want to move the bundled Paperclip server version, do that first and follow
   [`development/release-runbook.md`](development/release-runbook.md) — it covers pinning
   `@paperclipai/server`, and that is the more delicate half of a release.

2. **Create and push the tag.** `publish-mac` will not run for a ref that is not a `v…` tag,
   and the upload script uses `gh release create --verify-tag`, so the tag must exist on
   GitHub *before* the workflow runs.

   ```sh
   git tag -a v<YYYY.M.N> -m "v<YYYY.M.N>"
   git push origin v<YYYY.M.N>
   ```

3. **Dispatch `Release Desktop`.** Actions → **Release Desktop** → **Run workflow**:

   | Input | Value |
   |---|---|
   | `ref` | `v<YYYY.M.N>` — the tag you just pushed |
   | `platforms` | `mac` |

   Takes roughly 40–60 minutes: it builds x64 and arm64 from scratch, each with its own
   staged `npm install` of the bundled server.

   That staged install **needs npm 11 or newer.** npm 10 — the version bundled with Node 22 —
   crashes partway through it with `Cannot read properties of null (reading 'edgesOut')`,
   naming no package and no cause (reproduced on 10.9.9, fixed on 11.19.0). The three build
   jobs install `npm@11.19.0` before building, and `scripts/npm-preflight.mjs` fails the
   build up front with that explanation if something ever runs it on npm 10. If you build on
   your own Mac, `npm install -g npm@11` first.

   Packaging also hits `EMFILE: too many open files`, for **two separate reasons**. Both are
   fixed; this is recorded because the error lands *after* signing logs a success line, which
   makes it read as a signing problem, and it is not.

   The first is macOS's default soft limit of 256 open files. `release-macos-local.mjs` spawns
   electron-builder through a shell that raises the soft limit first (highest the hard limit
   allows, down to 2048) and prints what it got — look for
   `[release-local] file descriptor soft limit:` in the log.

   Raising the limit alone is **not** enough, which [`Release Desktop` #3](https://github.com/whit3hat/haven-office/actions/runs/39079436117)
   proved by failing at 65536. The real cause is in the signer: `@electron/osx-sign`'s
   `walkAsync()` recurses the whole `.app` with an unbounded `Promise.all` and opens every
   regular file to sniff its Mach-O header, so it holds **one descriptor per file in the
   bundle, all at once**. Haven Office stages 83,897 files in the server bundle alone, so no
   achievable limit is sufficient. `signIgnore` cannot help — `dist/cjs/sign.js` walks first
   and filters afterwards.

   So `patches/@electron__osx-sign@1.3.3.patch` (a `pnpm.patchedDependencies` entry) bounds
   the concurrent sniffs to 32. Measured on Linux over 2,880 files: unpatched peaks at 2,880
   open descriptors, patched at exactly 32. `test/osx-sign-walk-patch.test.mjs` asserts both
   numbers, so the patch cannot silently stop applying, and it tells you to drop the patch if
   a future `@electron/osx-sign` bounds the walk upstream. Nothing to do by hand on CI or on
   your own Mac — `pnpm install` applies the patch.

   **Cross-arch esbuild, and why the x64 bundle needs fixing up.** GitHub's `macos-latest`
   runners are Apple Silicon, so building the **x64** bundle is a cross-install, and npm does
   not cross-install esbuild correctly. Measured 2026-10-18 with npm 11.19.0: `npm install
   --production --os=darwin --cpu=x64 --arch=x64` of `@paperclipai/server` installs the
   **build host's** platform package (`@esbuild/darwin-arm64` on the runner,
   `@esbuild/linux-x64` when reproduced here) and *not* `@esbuild/darwin-x64`. `--os`/`--cpu`
   do not reach these optional platform dependencies. esbuild's `postinstall` then also runs
   on the host, overwriting `<pkg>/bin/esbuild` with a host binary and downloading a second
   host copy to `<pkg>/lib/downloaded-@esbuild-<host-platform>-esbuild`.

   That produces two distinct failures, and both have happened:

   - [`Release Desktop` #4](https://github.com/whit3hat/haven-office/actions/runs/39081663700)
     built both DMGs and then `verify-macos-release.mjs` correctly refused an arm64 Mach-O
     binary inside an x86_64 app.
   - [`Release Desktop` #5](https://github.com/whit3hat/haven-office/actions/runs/39083766972)
     failed in `prepare-server`, because the first fix assumed the target platform package was
     already sitting beside each nested `esbuild` copy. It is not there at all.

   So `scripts/esbuild-normalization.mjs` **materializes** `@esbuild/darwin-<arch>` next to
   every nested `esbuild` copy, from an `npm pack` of the real package, and prunes every
   host-arch leftover — the foreign `@esbuild/<platform>` packages and the foreign
   `downloaded-…` files. Materializing it beside the copy is what the runtime actually
   resolves: esbuild's `generateBinPath()` does
   `require.resolve("@esbuild/darwin-<arch>/bin/esbuild")` from inside `esbuild/lib/main.js`,
   and node's lookup walks that copy's own `node_modules` directory. Overwriting
   `bin/esbuild` — all the script used to do — only ever fixed direct CLI invocations, not the
   JS API the server uses.

   In the log, look for `[prepare-server] Normalized …`, each followed by its
   `platform package:` line, and `Pruned foreign esbuild platform package`. The verifier's
   architecture check was deliberately **not** loosened in either fix.

   **node-gyp build intermediates, and the signature that can never exist.**
   [`Release Desktop` #6](https://github.com/whit3hat/haven-office/actions/runs/39086082730)
   built both DMGs, signed the whole bundle, and then failed verification on
   `cpu-features/build/Release/obj.target/cpu_features/deps/cpu_features/src/filesystem.o`
   with `code object is not signed at all`.

   A `*.o` is a Mach-O relocatable object, so `@electron/osx-sign` picks it up — it signs
   whatever `isBinaryFile` reports as binary — but `codesign` cannot attach a signature to a
   relocatable object, so the file stays unsigned and `codesign --verify --strict` then
   objects. **This is not specific to the unsigned path**; a signed build fails identically.

   Any package node-gyp compiles leaves its whole intermediate tree beside the addon it
   produced: `*.o`, `*.a`, `*.d`, `.deps/`, and the generated `Makefile`/`*.target.mk`.
   Only the linked `*.node` is ever loaded. So `scripts/native-build-intermediates.mjs`
   prunes them from the assembled bundle, and `scripts/macho.mjs` reads the Mach-O
   **filetype** so the verifier stops demanding a signature on a relocatable object
   (`MH_OBJECT`) or a debug companion (`MH_DSYM`) — while keeping both in the architecture
   check, where a wrong-arch object really does mean a broken cross-compile.

   The prune is narrow by measurement, not by hope. The directory name `build` is **not** the
   signal: of the 15 `build` directories in the real cross-installed server tree (measured
   2026-10-18), only one — ssh2's native `sshcrypto` binding — is node-gyp output, and the
   other 14 hold compiled JavaScript (`three`, `pino`, `yargs`, `@grpc/grpc-js`,
   `@opentelemetry/api`, …). A directory is treated as node-gyp output only when it carries
   one of `config.gypi`, `binding.Makefile`, `Release/` or `Debug/`, and within one only
   named intermediates are removed. Every `*.node` and every `*.dylib`/`*.so` is kept.

   In the log, look for `[prepare-server] Pruned N build intermediate(s) from M node-gyp
   build director(ies)`. If the verifier ever does report an unsignable Mach-O it lists it
   under `unsignableMachOObject` rather than failing, which means something shipped an
   object file the prune did not recognise — worth a look, not a release blocker.

   The run does three things in order:

   - `build-mac` prints **signed** or **unsigned** to the run summary, builds both arches
     via `pnpm release:mac:local`, and runs `scripts/verify-macos-release.mjs` on each — which
     checks every Mach-O payload is signed, that packaged native binaries match the bundled
     Node architecture, and that the bundled server has its UI, dependencies and catalog
     manifests. **If that fails, the release stops here.** That is the intended behaviour.
   - it merges both arches' `latest-mac.yml` into one updater manifest
     (`prepare-macos-release-assets.mjs`).
   - `publish-mac` creates a draft release at your tag, uploads the DMGs, ZIPs and blockmaps,
     then adds `latest-mac.yml` and flips the draft to published.

   > **Dispatching with `ref=master` publishes nothing.** It builds and verifies and leaves a
   > CI artifact. That is the right way to test a change to the release pipeline without
   > creating a release.

4. **Run the packaged smoke test.** Actions → **Smoke Packaged macOS Release** → **Run
   workflow**, with `tag=v<YYYY.M.N>`. Run it **twice**, once with `arch=arm64` and once with
   `arch=x64`, because each runs on a native runner of that architecture.

   It downloads the release's ZIP, launches the real packaged app with an isolated
   `userData` and `PAPERCLIP_HOME`, and asserts the bundled server comes up and serves
   `/get-session`, `/api/skills/catalog` and `/api/teams/catalog` — and that the app never
   touched the production data directories.

   Record both results on the release issue. A green smoke test plus a green
   `verify-macos-release` is the bar for telling the team to install.

5. **Notarize — only if the build is signed.** Skip this entirely for an unsigned build;
   there is nothing to notarize. Otherwise follow
   [`development/release-runbook.md`](development/release-runbook.md), which covers
   `notarize-submit.yml`, `notarize-status.yml`, stapling, and re-uploading the stapled
   assets. Do not announce a signed release before `xcrun stapler validate` passes.

6. **Tell the team**, and say plainly whether the build is signed. If it is not, link part 3a
   of this document in the same message — otherwise the first person to double-click it will
   reasonably assume the download is broken.

### If you need to undo a release

Releases are reversible. Deleting the GitHub release (or marking it a draft again) removes
`latest-mac.yml` from the feed, and the updater immediately stops offering it. Anyone who
already installed it keeps it; publish a higher version to move them.

---

## 8. Troubleshooting

| Symptom | What to do |
|---|---|
| **"cannot be opened because Apple cannot check it"** | Expected on an unsigned build. Part 3a. |
| **"The application is damaged and can't be opened"** | Not the Gatekeeper warning — this one means the download is actually corrupt, or the app was modified after signing. Re-download the `.dmg`. |
| **Wrong architecture** — app is very slow, or won't start | You installed the Intel `.dmg` on Apple Silicon or vice versa. Check About This Mac, delete the app, install the other one. |
| **Local mode hangs on "Starting database"** | First launch initializes an embedded Postgres and is slow. If it is still stuck after ~5 minutes, check the server log (below). |
| **Local mode opens but the office page 404s** | The bundled office plugin failed to install. The app deliberately opens anyway rather than refusing to launch. Check the server log for `[plugins]`, and see [`local-mode-plugin.md`](local-mode-plugin.md). Use the **View → Board** menu item to get a working view meanwhile. |
| **Remote verification fails** | The app tells you which check failed — see [the table below](#remote-verification-messages) for what each message means. A private authenticated deployment redacting fields is fine and still verifies; a wrong host or an offline server is not. Confirm the URL works in a browser first. |
| **Signed in on the web but not in the app** | Sessions are not shared with your browser. Sign in inside the app window. |
| **No updates ever offered** | Check that the newest release has a `latest-mac.yml` asset and is not a draft or prerelease. |

<a id="remote-verification-messages"></a>

### Remote verification messages

**Verify Remote** makes exactly two requests — `GET /api/health` and
`GET /api/auth/get-session` against the origin you typed — and reports the first thing that
goes wrong. It probes over the same Chromium network session the connection itself will
use, so a pass here means the real connection can reach the host too.

| What it says | What it means | What to do |
|---|---|---|
| **TLS validation failed** — *"self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)"*, *"certificate has expired"*, *"unable to verify the first certificate"* | The host answered, but macOS does not trust its certificate. | **Not expected against `paperclip.lab.havenco.xyz`** — that host serves a real Let's Encrypt certificate (measured 2026-10-18, see part 4b), so this message there means something is intercepting TLS. For a different lab host behind a private CA, install the CA in **Keychain Access → System → Certificates** and mark it trusted. The app uses the system trust store, so once Safari trusts the host, so does Haven Office. |
| **Host unreachable** — *"getaddrinfo ENOTFOUND … (ENOTFOUND)"*, *"net::ERR_NAME_NOT_RESOLVED"* | **DNS.** The name never resolved on this Mac. This is the most likely cause for our own remote: the name exists only in the lab's internal DNS (part 4b). | Point the Mac at the lab resolvers `192.168.4.2` / `192.168.4.3`, or get on the VPN that hands them out. Check with `scutil --dns \| grep nameserver`. |
| **Host unreachable** — *"connect ECONNREFUSED … (ECONNREFUSED)"* | The name resolved and the host answered, but nothing is listening on that port. | Check the port in the URL. `https://` with no port means 443. |
| **Host unreachable** — *"net::ERR_CONNECTION_TIMED_OUT"*, *"ETIMEDOUT"*, *"EHOSTUNREACH"* | The name resolved but the address never answered — DNS is fine, routing is not. | `paperclip.lab.havenco.xyz` resolves to the **private** address `192.168.4.8`, so you must be on the lab LAN or VPN. A coffee-shop network will always time out here. |
| **Host reachable, not Paperclip** — *"…/api/health redirected (HTTP 302) to …"* | A gateway or SSO proxy is intercepting the probe. The app deliberately does **not** follow redirects while verifying, because the URL is untrusted at that point. | Point the connection at the Paperclip origin itself rather than a vanity or gateway URL. |
| **Host reachable, not Paperclip** — *"…answered with "text/html" rather than JSON"* | Something is listening, but it is not a Paperclip server — often a default web-server landing page. | Check the port and hostname. |
| **Remote not eligible** | The server is configured for loopback-only local use. | It needs reconfiguring to authenticated mode; that is a server-side change, not a client one. |
| **Remote auth is not ready** | Paperclip is up but its auth subsystem has not finished starting. | Wait and retry. If it persists, the server needs attention. |

> If the message is just the bare word **"fetch failed"** with no reason after it, you are on
> a build older than `v2026.10.7`. That build could not report *why* a connection failed.
> Update before troubleshooting any further.
>
> If **"Host unreachable"** appears with no sentence distinguishing DNS from a refusal from a
> timeout, you are on a build older than `v2026.10.8`. From `v2026.10.8` the detail names which
> of the three it was and what to check. On `v2026.10.6` and earlier the badge was also shown
> for **TLS** failures, so it did not even mean what it said.

**The server log** is the first place to look for anything local-mode related:

```sh
open ~/Library/Application\ Support/Haven\ Office/server.log
```

(or `~/.paperclip/…` if the app is sharing data with the Paperclip CLI — the launcher prints
which `PAPERCLIP_HOME` it resolved.)

To start completely fresh, quit the app and move that whole directory aside. **This deletes
all local Paperclip data**, which has no backup.

---

## Related documents

- [`README.md`](../README.md) — what the app is, development commands, licences
- [`UPSTREAM.md`](../UPSTREAM.md) — provenance, the upstream sync path, why `master`
- [`development/release-runbook.md`](development/release-runbook.md) — the full upstream
  release procedure: pinning the bundled server, notarization, stapling, staged rollout
- [`development/macos-staged-release.md`](development/macos-staged-release.md) — how the
  staged macOS build works and why it exists
- [`local-mode-plugin.md`](local-mode-plugin.md) — the bundled office plugin
- [`baseline.md`](baseline.md) — what this repo was verified to do, and on what
