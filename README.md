# AI Browser

An AI-first, local-first task browser built on Chromium (CEF) with a Rust host and a React/TypeScript chrome UI.

> Status: **Phase 0 — browser shell** (tabs, omnibox, navigation, popups, downloads, DevTools).

## Layout

| Path | Purpose |
|------|---------|
| `crates/aib-app` | Main executable (`aibrowser.exe`): CEF bootstrap, window/tabs, localhost UI + IPC server |
| `crates/aib-ipc` | Shared wire protocol between the chrome UI and the host |
| `ui/` | React + TypeScript chrome UI (tab strip, omnibox, downloads), built with Vite |

## Prerequisites (Windows)

- Rust (stable, edition 2024)
- Visual Studio 2022 Build Tools with the C++ workload (MSVC, CMake, Ninja)
- Node.js 20+
- CEF binaries: set `CEF_PATH` (e.g. `%USERPROFILE%\.local\share\cef`). The build downloads them if missing.

CMake/Ninja from VS Build Tools must be on `PATH`:

```powershell
$vs = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake"
$env:PATH = "$vs\CMake\bin;$vs\Ninja;$env:PATH"
$env:CEF_PATH = "$env:USERPROFILE\.local\share\cef"
```

## Build & run

```powershell
cd ui; npm install; npm run build; cd ..   # UI is embedded into the binary
cargo build
.\target\debug\aibrowser.exe --url=https://example.com
```

Flags:

- `--url=<url>` — initial page
- `--remote-debugging-port=<port>` — expose CDP (useful for automated testing)

## UI dev loop

Run the Vite dev server and point the host at it for hot reload:

```powershell
cd ui; npm run dev
$env:AIB_UI_DEV_URL = "http://localhost:5173"; cargo run
```

## Tests

```powershell
cargo test -p aib-ipc
```

## Notes

- The chrome UI talks to the host over a WebSocket on `127.0.0.1` protected by a per-run token and Origin check.
- Browser profile lives in `%LOCALAPPDATA%\AIBrowser\Profile`.
- Shortcuts: `Ctrl+T` new tab, `Ctrl+W` close tab, `Ctrl+Tab`/`Ctrl+Shift+Tab` switch tabs, `Ctrl+L`/`Alt+D` focus omnibox, `F5`/`Ctrl+R` reload, `Alt+←/→` back/forward, `F12`/`Ctrl+Shift+I` DevTools.
