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
- Shortcuts: `Ctrl+Shift+T` local shell, `Ctrl+Shift+W` close, `Ctrl+Tab` switch
- Host or SSH config alias and optional user per profile
- Optional label and private key selection
- Server profiles in `servers.json` and UI settings in `settings.json` in the app-specific Tauri config directory
- OpenSSH in a PTY with raw terminal input and output
- Terminal resize, colors, disconnect and status messages
- SSH sessions are cleaned up when the window closes

The private key is never copied or read; OpenSSH only receives the selected file path. Existing browser profiles are migrated to `servers.json` on first start. Pane splits, SSH config import, snippets and SFTP are not included yet.

## Requirements

- Linux with the OpenSSH client (`ssh`) installed
- Rust toolchain and Node.js with npm
- Tauri Linux dependencies: WebKitGTK 4.1, GTK 3, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `librsvg2-dev` and `libayatana-appindicator3-dev`

## Development

```bash
npm install
npm run tauri dev
```

## Checks and release

```bash
npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo check && cargo test
SHELL=/bin/sh cargo test -- --ignored   # additionally spawns a real local shell (run inside src-tauri)
cd .. && npm run tauri build
```

## Notes for contributors

- **Translations:** UI texts live in `src/i18n.ts`. English is the reference dictionary; other languages must define the same keys (TypeScript reports missing ones). Error messages from the Rust backend stay in English and are translated in the `backendMessages` table there.
- **UI colors** are defined in `src/styles.css`. After adding new color values, run `python3 scripts/gen-theme-palette.py`; it replaces them with variables and generates the light variant in `src/theme-palette.css`.

The host key check on the first connection happens in the terminal through OpenSSH. Only accept a host key after verifying the displayed fingerprint.
