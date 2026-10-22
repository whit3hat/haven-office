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

**Where that control is**, because it is easy to end up on a screen that has no local
anything on it (the owner reported exactly that on 2026-10-21, as *"the only version is
remote, there is no local version"*):

- The first screen has **two tabs at the top: `Local` and `Remote`.** *Run Local Server*
  lives under **Local**. The app opens on whichever tab you used last, so after you have
  added a remote it opens on **Remote** — click **Local** to get back.
- If you ticked **Reconnect to the selected remote on launch**, the app skips that screen
  altogether and goes straight to the remote. When that remote then fails you land on the
  **error** screen, which carries a primary **Switch to Local** button and a
  **← Back to chooser** link. Either one reaches local mode without reinstalling.
- Verified against the shipped `v2026.10.13` source (`src/launcher-html.ts`): both tabs
  and both of those buttons are **always** rendered — there is no build, licence or
  server condition that removes local mode. If **Launch** is visible but local mode does
  not come up, that is a different failure and worth reporting with whatever the four
  steps got stuck on.

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

<a id="remote-prerequisites"></a>

> **Prerequisite — that host name only exists on the lab network.** Measured
> 2026-10-18: `paperclip.lab.havenco.xyz` is **NXDOMAIN on public DNS** (the authoritative
> `havenco.xyz` zone is on Route 53 and has no record for it) and resolves, on the lab's own
> resolvers `192.168.4.2` / `192.168.4.3`, to the **private address `192.168.4.8`**. So the
> Mac you install on must (a) be on the lab LAN or VPN, and (b) be using the lab's DNS
> servers. Neither is something the app can arrange. Confirm both in one command before you
> click anything:
>
> ```sh
> curl -sS -m 8 -o /dev/null \
>   -w 'http=%{http_code} ip=%{remote_ip} tls=%{ssl_verify_result}\n' \
>   https://paperclip.lab.havenco.xyz/api/health
> ```
>
> `http=200 ip=192.168.4.8 tls=0` means you are good, and the `ip=` is worth reading rather
> than skipping: a *different* address means some other network's DNS answered this name, and
> whatever is at that address is not our server. `Could not resolve host` is DNS — compare
> `scutil --dns | grep nameserver` against the two addresses above. A timeout means DNS is fine
> but you are not on the network that can route to `192.168.4.8`.
>
> If that command succeeds but the app still fails, the next thing to compare is the
> *protocol*, because the app's network stack is Chromium's and does not make the same choice
> `curl` does. This host is behind Caddy and advertises `alt-svc: h3=":443"` (measured
> 2026-10-21), which invites a browser stack to retry the same request over **QUIC on UDP
> 443**. Plenty of networks pass TCP 443 and drop UDP 443, and the failure then looks like a
> connection that ends with no reply:
>
> ```sh
> curl -sS -m 8 -o /dev/null -w 'h2=%{http_code}\n' --http2 https://paperclip.lab.havenco.xyz/api/health
> curl -sS -m 8 -o /dev/null -w 'h3=%{http_code}\n' --http3 https://paperclip.lab.havenco.xyz/api/health
> ```
>
> `h2=200` with `h3` failing or hanging is that case. (`curl: option --http3: is unknown` just
> means your `curl` has no HTTP/3 support and the test is inconclusive, not that it passed.)
>
> The certificate is a **real Let's Encrypt certificate** for that name (CN
> `paperclip.lab.havenco.xyz`, issuer `Let's Encrypt YE2`, expires 2027-01-02), so there is no
> lab CA to install and TLS should never be the problem here.

> **Prerequisite — macOS Local Network permission. `curl` working does not mean the app
> can connect.** Since macOS 15 (Sequoia), an app that opens a connection to a
> **private** address — which `192.168.4.8` is — is blocked until you grant it *Local
> Network* access. Terminal already holds that grant, which is why the `curl` above can
> return `200` on a Mac where the app still reports the host unreachable. That is the
> single most confusing failure in this whole document, so check it **before** you
> conclude anything is broken:
>
> **System Settings → Privacy & Security → Local Network → enable *Haven Office*.**
>
> macOS is supposed to ask the first time the app tries. Electron apps are widely
> reported to miss that prompt, so the row may need enabling by hand, and in some cases
> the app does not appear in the list at all until it has tried once — open it, attempt
> **Verify Remote**, then look again. Builds **before `v2026.10.11`** declare no Local
> Network purpose string at all and therefore **can never appear in that list**; on
> macOS 15+ they cannot reach the lab remote by any means. Upgrade rather than fighting
> it.

<a id="lab-remote-server-half"></a>

> **The server half of this check is known good — do not re-diagnose it.** Both
> requests **Verify Remote** makes were run against `https://paperclip.lab.havenco.xyz`
> from inside the lab on **2026-10-21 00:36 UTC**, with no credentials, exactly as the
> app issues them:
>
> | Request | Answer |
> |---|---|
> | `GET /api/health` | `HTTP 200` over **HTTP/2**, `content-type: application/json`, `via: 1.1 Caddy`, `alt-svc: h3=":443"`, **no redirect**. Body: `status:"ok"`, `deploymentMode:"authenticated"`, `deploymentExposure:"private"`, `bootstrapStatus:"ready"`, `bootstrapInviteActive:false`. No `authReady` and no `version` — the redacted private shape, which `parseHealthPayload` accepts (`src/connection/preflight.ts`, `hasRedactedAuthenticatedShape`). |
> | `GET /api/auth/get-session` | `HTTP 401`, JSON `{"error":"Board authentication required"}` — the exact payload `isPaperclipAuthRequiredPayload` matches, so the app reads it as `signed_out`, not as a fault. |
>
> So a Mac that can reach this host gets **a pass**, in the amber *"sign-in required"*
> shape described in step 3. A red failure therefore rules out **the server** — but not the
> app. The remaining candidates are the path between the Mac and the host (DNS, LAN route,
> Local Network permission, HTTP/3 over UDP 443, something intercepting TLS) **and the build
> you are running**. Keep both: this section said "it is between the Mac and the host" until
> 2026-10-21, and that sentence is what sent a whole night of diagnosis at a network that was
> working, while the actual defect was one line in `v2026.10.13`'s probe (§ 8, and
> [`f157b3e2`](https://github.com/whit3hat/haven-office/commit/f157b3e2)). **The question that
> separates them costs nothing: if Verify Remote fails the same way against a plain public
> `https://` host as it does against this one, the app is not completing any request and the
> network is not the subject.**
>
> Re-measured **2026-10-21 00:46 UTC**, unchanged, after the owner reported a failed
> verification on `v2026.10.13`: `http=200 ip=192.168.4.8 tls=0`, `t_connect=0.0003s`,
> `t_total=0.033s`.

1. Click the **Remote** tab, then **Connect to Remote**.
2. In **Remote URL**, enter:

   ```
   https://paperclip.lab.havenco.xyz
   ```

3. Click **Verify Remote**. The app calls that server's `/api/health` and
   `/api/auth/get-session` before it will load anything, and should report
   *"Verified authenticated Paperclip remote detected."*

   **On a fresh install the badge above that line reads *"Verified remote -
   sign-in required"*, in amber, and that is a pass, not a failure.** You have not
   signed in yet, so there is no session for the probe to find; the green
   sentence and an enabled **Connect Remote** button are what tell you the check
   succeeded. A real failure is red, says **"Could not verify remote"** or
   names a specific fault, and leaves **Connect Remote** greyed out — see
   [the message table](#remote-verification-messages).
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

> **The office on a remote is the server's, not the app's.** On a remote connection every
> page you see is served by that server, and `/HAV/office` exists only if the **server** has
> the `paperclip-office` plugin installed. The copy bundled inside this app is installed into
> **local mode only** — it is never pushed to a remote. Measured 2026-10-18: the lab server at
> `paperclip.lab.havenco.xyz` does **not** have it. The server answers every path with the web
> app shell (HTTP 200 — even `/HAV/definitely-not-a-page`) and the client-side router renders
> **"Page not found"** for routes it does not know, so on that remote `Cmd+2` / the **Board**
> work normally while `Cmd+1` / **Office** shows *Page not found*. That is a server-side
> deployment gap, not a fault in this app or anything this runbook can fix; it resolves when
> `paperclip-office` is installed on the server itself.

> **HTTP is blocked by default.** If you ever point this at an `http://` URL, the app refuses
> until you explicitly tick *"I understand the risk and want to allow this HTTP connection"*.
> Do not do that for anything outside a local network.

### 4c. The first-launch check — please confirm these seven things

The office-first start path has unit tests but has never been seen running: no agent on this
project has a Mac or a display, so the first person to install the `.dmg` is the first person
to watch the window open. If any of the seven below is wrong, say so on the issue.

> **Install `v2026.10.13` or newer for the whole card.** Rows 5–7 are the menu-bar surface,
> which first ships in `v2026.10.13`; on any older build there is no menu-bar item to find and
> rows 5–7 are not applicable rather than failing. Rows 1–4 need `v2026.10.12` or newer, for
> the two separate reasons below.

> **Known broken in `v2026.10.6` and `v2026.10.7`: rows 1 and 2 will fail.** Those builds
> shipped with **no bundled plugins at all**, so there is no office to land on and the view
> 404s. It is a packaging defect, not a start-path one: the staged macOS build generates its
> own electron-builder config, and that config had no `app-server/plugins` mapping, so the
> plugin `prepare-server` staged was never copied into the `.app`. Preinstalling is
> deliberately non-fatal, so the app opened and said nothing. Caught by the packaged smoke
> test on
> [`Smoke Packaged macOS Release` #3](https://github.com/whit3hat/haven-office/actions/runs/39147656576):
> *"Bundled plugins were not installed within 180000ms (installed plugins: none)"*.

> **Also broken in `v2026.10.10` and `v2026.10.11`, for a second and unrelated reason: rows 1
> and 2 will still fail.** Those builds *do* ship the plugin — `verify-macos-release` proves
> it is in the packed `.app` — but installing it fails at first launch:
>
> ```
> [plugins] paperclip-office could not be provisioned: HTTP 400:
>   {"error":"ENOENT: no such file or directory, scandir
>    '.../Contents/Resources/app-server/plugins/paperclip-office/migrations'"}
> ```
>
> `paperclip-office@0.1.2` declares `database.migrationsDir: "migrations"` and ships that
> directory holding nothing but `.gitkeep`. The server `readdir`s it while installing, so the
> directory must exist; a directory whose only member is a dotfile does not reliably survive
> staging and packaging, and nothing creates an empty directory for you. The install
> transaction rolls back, the plugin never registers, and the office 404s — while every other
> endpoint answers normally.
>
> Fixed in **`v2026.10.12`**: staging gives the directory a non-dotfile member, and
> `assertStagedPluginPackage` now fails the build when a declared migrations directory is
> absent from the packed `.app`. That assertion previously checked only entrypoints, which is
> why `v2026.10.10` passed verification and shipped anyway. **Check rows 1–2 against
> `v2026.10.12` or newer**; on anything older use **View → Board**.

> **On the lab remote, rows 1–3 currently show "Page not found" on *every* build — including
> `v2026.10.12`.** That is not an app defect and not an H3 regression: on a remote connection
> the office page is served by the remote server, and the lab server does not have the
> `paperclip-office` plugin installed (measured 2026-10-18; see the note in § 4b). The
> navigation itself is working — `Cmd+1` lands exactly where it should, on a page the server
> cannot serve yet. Until the plugin is installed server-side, confirm rows 1–3 in **local
> mode** (§ 4a, `v2026.10.12` or newer), where the bundled plugin provides the office. Row 4
> and the remote connection itself can be confirmed in either mode.

| # | What to do | What should happen |
|---|---|---|
| 1 | Start the app — local mode (§ 4a), or a remote whose server has the office plugin (see the note above) | The window lands on **`/HAV/office`** — the office, not the issue board and not the dashboard root |
| 2 | Look at the office view | The office actually renders — rooms and desks, not a blank pane, a spinner that never resolves, or a 404 |
| 3 | Press **`Cmd+1`**, then **`Cmd+2`** | `Cmd+1` → the office (`/HAV/office`); `Cmd+2` → the board (`/HAV/issues`). Both are also in the **View** menu, which is the thing to try if a shortcut is swallowed by the page |
| 4 | Switch to **Board**, quit with `Cmd+Q`, reopen the app | It reopens on the **board**, not the office — the last view is remembered. Switch back to Office, quit, reopen, and it should come back on the office |
| 5 | Look at the **menu bar**, top right, once the window has opened | A small monochrome icon is there, and clicking it opens a menu. If there is a number next to the icon it should match what the board says needs attention — see § 4d |
| 6 | **The notification prompt.** Expect macOS to ask *"“Haven Office” Would Like to Send You Notifications"* at some point during the first launch | Choose **Allow**. If you chose *Don't Allow* — or never saw the prompt — that is recoverable and § 4d says how. Tell us which happened either way; a prompt that never appears is itself a finding |
| 7 | Open the menu-bar menu and click one of the items listed at the top (if any are) | The main window comes forward on **that** task's page — not the board root, not a new window. If nothing needs attention the menu says *"Nothing needs attention"* instead, which is the correct empty state, not a failure |

Rows 5–7 have never run on a Mac either, and for a sharper reason than rows 1–4: **three
releases shipped packaged, verified and smoke-tested with no office in them**, so "the source
has it" has already proved not to mean "the build has it" twice. The menu-bar item is now
asserted in CI from both directions — the icon's presence inside the `.app` (at build time,
before publishing, and again in the smoke test) and the app's own report that it built the
item with a non-empty image. What CI still cannot see is macOS actually *drawing* it, which
is what row 5 is for.

Two notes on what is *not* a fault:

- **The remembered view is per connection**, stored as `lastViewPath` against that saved
  connection profile ([`src/connection/profiles.ts`](../src/connection/profiles.ts)). Local
  mode and a remote each remember their own, so they can legitimately differ.
- **Only the path is stored, never the origin.** A remembered view can never send the window
  to a different host; if a stored path fails the origin check it is discarded and you land on
  the office instead. Falling back to the office is the designed behaviour, not an error.

### 4d. The menu-bar item and notifications

New in `v2026.10.13`. The point of it: knowing something needs you without keeping a window
open and without reading email.

**The icon.** A small monochrome glyph at the right-hand end of the menu bar, present whenever
the app is running and connected. It is deliberately a **placeholder** — a plain filled circle,
generated rather than designed, because nobody has drawn a Haven mark yet. macOS recolours it
for light and dark menu bars on its own (that is what the `…Template` filename means), so it
is not meant to look like a logo. Replacing it later is two PNG files and no code.

**The number beside it** is the count of things needing attention, read from the same feed the
board's own attention list uses. It is only ever shown bare when the app has just polled
successfully. If the connection drops, the last number it saw is kept but shown with a
trailing **`?`** — `3?` means *three, as of the last time we could ask*. A count with no `?`
is live; a count with a `?` is a memory. The tray never shows a stale number as if it were
current, which also means the icon with nothing beside it is a real state: either nothing needs
attention, or we have never had a successful poll at all. The menu says which.

**The menu** (click the icon):

| Row | What it is |
|---|---|
| The items at the top | Up to eight things needing attention, newest first, each `IDENTIFIER — why now`. Clicking one brings the window forward on that page. More than eight and the list ends with `+N more` |
| *Nothing needs attention* | The empty state. This is the healthy case, not an error |
| A single greyed sentence instead of items | A degraded state, and it names the repair: *Signed out — open Haven Office to sign in*, *macOS is blocking Haven Office from reaching this server* (§ 4b, Local Network), or *Server unreachable* |
| **Open Office** / **Open Board** | The same two views as the **View** menu and `Cmd+1` / `Cmd+2` |
| The connection name | Which server these counts come from, or *Not connected* |
| **Notifications** | A checkbox. See below |
| **Keep running in the menu bar** | A checkbox, **on** by default: closing the last window leaves the app running in the menu bar rather than quitting. Turn it off if you want the red close button to mean quit |
| **Quit Haven Office** | Quits for real, menu-bar item included |

**Turning notifications off** — two different switches, and it is worth knowing which one you
want:

- **In the app:** menu-bar icon → untick **Notifications**. The menu-bar item and its count
  stay; only the banners stop. The setting is remembered in `tray-settings.json` next to
  `connections.json` (§ 4a lists where that is), per installation rather than per connection.
- **In macOS:** **System Settings → Notifications → Haven Office**. This is the one to use if
  you want macOS's own controls — scheduled summary, Do Not Disturb, lock-screen behaviour —
  rather than off entirely.

**What you will actually get.** Not one banner per change: the app is deliberately quiet.

- Everything already waiting when the app starts is **silent**. The first poll sets the
  baseline, so opening the app never produces a burst of notifications for things you already
  knew about.
- Each item notifies **once, ever**. Dismissing something on the board and having it reappear
  in the feed does not re-notify.
- More than **three** new items in one poll collapses into a single *"N new attention items"*
  banner instead of N separate ones.
- At most **eight** notifications in any rolling **10 minutes**. Anything over the cap is
  *held*, not dropped, and announced on a later poll.
- Clicking a banner opens that task; clicking a collapsed burst banner opens the board.

#### The macOS notification permission prompt

**On the first launch, macOS will ask once:** a system alert titled *"“Haven Office” Would Like
to Send You Notifications"*, with **Don't Allow** and **Allow**. It comes from macOS, not from
the app, and it can appear a few seconds *after* the main window — so it may land on top of the
office view rather than during startup. There is no way to ask for it earlier or to explain it
first; macOS shows it the first time the app tries to post a notification.

Choose **Allow** for row 6 of § 4c.

**If you choose Don't Allow** — or if the prompt is dismissed, or you miss it — the app keeps
working and says nothing about it. This is the honest limitation to know: **macOS never shows
that prompt again**, and the app cannot detect the refusal and tell you. The menu-bar icon and
its count carry on working normally, because those are not notifications; only the banners are
gone. Nothing logs it, nothing warns you, and the app will go on believing notifications are
enabled.

**To grant it afterwards:**

1. **System Settings → Notifications**.
2. Find **Haven Office** in the application list and click it.
3. Turn **Allow notifications** on.

If **Haven Office is not in that list at all**, macOS has not yet registered the app as a
notification client — which happens if the app has never attempted a notification. Leave it
running until something needs attention (or confirm **Notifications** is ticked in the
menu-bar menu, § 4d above), then look again. An unsigned build does not change this: Gatekeeper
(§ 3a) and notifications are unrelated permissions.

> **Possible, not confirmed: the grant may not survive an update.** Every unsigned build is
> ad-hoc signed afresh, with no stable signing identity (§ 3a, § 6). Whether macOS therefore
> treats each `v2026.10.x` as a new app for notification purposes and re-prompts — or silently
> loses the grant and needs steps 1–3 again — **we have not measured**, because it needs two
> installs on a real Mac. If you see the prompt a second time after updating, that is this, not
> a defect; please say so on the issue so this paragraph can become a fact. It should stop
> mattering once there is a Developer ID (§ 6), which is a credentials change rather than a
> code change.

---

## 5. Auto-updates

The app checks `whit3hat/haven-office` GitHub Releases for a newer version **on launch and
then every 4 hours**, and you can force a check from the menu (**Check for Updates…**).

> **On an unsigned build, updates do not install themselves. You download the new `.dmg`.**
> This is not a bug in our pipeline and it is not configurable — see below.

- The app tells you a new version exists and offers **Open Download Page**. Install it the
  same way you installed the first one (part 3): drag it into Applications, replace the old
  copy, right-click → **Open** once. Connections and sign-in are kept — they live in your
  home directory, not in the app bundle.
- The update feed is `latest-mac.yml`, published as an asset on each release. A release
  without that file is invisible to the updater; see part 7.
- Before any release exists, update checks log a 404 and report "up to date". That is handled
  deliberately, not a bug.

Updates are only checked in packaged builds — a `pnpm dev` run never updates itself.

> **`v2026.10.8` and earlier do not know this about themselves.** They download the update and
> prompt *"Restart now to apply the update?"*, and the install then fails inside Squirrel. If
> you are on one of those, choose **Later**, or dismiss the failure and download the `.dmg`
> instead. The check below ships from `v2026.10.9` on; the *running* app is what decides, so
> it takes one manual install to get onto a build that asks properly.

### Why an unsigned build cannot update itself

Electron's `autoUpdater` on macOS **is** Squirrel.Mac, and Electron 41's documentation says
so outright: *"Your application must be signed for automatic updates on macOS. This is a
requirement of Squirrel.Mac."*

The mechanism is specific, which is why there is no way around it. Squirrel reads the
**running** app's designated requirement (`SecCodeCopySelf` →
`SecCodeCopyDesignatedRequirement`) and validates the downloaded bundle against it
(`SecStaticCodeCheckValidityWithErrors`, in `Squirrel/SQRLCodeSignature.m`). An ad-hoc
signature has no identity to anchor to, so its designated requirement is the literal
code-directory hash of that one build — `designated => cdhash H"…"`. The next version has a
different hash, so the requirement can never be satisfied.

Left alone, that fails at the *worst* moment: after the download, after you click **Restart**.
So the app checks its own signature at launch and takes the honest path instead. The log line
says which it chose:

```
[updater] This build is ad-hoc signed (no code-signing identity); updates will be
  downloaded manually (Squirrel.Mac cannot replace it)
```

Anything other than a real signing identity — ad-hoc, unsigned, or a signature the check
could not read — takes the manual path, deliberately: a needless manual download is a far
better failure than an install that dies at quit.

**The first signed release fixes this on its own**, with no code change: the check then reads
`designated => identifier … and anchor apple generic …`, logs *"signed with a code-signing
identity"*, and in-place updates start working. Note that the *running* app is what decides,
so the last unsigned version you install will still ask you to download the first signed one
by hand.

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

Measured against the releases API on **2026-10-19**, five tags have a published release and
eight do not:

| Tag | Release? | Notes |
|---|---|---|
| `v2026.10.0` – `v2026.10.5` | **no** | Each a `Release Desktop` run that failed in macOS packaging or verification, tagged before the run proved itself. What each failure was, and the fix it produced, is in step 3 below |
| `v2026.10.6`, `v2026.10.7` | yes | **Ship without the office** — no bundled plugins at all (§ 4c) |
| `v2026.10.8`, `v2026.10.9` | **no** | Each superseded before it finished building and cancelled, rather than spending another ~40 minutes of macOS runner on a release that would be replaced within the hour. `v2026.10.8`'s content shipped in `v2026.10.9`; `v2026.10.9`'s in `v2026.10.10`. `v2026.10.9` was cancelled specifically because it would have published a third release with no office |
| `v2026.10.10`, `v2026.10.11` | yes | **Ship the office plugin but cannot install it** — the `migrations` `ENOENT` (§ 4c) |
| `v2026.10.12` | yes | First release whose office actually works |
| `v2026.10.13` | yes | Adds the menu-bar attention surface (§ 4d). First release with the tray asserted in the bundle — see the note in step 3 below, because it was **not** in the bundle until that assertion was written |

So **do not install from a tag** — a tag may have no assets at all, and the highest tag is
usually not the newest *release*. Install from the
[releases page](https://github.com/whit3hat/haven-office/releases), which only ever lists runs
that packaged, verified and published.

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

   **The bundled plugins, and the only defect here that reached a user.** Every failure above
   stopped a build. This one *published*: `v2026.10.6` and `v2026.10.7` both packaged,
   verified, smoke-tested and installed, and both shipped with **no
   `Contents/Resources/app-server/plugins` directory at all** — so no office (§ 4c).

   The cause is that there are **two** electron-builder configs in this repo and only one of
   them builds a published `.dmg`. `electron-builder.yml` at the root has had the
   `build/server-bundle/${os}-${arch}/plugins` → `app-server/plugins` mapping since the
   plugin work landed, and it is what `dist:win` and `dist:linux` use. But `dist:mac` runs
   `scripts/release-macos-local.mjs`, which assembles a staging directory and **generates its
   own config** (`buildStageConfig`) — and that config's `extraResources` listed only
   `app-server/server` and `app-server/node-bin`. Nothing copied the plugins into the stage
   either.

   Nothing failed, because nothing was looking: `readStagedPlugins` treats an absent
   directory as an empty list, and preinstalling is non-fatal by design, so the app opened
   normally and the office simply 404d. There was not even a log line.

   Three changes, so this cannot recur quietly:

   - `buildStageConfig` ships `app-server/plugins`, and `stageRuntimeFiles` copies it into the
     stage and asserts its layout there. `test/release-macos-local.test.mjs` asserts the
     mapping is in the generated config on **both** signing paths.
   - `verify-macos-release.mjs` now requires every pinned plugin inside the packed `.app` —
     present, at the pinned version, with every declared `paperclipPlugin` entrypoint on disk.
     A build that would ship without the office **fails before publishing**, under
     `bundledPlugin` in its JSON report.
   - provisioning logs `[plugins] No bundled plugins found in …; installing none.` instead of
     returning silently.

   The post-publish net is `smoke-packaged-macos.yml`, which polls `/api/plugins` on the
   launched app; that is what actually caught this, on
   [`Smoke Packaged macOS Release` #3](https://github.com/whit3hat/haven-office/actions/runs/39147656576).
   The verifier check exists because the smoke test only runs *after* a release is published.

   **Shipping the plugin is not the same as installing it — the third defect, and the one
   that proved the guard above was too narrow.** `v2026.10.10` passed that verification and
   still had no office. The smoke test failed on both arches with
   `ENOENT ... scandir .../paperclip-office/migrations`.

   `paperclip-office@0.1.2` declares `database.migrationsDir: "migrations"` and publishes that
   directory containing only `.gitkeep`. The server resolves and `readdir`s it inside the
   install transaction (`plugin-database.js` `listSqlMigrationFiles`), so the **directory has
   to exist** even though it holds no migrations; the `readdir` raises, the transaction rolls
   back, and the plugin never registers. Provisioning is non-fatal, so the app opens and only
   the office 404s.

   A directory whose only member is a dotfile is not a safe thing to carry through four copy
   hops and a zip, and nothing in the chain creates an empty directory for you.
   electron-builder lists `.gitkeep` in its own `excludedNames`, which is fair warning that
   tooling filters exactly this name. Measured, hop by hop, on a Linux runner: `npm pack` +
   `tar`, `stageBundledPlugins`'s `cpSync`, and electron-builder's `extraResources` filter
   (`{dot: true}`, tested directly against `FileMatcher`) each preserve it, so the loss is not
   in the hop anyone would guess — which is the reason the fix does not depend on knowing
   which hop it is.

   Two changes in `v2026.10.12`, both in `scripts/stage-plugins.mjs`:

   - `stageBundledPlugins` creates the declared migrations directory and writes a
     non-dotfile `KEEP-DIRECTORY.md` into it **only** when the plugin ships no `.sql` files,
     so a future version with real migrations is copied untouched. The server reads only
     `*.sql`, so the placeholder is inert.
   - `assertStagedPluginPackage` fails when a declared migrations directory is missing. This
     is the assertion `verify-macos-release` runs against the packed `.app`, and it is what
     was too narrow: it checked `package.json` and the entrypoints and nothing else. A
     declared migrations directory is as load-bearing as an entrypoint.

   `migrationsDir` is pinned in `bundledPluginVersions` beside the version rather than read
   from the plugin's manifest module, because nothing in this repo executes plugin code — in
   the build or in the main process.

   **The smoke test could not say any of this, and that was its own defect.** Its failure
   report was the last 80 lines of app output; the `[plugins]` line naming the cause is
   written at boot, and the 180-second plugin poll pushes ~85 request-log lines in after it.
   `scripts/smoke-output-diagnostics.mjs` now lifts `[plugins]` and `[local-server]` lines
   out of the whole buffer regardless of what followed, reports their total absence as a
   finding in its own right (provisioning logs unconditionally once it runs, so no line at
   all means it was never reached), and the workflow uploads the full output as an artifact
   on success and failure alike. Recovering one error string previously cost a code change
   and another dispatch.

   **The missing Local Network purpose string — the second defect that reached a user, and
   the one no CI job could have caught.** Up to and including `v2026.10.10`, neither
   electron-builder config set `mac.extendInfo`, so the packed `Info.plist` carried no
   `NSLocalNetworkUsageDescription`.

   Since macOS 15 (Sequoia) a GUI app is denied connections to **private** addresses until
   the user grants it Local Network access, and an app that declares no purpose string
   **never appears in System Settings → Privacy & Security → Local Network** — so there is
   no row to enable and the denial is permanent. Every havenCo remote is on a private
   address (`paperclip.lab.havenco.xyz` → `192.168.4.8`), so remote mode could not work on
   macOS 15+ at all.

   It presents as a network fault and is not one. The owner reported *"Host unreachable"*
   from the app while `curl` against the same URL on the same Mac returned **HTTP 200**
   (2026-10-18) — Terminal holds its own Local Network grant. There is no error code that
   says "permission": Chromium raises `ERR_NETWORK_ACCESS_DENIED`, the BSD layer raises
   `EPERM`/`EACCES` on `connect`, and a denial often just hangs until the probe's own
   timeout. That `curl`-versus-app comparison is the only cheap discriminator, which is why
   § 4b and § 8 both lead with it.

   Fixed in `v2026.10.11`:

   - `mac.extendInfo.NSLocalNetworkUsageDescription` in **both** configs — `buildStageConfig`
     (the one that ships) and the root `electron-builder.yml`.
     `test/macos-local-network.test.mjs` asserts the key is in the generated config on both
     signing paths **and** that the two configs' purpose strings are byte-identical, since
     two configs drifting apart is exactly what caused the plugins defect above.
   - `verify-macos-release.mjs` reads the packed `Info.plist` and **fails the build** if the
     key is absent or empty, reported under `localNetworkUsage`. A binary plist goes through
     `plutil`; anything unparseable raises rather than passing vacuously.
   - `preflight.ts` classifies a confirmed denial as the new `blocked_by_os` reason, badged
     **Local network blocked** instead of *Host unreachable*, and the ambiguous
     `EHOSTUNREACH`/timeout case now names **both** causes plus the `curl` test. Its previous
     wording named only "get on the lab network or VPN", which was the wrong repair for
     someone already on it.

   Declaring the key is **necessary but not reliably sufficient**: Electron apps are widely
   reported to miss the first-connection prompt because the responsible-process identity
   resolves to the Electron framework rather than the app bundle. So the runbook documents
   the manual toggle as the step, and the purpose string is what makes that toggle exist.
   Nothing here needs an Apple credential and no entitlement is involved.

   **The tray's template icon — the third instance of the same defect, caught before it
   shipped.** `v2026.10.13` adds the menu-bar item (§ 4d). Its icon was staged in
   `electron-builder.yml` and **not** in `buildStageConfig`, so every `.dmg` would have
   carried no `Contents/Resources/trayTemplate.png`.

   The reason it would have been invisible: `nativeImage.createFromPath()` returns an **empty
   image** for a file that does not exist rather than throwing, and `new Tray(emptyImage)`
   succeeds. The result is a menu-bar item that is present, functional and draws nothing —
   indistinguishable, from the outside, from a build where the tray was never wired at all.

   Found by writing the smoke assertion *before* dispatching the release, which is the only
   reason it is in this list as a near-miss rather than as another shipped release. Three for
   three now: **an asset added to `electron-builder.yml` alone is absent from every published
   build.** The entry has to go in `buildStageConfig` too, *and* the file has to be copied
   into the stage by `stageRuntimeFiles` (that config's paths are relative to the staging
   directory, not the repo).

   Guarded in four places, which is what the previous two defects earned:

   - `test/release-macos-local.test.mjs` asserts `buildStageConfig` stages both files at the
     resources root, on both signing paths. This is the test that would have caught it.
   - `stageRuntimeFiles` fails the build outright if `build/trayTemplate*.png` is missing.
   - `verify-macos-release.mjs` asserts both are inside the packed `.app`, are real PNGs, and
     that `@2x` is exactly twice `@1x` — which also catches the same file staged twice,
     shipping a blurry icon on every Retina Mac. **This runs before publishing**, so a build
     that lost them cannot become a release.
   - the packaged smoke test checks the bundle again before launching, then waits for the
     app's own `[tray] menu-bar item created icon=loaded` line. The last one is the only check
     that proves the *wiring* ran: a staged asset whose controller is never called is still no
     menu-bar item, and those two failures have different causes.

   What none of it proves is that macOS actually *draws* the icon. That is § 4c row 5, and it
   needs the owner's Mac.

   The run does three things in order:

   - `build-mac` prints **signed** or **unsigned** to the run summary, builds both arches
     via `pnpm release:mac:local`, and runs `scripts/verify-macos-release.mjs` on each — which
     checks every Mach-O payload is signed, that packaged native binaries match the bundled
     Node architecture, that the bundled server has its UI, dependencies and catalog
     manifests, that the `Info.plist` declares Local Network intent, that the office plugin
     and its declared `migrations` directory are present, and that both tray template icons
     are present and correctly sized. **If any of that fails, the release stops here.** That
     is the intended behaviour, and every item on that list is there because something it now
     checks once shipped without it.
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
   `userData` and `PAPERCLIP_HOME`, and asserts:

   - the tray's template icons are in the bundle — checked **before** the app is launched,
     since it needs nothing running;
   - the bundled server comes up and serves `/get-session`, `/api/skills/catalog` and
     `/api/teams/catalog`;
   - the app reports building its menu-bar item with a **non-empty** icon image;
   - every bundled plugin reaches `installed` at its pinned version — the closest automated
     proxy for the office view not 404ing;
   - and that the app never touched the production data directories.

   Record both results on the release issue. A green smoke test plus a green
   `verify-macos-release` is the bar for telling the team to install. Neither can see what
   macOS draws, which is what the § 4c install card is for.

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
| **"Page not found" on the office — remote connection** (`Cmd+1`; the Board and everything else work) | **Not the bundled plugin, and no app version fixes it.** On a remote, the office is served by the remote server, and the plugin bundled inside the app is installed into local mode only — it is never pushed to a remote. The connected server simply has no `paperclip-office` plugin; the lab server is in exactly this state as of 2026-10-18 (§ 4b). The fix is installing the plugin **on the server**. Use **View → Board** meanwhile, or local mode (§ 4a) to see the office. |
| **The office page 404s — local mode** | **Always the case on `v2026.10.6`–`v2026.10.11`**, for two different reasons (§ 4c): `v2026.10.6`/`v2026.10.7` ship no plugins at all, and `v2026.10.10`/`v2026.10.11` ship the plugin but fail to install it (`ENOENT … scandir …/migrations`). **Install `v2026.10.12` or newer.** On any build, check the app log for `[plugins]`: `No bundled plugins found in …` means the `.app` was packaged without them, `could not be provisioned: … ENOENT … migrations` is the install bug fixed in `v2026.10.12`, any other `could not be provisioned` is a new failure worth reporting with the line quoted, and no `[plugins]` line at all means a build older than that logging. The app deliberately opens anyway rather than refusing to launch; use **View → Board** meanwhile. See [`local-mode-plugin.md`](local-mode-plugin.md). |
| **No menu-bar icon at all** | **Nothing before `v2026.10.13`** — the menu-bar surface did not exist. On `v2026.10.13` or newer, it appears only once a connection is up, so check the window is actually connected first. If it is and there is still no icon, that is a real finding worth reporting: both the icon's presence in the `.app` and the app's own report that it loaded a non-empty image are asserted in CI, so a build that got published should have neither failure. Quote the `[tray]` line from the app log (§ 8 below) — `icon=empty` means the bundle lost the asset, no `[tray]` line at all means the wiring never ran. |
| **A menu-bar count that looks wrong or old** | If the number has a trailing **`?`** it *is* old, deliberately — the connection dropped and that is the last count we could actually fetch (§ 4d). Bare numbers are live. If a bare number disagrees with the board, report it with both values. |
| **No notification banners** | Three independent switches, in the order worth checking: **Notifications** ticked in the menu-bar menu; **System Settings → Notifications → Haven Office** allowed; and whether anything has *newly* appeared at all — items already waiting when the app started are silent by design, and each item notifies only once, ever (§ 4d). If Haven Office is missing from the System Settings list entirely, macOS has not registered it yet; § 4d covers that. |
| **Remote verification fails** | The app tells you which check failed — see [the table below](#remote-verification-messages) for what each message means. A private authenticated deployment redacting fields is fine and still verifies; a wrong host or an offline server is not. Confirm the URL works in a browser first. For the lab remote specifically, the server's half of that check is measured and known good — [see part 4b](#lab-remote-server-half) — so a failure there is between your Mac and the host. |
| **Verification failed — and clicking the saved connection fails the same way** | **Expected: there is no bypass, by design.** Connecting runs the identical preflight before any window opens (`bootRemote` in `src/main.ts` refuses on a failed result), so a saved connection, a typed URL and the **Verify Remote** button all fail together on the same fault. The repair is whatever the message names, not a different route into the app. The only asymmetry is *which cookie jar* each side probes, and that is a separate bug — see the row below. |
| **"Verified remote - sign-in required" (amber) for a remote you *are* signed in to** | On any build without `bf49cf71` — which is **every release up to and including `v2026.10.13`** — **Verify Remote** reads a different cookie jar than the window does for a *saved* connection, so it reports no session for one you have. It is cosmetic: **Connect Remote** is still enabled and connecting still works. On a fresh install, before you have signed in at all, this badge is simply the correct answer (part 4b, step 3). |
| **Signed in on the web but not in the app** | Sessions are not shared with your browser. Sign in inside the app window. |
| **No updates ever offered** | Check that the newest release has a `latest-mac.yml` asset and is not a draft or prerelease. |
| **An update was offered but never installed itself** | Expected on an unsigned build — part 5. Use **Open Download Page** and install the `.dmg`. |
| **"Code signature at URL … did not pass validation"** at restart | Squirrel refusing to replace an ad-hoc signed app, from a build older than this check. Download the `.dmg` instead; part 5. |

<a id="remote-verification-messages"></a>

### Remote verification messages

**Verify Remote** makes exactly two requests — `GET /api/health` and
`GET /api/auth/get-session` against the origin you typed — and reports the first thing that
goes wrong. It probes over the same Chromium network session the connection itself will
use, so a pass here means the real connection can reach the host too.

The two **amber** outcomes below are passes. Everything after them is a failure, and a
failure greys out **Connect Remote**: if that button is clickable, the check succeeded.

| What it says | What it means | What to do |
|---|---|---|
| **Verified remote - sign-in required** (amber) *plus* the green *"Verified authenticated Paperclip remote detected."* | **A pass.** The host is a healthy authenticated Paperclip server and you have no session on it yet. This is the normal result of the very first **Verify Remote** on a new install, and the measured result against our own lab remote ([part 4b](#lab-remote-server-half)). | Click **Connect Remote** and sign in inside the app window. If you believe you *are* already signed in on a saved connection, see the cookie-jar row in the table above. |
| **Verified remote - setup required** (amber) | A pass. The server is healthy but has no instance admin yet. | Click **Connect Remote** and finish Paperclip's own setup flow in-app. |
| **TLS validation failed** — *"self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)"*, *"certificate has expired"*, *"unable to verify the first certificate"* | The host answered, but macOS does not trust its certificate. | **Not expected against `paperclip.lab.havenco.xyz`** — that host serves a real Let's Encrypt certificate (measured 2026-10-18, see part 4b), so this message there means something is intercepting TLS. For a different lab host behind a private CA, install the CA in **Keychain Access → System → Certificates** and mark it trusted. The app uses the system trust store, so once Safari trusts the host, so does Haven Office. |
| **Host unreachable** — *"getaddrinfo ENOTFOUND … (ENOTFOUND)"*, *"net::ERR_NAME_NOT_RESOLVED"* | **DNS.** The name never resolved on this Mac. This is the most likely cause for our own remote: the name exists only in the lab's internal DNS (part 4b). | Point the Mac at the lab resolvers `192.168.4.2` / `192.168.4.3`, or get on the VPN that hands them out. Check with `scutil --dns \| grep nameserver`. |
| **Host unreachable** — *"connect ECONNREFUSED … (ECONNREFUSED)"* | The name resolved and the host answered, but nothing is listening on that port. | Check the port in the URL. `https://` with no port means 443. |
| **Could not verify remote** — *"Request to https://… /api/health **closed before a response arrived**"* (the wording on `v2026.10.13` and earlier) or, from the next release, *"The connection to … ended before any HTTP response arrived (ERR_CONNECTION_CLOSED)"* | **The connection ended without a reply.** Reported by the owner against the lab remote on 2026-10-21, at an hour when that server answered the same request with `HTTP 200` from inside the lab. It is not DNS (the name resolved) and not a refused port, and on `v2026.10.13` the message carries **no error code and no hint**, because the app synthesized it itself and attached neither — fixed after that tag, so a newer build names the candidates in the badge. **The owner added the fact that settles the ranking on 2026-10-21: the previous build connected to this same remote.** That makes it a regression, and it retires two of the three candidates this row used to list — DNS, the route and HTTP/3 are all unchanged between `v2026.10.12` and `v2026.10.13`, so none of them can explain a build that stopped working. Only two things changed: the app binary, and one line in the probe. **Two mechanisms for that one line are ruled out by measurement, so it is still an unproven cause** (2026-10-22). *(a)* Electron 41.10.7's own `ClientRequestConstructorOptions` says `credentials: "omit"` is the only mode that suppresses the `'login'` event on a 401 — so a credentialed probe meeting an auth challenge is cancelled with no response, which is exactly this sentence. It cannot be what happened: measured against the lab server, **neither 401 carries a `WWW-Authenticate` header** and `/api/health` answers `HTTP 200` even with a cookie attached, so Chromium raises no challenge. *(b)* A plain timeout cannot produce it either — the abort listener settles with `AbortError` before `close` can be reached (`src/connection/manual-redirect-fetch.ts`). So the sentence still means what it says: the transaction ended with no `response`, no `error` and no `abort`. | In this order, cheapest first. **1.** **Point the URL box at a plain public `https://` host** — `https://example.com` will do — and press **Verify Remote**. No download, and nothing is saved or sent: `launcher:verify-remote` only runs preflight (`profileId: null`, no profile written), and the app reads cookies for the host being probed, whose jar is empty for a host you have never connected to. **This step decides whether the next one is worth 677 MB.** The same *closed before a response* message for a public host means the transport cannot complete **any** request, so it is our code and step 2 is the fix. A different message — **not a Paperclip server** (`reason: "not_paperclip"`), or *"returned HTTP 404, not a Paperclip health payload"* — means the transport works for other hosts, and step 2 is **not** the fix. **2.** **Install `v2026.10.14` or newer.** `v2026.10.13` is the only published build that sent `credentials: "include"` on the `/api/health` probe; `v2026.10.14` sends it only on the session probe and returns `/api/health` to the `v2026.10.12` transport ([`f157b3e2`](https://github.com/whit3hat/haven-office/commit/f157b3e2)). Re-granting Local Network was step 1 of this row until the owner tried it on **2026-10-21** — toggled off and on, **Verify Remote** pressed twice — and reported the identical failure. That eliminates the only candidate that needed no code defect, so the build is what is left. **3.** Run the `curl` in [part 4b](#remote-prerequisites) — `http=200` there separates "server and network are fine" from everything else, which is worth knowing even though it cannot by itself explain a regression. |
| **Could not verify remote** — *"… sent HTTP 200 but the connection closed before the response body finished (ERR_RESPONSE_INCOMPLETE)"* | A response **started** and was cut off mid-body. Different from the row above: the host was reached and answered, so nothing about DNS, routing or permissions is in question. | Usually something between you and the host truncating the response — a proxy or TLS-inspecting middlebox. Retry once; if it repeats, report it with the full badge text, because a server that truncates its own `/api/health` is a server-side finding worth raising separately. |
| **Local network blocked** — *"macOS blocked Haven Office from reaching …"*, *"(ERR_NETWORK_ACCESS_DENIED)"*, *"(EPERM)"*, *"(EACCES)"* | **Not a network fault.** macOS 15+ denied *this app* access to the local network. The remote is fine and `curl` in Terminal will prove it. | **System Settings → Privacy & Security → Local Network → enable Haven Office.** If it is not listed, quit and reopen the app, attempt Verify Remote once, then look again. See part 4b. |
| **Host unreachable** — *"net::ERR_CONNECTION_TIMED_OUT"*, *"ETIMEDOUT"*, *"EHOSTUNREACH"*, *"No response within 8s"* | **Two unrelated causes, and the error cannot tell them apart:** either the address genuinely never answered, or macOS silently dropped the app's connection to it. | **Run the `curl` from part 4b first.** If it returns `200`, the network is fine and this is the Local Network permission — fix that, not your DNS. If it fails too, you are not on a network that can route to the private address `192.168.4.8`: get on the lab LAN or VPN. A coffee-shop network will always fail here. |
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
>
> **On any build before `v2026.10.11`, "Host unreachable" against a private address is
> most likely the macOS Local Network permission, and on those builds it cannot be
> granted** — they declare no `NSLocalNetworkUsageDescription`, so the app never appears
> in System Settings → Privacy & Security → Local Network. No amount of DNS or VPN
> troubleshooting fixes that. From `v2026.10.11` the app is listable, and a confirmed
> denial is reported as **Local network blocked** rather than sharing a badge with a
> network fault.

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
