# Crabshell

Local SSH manager and terminal for the desktop, built with Tauri 2, Rust and xterm.js. Crabshell uses the installed OpenSSH client; keys, ssh-agent, `known_hosts` and `~/.ssh/config` stay on your device.

## Features

Crabshell supports multiple locally saved server profiles and multiple terminal tabs, each with its own SSH session or local shell:

- Server list with adding, editing and removing profiles
- Terminal tabs with independent sessions, reconnect and tab closing
- Local shell via `+` or `Ctrl+Shift+T`: starts the user's login shell (`$SHELL`) in the home directory, with its own selectable design
- English and German UI; follows the system locale by default (`LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG`) and can be set in the settings
- Light, dark or automatic (system) color scheme, toggled next to the gear icon; adjustable interface text size (80–150 %)
- Designs per server profile: text and background color, cursor, selection, tab color and font size, managed via the gear icon in the top right
- Clipboard: `Ctrl+Shift+C` copy, `Ctrl+Shift+V` paste, optional copy on select and confirmation for multiline paste (also applies to the context menu and middle click)
- Own right-click menu (copy, paste, select all, snippets) that also works in programs that take over the mouse, such as micro, htop or mc. There, `Shift`+drag selects text; an optional setting lets plain dragging select as well (those programs then no longer receive left clicks)
- OSC 52 clipboard support: programs such as micro, vim/Neovim or tmux can copy into the local clipboard, also over SSH. Reading the clipboard (e.g. Ctrl+V in micro) asks first and can be allowed per session; see [micro over SSH](#micro-over-ssh)
- Snippets: saved commands with name and tags, managed in the sidebar (new, edit, duplicate, delete) and inserted via a search picker (`Ctrl+Shift+S`). A snippet is only pasted into the active, connected terminal, never sent on its own; `Ctrl+Enter` (or ▶) pastes and runs it. Trailing line breaks are removed, and multiline snippets always show a preview to confirm. Snippets are stored unencrypted in `snippets.json`, so do not put passwords in them.
- Shortcuts: `Ctrl+Shift+S` snippets, `Ctrl+Shift+T` local shell, `Ctrl+Shift+W` close, `Ctrl+Tab` switch
- Host or SSH config alias, port (default 22) and optional user per profile; port 22 is not passed to `ssh`, so a `Port` from `~/.ssh/config` still applies to aliases
- Optional label and private key selection
- Server profiles in `servers.json`, UI settings in `settings.json` and snippets in `snippets.json` in the app-specific Tauri config directory (`~/.config/dev.crabshell.app/`); files are written atomically, and an unreadable `snippets.json` is moved aside to `snippets.json.broken` instead of breaking the app
- OpenSSH in a PTY with raw terminal input and output
- Terminal resize, colors, disconnect and status messages
- SSH sessions are cleaned up when the window closes

The private key is never copied or read; OpenSSH only receives the selected file path. Existing browser profiles are migrated to `servers.json` on first start. Pane splits, SSH config import, snippet variables, snippet import/export and SFTP are not included yet.

## micro over SSH

To copy and paste between your computer and [micro](https://micro-editor.github.io) running on a server, tell micro to use the terminal clipboard (OSC 52). On the **server**, put this into `~/.config/micro/settings.json` (or run `Ctrl+E` → `set clipboard terminal` in micro):

```json
{
    "clipboard": "terminal"
}
```

- **Copy:** select text in micro and press `Ctrl+C`. micro sends it to Crabshell, which puts it into your local clipboard. The status bar shows "The program copied text to the clipboard."
- **Paste with `Ctrl+V` in micro:** micro asks Crabshell for the local clipboard. The first time per session, Crabshell asks whether the server may read it (*Deny* or *Allow for this session*). micro only waits 200 ms for the answer, which is too short for the dialog, so press `Ctrl+V` **once more** after allowing it. From then on, `Ctrl+V` works straight away until you disconnect.
- **Paste with `Ctrl+Shift+V`** (or right-click → Paste) always works and never gives the server access to your clipboard.

Without `"clipboard": "terminal"`, micro uses its own clipboard on the server (or `xclip`/`wl-copy` there), which cannot reach your computer. Both settings, writing and reading the clipboard, can be changed under Settings → Clipboard (reading: *Ask*, *Always* or *Never*). Only allow reading for servers you trust, because the server receives whatever you copied, including passwords.

`Shift`+drag selects text in the terminal even while micro uses the mouse, but it copies micro's line numbers too. Use micro's own selection with `Ctrl+C` instead, or turn the ruler off with `set ruler off`.

## Installation

Every release on GitHub contains ready-made packages for x86_64 (and arm64 where available). All of them need the OpenSSH client (`ssh`).

| Distribution | Package | Install |
| --- | --- | --- |
| Debian, Ubuntu, Linux Mint, Pop!_OS | `.deb` | `sudo apt install ./Crabshell_*_amd64.deb` |
| Fedora, openSUSE | `.rpm` | `sudo dnf install ./Crabshell-*.x86_64.rpm` or `sudo zypper install ./Crabshell-*.x86_64.rpm` |
| Arch Linux, CachyOS, EndeavourOS, Manjaro | `.pkg.tar.zst` | `sudo pacman -U crabshell-*-x86_64.pkg.tar.zst` |
| Any other distribution | `.AppImage` | `chmod +x Crabshell_*.AppImage && ./Crabshell_*.AppImage` |

The `.deb` and `.rpm` packages are built on Ubuntu 22.04 and need glibc 2.35 or newer. The Arch package is built against current Arch Linux and is meant for rolling Arch-based distributions.

## Building it yourself

### 1. Install the build dependencies

You need Rust (via [rustup](https://rustup.rs) or your distribution's package), Node.js 20 or newer with npm, the WebKitGTK 4.1 development files and the OpenSSH client.

**Arch Linux, CachyOS, EndeavourOS, Manjaro**

```bash
sudo pacman -S --needed base-devel git rust nodejs npm webkit2gtk-4.1 gtk3 librsvg openssh
```

**Debian 12+, Ubuntu 22.04+, Linux Mint, Pop!_OS**

```bash
sudo apt install build-essential curl wget file git libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev openssh-client nodejs npm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # if Rust is not installed yet
```

The `nodejs` package in older Ubuntu releases may be too old; in that case install Node.js LTS from [nodejs.org](https://nodejs.org) or via `nvm`.

**Fedora**

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file git libxdo-devel \
  libappindicator-gtk3-devel librsvg2-devel openssh-clients nodejs npm rust cargo
sudo dnf group install c-development
```

For other distributions, see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

### 2. Get the source

```bash
git clone https://github.com/alex-1987/Crabshell.git
cd Crabshell
npm ci
```

### 3a. Arch-based distributions: build a pacman package

```bash
cd packaging/arch
makepkg -si        # builds, runs the tests and installs the package
```

The package is built from your local checkout, so local changes are included. The version comes from `src-tauri/tauri.conf.json`.

### 3b. Other distributions: build .deb, .rpm and AppImage

```bash
npm run tauri build                              # all formats from tauri.conf.json
npm run tauri build -- --bundles deb             # only one format (deb, rpm or appimage)
npm run tauri build -- --no-bundle               # only the binary: src-tauri/target/release/crabshell
```

The packages end up in `src-tauri/target/release/bundle/` (`deb/`, `rpm/`, `appimage/`). Install them as shown in the table above.

If the AppImage step fails while stripping libraries (common on very new distributions such as Arch), retry with `NO_STRIP=true npm run tauri build -- --bundles appimage`, or use a native package instead.

## Development

```bash
npm install
npm run tauri dev
```

## Checks

```bash
npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo check && cargo test
SHELL=/bin/sh cargo test -- --ignored   # additionally spawns a real local shell (run inside src-tauri)
```

## Releases

Pushing a tag such as `v0.2.1` builds the `.deb`, `.rpm` and AppImage packages on Ubuntu 22.04 for x86_64 and arm64, and the pacman package in an Arch Linux container. Everything is attached to a draft release for that tag, which you publish yourself after checking it.

The version is taken from the tag (`v0.2.1` → `0.2.1`; a suffix such as `v0.3.0-beta.1` marks the release as a pre-release), so the version numbers in the repository do not have to be bumped first. To keep them in sync locally anyway, run `node scripts/set-version.mjs 0.2.1`, which updates `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`. Starting the workflow manually without a tag uses the version from `src-tauri/tauri.conf.json`.

```sh
git push origin main
git tag v0.2.1
git push origin v0.2.1
```

## Notes for contributors

- **Translations:** UI texts live in `src/i18n.ts`. English is the reference dictionary; other languages must define the same keys (TypeScript reports missing ones). Error messages from the Rust backend stay in English and are translated in the `backendMessages` table there.
- **UI colors** are defined in `src/styles.css`. After adding new color values, run `python3 scripts/gen-theme-palette.py`; it replaces them with variables and generates the light variant in `src/theme-palette.css`.

## Support

Crabshell is free. If it is useful to you, you can support it via [GitHub Sponsors](https://github.com/sponsors/alex-1987), also reachable from the ⓘ About dialog in the app. The app only opens that page in your browser; it never handles payment data.

The host key check on the first connection happens in the terminal through OpenSSH. Only accept a host key after verifying the displayed fingerprint.
