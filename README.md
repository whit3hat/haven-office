<p align="center">
  <strong>Haven Office</strong><br/>
  havenCo's desktop shell for a <a href="https://github.com/paperclipai/paperclip">Paperclip</a> server.
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="./UPSTREAM.md"><strong>Upstream provenance</strong></a> &middot;
  <a href="https://github.com/paperclipai/paperclip"><strong>Paperclip (upstream)</strong></a> &middot;
  <a href="https://docs.paperclip.ing/"><strong>Paperclip docs</strong></a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
</p>

<br/>

## What is this?

**Haven Office** is havenCo's [Electron](https://www.electronjs.org/) shell for
[Paperclip](https://github.com/paperclipai/paperclip). It is a downstream of
[aronprins/paperclip-desktop](https://github.com/aronprins/paperclip-desktop) — see
[UPSTREAM.md](./UPSTREAM.md) for the provenance and sync path. It bundles Paperclip (via the
official `@paperclipai/server` npm package) inside a native desktop app, and can also connect
to a Paperclip server you already run.

Haven Office is **not** Paperclip. It is a window onto a Paperclip server, branded for
havenCo and pointed at havenCo's releases.

- 🖱 **One click to launch** — double-click the app and the bundled server starts automatically. No terminal, no `pnpm install`, no Node.js setup.
- 🌐 **Remote connection mode** — connect the shell to verified upstream Paperclip remotes in authenticated mode, with saved connections and quick reconnects.
- 📦 **Paperclip inside** — ships an unmodified build of the upstream Paperclip server and UI. What you get in the app is exactly what you'd get by cloning and running the main repo.
- 🔄 **Auto-updates** — pulls new Haven Office releases automatically from [whit3hat/haven-office](https://github.com/whit3hat/haven-office) GitHub Releases.
- 🖥 **Native menus, windowing, and system tray** — the Paperclip UI, but as a real desktop app.

Under the hood, the app can either:

1. Run the embedded local server flow
2. Or verify a remote Paperclip origin via `/api/health` and `/api/auth/get-session` before loading it in a restricted remote-safe Electron window

When local mode is active, the server is cleanly shut down when you quit the app.

> For everything Paperclip itself can do — orchestrating AI agents, running autonomous companies, governance, budgets, org charts, etc. — see the **[upstream Paperclip repo](https://github.com/paperclipai/paperclip)**. This project does not modify or extend Paperclip's functionality; it only packages it.

<br/>

## Relationship to upstream

| This repo (`haven-office`)                     | Shell upstream ([`aronprins/paperclip-desktop`](https://github.com/aronprins/paperclip-desktop)) | Server upstream ([`paperclipai/paperclip`](https://github.com/paperclipai/paperclip)) |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Branding, Haven start path, havenCo releases   | The Electron shell, installers, and release automation we inherit                                | The actual Paperclip server, UI, and features                                         |
| Maintained by havenCo                          | Maintained by Aron Prins (community)                                                             | Maintained by the Paperclip team                                                      |
| Downstream copy, synced with `git pull upstream master` | Bundles `@paperclipai/server` as a dependency                                            | Source of that package                                                                |
| MIT (inherited) + Apache-2.0 (our additions)   | MIT licensed                                                                                     | MIT licensed                                                                          |

This is an **independent distribution**. It is not an official Paperclip release, and it is
not an `aronprins/paperclip-desktop` release. All credit for Paperclip itself goes to the
upstream project and its authors; all credit for the shell goes to `paperclip-desktop`.

<br/>

## Quickstart

### Install the desktop app

Download the latest installer for your platform from the [Releases page](https://github.com/whit3hat/haven-office/releases):

- **macOS** — `.dmg` (Apple Silicon and Intel)
- **Windows** — _coming soon_
- **Linux** — _coming soon_

Open the app. The bundled Paperclip server starts automatically and the dashboard opens in the
app window. That's it.

### Prefer to run Paperclip yourself?

If you'd rather run Paperclip from source with no desktop shell, follow the upstream
instructions:

```bash
npx paperclipai onboard --yes
```

Or:

```bash
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

See [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip) for full docs.

<br/>

## Development

Requirements: Node.js 20+, pnpm 9.15+.

```bash
pnpm install           # Install deps
pnpm dev               # Run Electron in dev mode against the bundled server
pnpm build             # Compile the Electron main/preload TypeScript
pnpm test:connections  # Run connection persistence, preflight, and origin-policy tests
pnpm prepare-server    # Stage the Paperclip server bundle into build/
pnpm build-ui          # Stage the Paperclip UI
pnpm pack              # Build an unpacked app directory (no installer)
pnpm dist              # Build full installers for the current platform
pnpm dist:mac          # macOS (.dmg + .zip, signed/notarized via local script)
```

Key files:

- `src/main.ts` — Electron main process: launcher IPC, local/remote boot orchestration, menu actions, and server lifecycle
- `src/connection/` — Connection persistence, remote validation/preflight, and exact-origin window policy helpers
- `src/launcher-html.ts` — Internal launcher UI for the chooser, remote connect flow, saved connections, and local boot states
- `src/preload.ts` — Preload script for the renderer
- `src/updater.ts` — Auto-update wiring (`electron-updater` against `whit3hat/haven-office` GitHub Releases)
- `electron-builder.yml` — Packaging config and app identity; bundles the `@paperclipai/server` npm package plus a platform-specific Node.js binary into `Resources/app-server/`
- `build/branding/make-icons.py` — Regenerates `build/icon.png` and `build/icon.ico` from the Haven marks
- `scripts/` — Build and release automation (server staging, macOS notarization, etc.)

<br/>

## License

Haven Office inherits upstream's MIT licence and keeps both upstream notices intact:

- `LICENSE` — MIT © 2025 Paperclip AI (full text).
- The shell upstream, [aronprins/paperclip-desktop](https://github.com/aronprins/paperclip-desktop), states **MIT © 2026 Aron Prins**. That notice stands for everything inherited from it.

havenCo's own additions to this repo are **Apache-2.0**, which is compatible with the above.

This project wraps a bundled copy of [Paperclip](https://github.com/paperclipai/paperclip),
which is also MIT licensed © Paperclip. See [LICENSE](./LICENSE) for the full text. The
upstream Paperclip license ships inside the packaged app alongside its source.

<br/>

## Disclaimer — use at your own risk

Haven Office is provided **"as is", without warranty of any kind**, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

By using this app you acknowledge that:

- It runs AI agents that can execute code, make API calls, and **spend money** on AI model providers on your behalf. You are solely responsible for any costs incurred.
- It is an **unofficial distribution**. It is not endorsed by, affiliated with, or supported by the upstream Paperclip team or by `aronprins/paperclip-desktop`.
- It wraps third-party software (Paperclip and its dependencies). The authors of this shell accept **no liability** for the behavior of the bundled Paperclip server, any agents you configure, or any outcomes produced by them.
- You are responsible for reviewing agent actions, setting budgets, and operating the software in accordance with the terms of any AI providers and services you connect to it.

If you do not accept these terms, do not install or use the app.

<br/>

## Credits

- **Paperclip** — the actual product: [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip)
- **Paperclip Desktop** — the Electron shell this repo is built on, maintained by [Aron Prins](https://github.com/aronprins): [github.com/aronprins/paperclip-desktop](https://github.com/aronprins/paperclip-desktop)
- **Haven Office** — havenCo's downstream branding and start path
