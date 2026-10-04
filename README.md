# AI Browser

An AI-first, local-first task browser built on Chromium (CEF) with a Rust host and a React/TypeScript chrome UI.

> Status: **Phase 3, first increment — approval-gated reader agent**. Model studio and page Q&A work; task mode can inspect pages and follow reviewed links. Full action automation, bundled inference and installers are not shipped yet.

Porting guidance is maintained in [Mac OS parity](mac-os-parity.md).
Update that document whenever a development phase introduces platform-specific
behavior, dependencies, or packaging requirements.

## Layout

| Path | Purpose |
|------|---------|
| `crates/aib-app` | Main executable (`aibrowser.exe`): CEF bootstrap, window/tabs, localhost UI + IPC server |
| `crates/aib-ipc` | Shared wire protocol between the chrome UI and the host |
| `crates/aib-models` | Provider configuration, streaming chat, and secure API-key storage |
| `crates/aib-local` | Hardware profile, loopback runtime discovery, reviewed model catalog and Ollama downloads |
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
- `--graphics=auto|software|gpu` — `auto` uses software rendering on Windows for graphics-driver compatibility, GPU on other platforms. Explicit `gpu` opts into hardware acceleration. Browser rendering does not determine local-model acceleration.
- `--profile-dir=<absolute path>` — use a separate CEF profile, useful for disposable tests. Without this flag the usual user profile is used.

Close the browser before rebuilding; running CEF processes can lock build output.

## GPU context errors (Windows)

Errors such as `GPU process exited unexpectedly` or `Failed to create shared
context for virtualization` indicate a Chromium GPU/driver context failure,
not a model endpoint error. The Windows default now disables hardware browser
compositing and logs a compatibility warning rather than suppressing diagnostics.

```powershell
.\target\debug\aibrowser.exe --graphics=software --url=https://example.com
```

To compare hardware rendering, close the browser and launch with `--graphics=gpu`.
If hardware mode still fails, update the Intel/display-adapter drivers, test
without the USB display adapter or remote desktop, and return to software mode.
Software rendering can use more CPU and does not promise accelerated WebGL/video.

## Local model studio

1. Open **Ask AI → Local models**.
2. Install and start [Ollama](https://ollama.com/download) yourself, or start
   LM Studio's local OpenAI-compatible server. The browser does not install or
   launch external runtimes automatically.
3. Choose **Refresh**. Default ports: Ollama `11434`, LM Studio `1234`.
   Expand **Local server addresses** if your runtime uses a different port.
   Refresh validates and saves those nonsecret addresses in `local-runtimes.json`.
4. For Ollama, choose **Review download** on a catalog model. Check the size and
   license, then explicitly confirm **Download model**.
5. Watch per-layer progress. Ollama handles registry layer verification and
   resumable storage; the browser checks that the model appears in the local
   model list before reporting success.
6. Choose **Use model** from the connected runtime card, return to Ask this page,
   and ask a question. No cloud API key is sent to the local server.
7. **Return to saved cloud model** restores the last cloud profile preserved
   when switching to local. Keys remain in the system credential store.

Hardware recommendations use available RAM, not GPU benchmarks. Model sizes are
approximate; leave room for context, browser tabs and other applications.
Ollama cloud-backed entries are excluded from discovery. The browser does not
enforce network isolation on an external runtime.

**Stop watching** closes the browser's download stream, not the Ollama process.
Ollama may continue a download; Refresh checks current state, and retrying the
same model resumes existing layers. Closing the model panel also stops watching.
Only reviewed catalog models can be downloaded from this panel; other models
already installed in a runtime can still be selected.

Remaining roadmap work: bundled llama.cpp, browser-owned verified GGUF cache,
Foundry Local discovery, local embeddings and constrained tool calls. Phase 1
multi-role routing and usage metering also remain; page Q&A is implemented.

## Task mode: the first browser agent

1. Open the browser and wait for the active tab to finish loading.
2. Open **Ask AI → Task mode**. Use a model configured in settings or Local models.
3. Choose **Search the web** (the default) for a new research goal. It does not
   read/share the starting tab, so Example Domain is not used as travel evidence.
   Choose **Research the current page** only when that page is relevant.
   Enter a focused goal with the details needed to research it.
4. Review the privacy note and explicitly allow sharing task pages with the model.
5. Choose **Start task**. Watch the activity timeline.
6. Review each proposed search query or link's exact URL and reason. Web searches
   use Google and require approval before sending the query to that site.
   **Approve navigation**
   replaces the current page; **Decline & stop** performs no navigation.
7. The outcome distinguishes **More details needed**, **No verified result**,
   protocol failure and **Research brief ready**. When the assistant asks a
   question, type in **Your reply** directly beneath it and choose
   **Send reply & continue**. Each reply resumes the same task with the original
   goal, prior questions/replies, visited evidence and selected model. No need to
   edit the original goal or restart; no dates or travelers are guessed.
   Source buttons reopen cited pages after a research brief is ready.

For example, "Find flights and hotels from Austin to Cancun" lacks dates,
travelers and rooms. The model is instructed to ask for those details before
searching. A complete goal might be: "Research Austin to Cancun, Nov 20-27 2026,
two adults, one hotel room, flights under $500/person, hotels under $250/night.
Separate confirmed availability from general planning information."
These are example parameters, not recommendations or actual offers.

**This is not a completed flight/hotel booking agent.** It can search/read
accessible pages but cannot fill flight dates, room selectors or booking forms.
Travel sites may need manual interaction, login or CAPTCHA. Search snippets are
not verified live prices. A research brief does not mean availability was checked,
and no booking is made. Use the activity timeline to see exactly what was read.

**Stop / take over** cancels model/reader waits and invalidates approvals.
Manual browser navigation, reload, tab changes (including native shortcuts) and
closing the assistant also stop the task. An already-issued, approved page load
may still finish; stopping does not undo navigation.

The native runtime pins a run to one active tab and one model configuration.
It uses CEF's **in-process CDP**, so task mode does not require a remote debugging
port. A reader runs in an isolated JavaScript world and returns bounded rendered
text (12,000 characters), headings and up to 80 named HTTP(S) links. Hidden text,
input/textarea/select values and contenteditable text are excluded by the reader;
this is not comprehensive secret redaction of visible page content.

The model must produce a strict JSON decision: search, select an observed link
ID, request details, explain insufficient evidence, or finish with an answer
and explicit visited-source IDs. Link IDs and source IDs are separate.
For invalid actions/citations, the runtime logs the issue, shows a correction
step and requests **one** corrected decision using the same evidence and detailed
validation feedback. **Model protocol diagnostic** shows the validation issue
without exposing raw model output. Complete JSON code fences and numeric grouped
citations such as `[1, 2]` are accepted; unsupported actions and unvisited IDs
are still rejected. The screenshot's failure is a rejected model decision, not
proof of verified prices on a Google-generated overview.
Empty/unvisited source lists never become accepted research results.
Repeated invalid output fails with an actionable message, not a fabricated answer. The
runtime permits at most **six pages**, **two minutes per model decision**, and
**ten minutes per task**, including approval and clarification waits.
At most **five clarification questions** are allowed per task. Stop/manual
takeover cancels a waiting question; duplicate, stale or late replies are rejected.
Questions and user replies are sent to the pinned model and kept only in memory.

During a run, native navigation guards block unapproved main-frame navigations
(including redirects and non-GET form navigation), popups and downloads. Every
model-proposed navigation needs a fresh, single-use approval; approvals cannot
be reused after stopping.

**Important limits:** This is a reader agent, not a full operator. No clicking,
typing, uploads, purchases, unapproved autonomous search, screenshot/vision fallback,
accessibility-tree merge, iframe/shadow-DOM traversal, parallel research or
persistent audit storage is implemented yet. Ordinary site scripts, their
network requests and existing signed-in cookies remain active. Even a GET link
can have side effects on poorly designed sites: review each URL carefully.
The development browser's production sandbox work also remains unfinished.
Tasks are kept in memory; starting a new run replaces the last run.
Small local models may fail the JSON protocol; use a stronger instruction-following
model rather than expecting one protocol retry to make every model reliable.

### Window controls and local development notes

The native titlebar supports minimize, maximize/restore and resizing for the main
window and application popup windows. The Windows fixture test checks native
window styles and exercises minimize/maximize/restore, not just HTML buttons.

The developer's `mac-os-parity.md` is a locally maintained, Git-ignored porting
guide by request; it is not included in a fresh clone. Update the local guide
whenever platform behavior, dependencies, features or packaging change.
Build output, runtime settings/profiles, environment files and private key files
are ignored. Keys remain in the OS credential store; do not copy personal model
endpoints, credentials or browser profiles into the repository.

## UI dev loop

Run the Vite dev server and point the host at it for hot reload:

```powershell
cd ui; npm run dev
$env:AIB_UI_DEV_URL = "http://localhost:5173"; cargo run
```

## Tests

```powershell
cargo test --workspace
```

Native agent integration tests (Windows, Node.js 22+, browser already built):

```powershell
node .\scripts\test-agent.cjs
```

This launches only local website/model fixtures and its own browser instance
with a disposable profile and nonsecret model settings file. It verifies
observations, approval/decline, stop during model latency, manual takeover,
blocked redirects/downloads, invalid decisions, the six-page bound and existing
page Q&A. Regression fixtures reproduce Austin-Cancun requests from an unrelated
Example Domain page, missing travel details, approved search, explicit source IDs,
bounded correction and no-evidence outcomes. They are simulated protocol tests,
not a real airfare/hotel search or a live-model accuracy benchmark.
The harness also exercises the native React task form, consent, approval and
result flow, keyboard focus, the visible sticky stop control and 320px light/dark
layouts. It does not call your cloud model or modify your normal settings.
The harness opens a temporary debug port; close it after testing.
`AIB_MODEL_SETTINGS_FILE=<absolute file path>` overrides the model settings file
for isolated development tests; unset it for normal use. API keys are still in
the system credential store, never in that file.
`AIB_AGENT_TEST_SEARCH_URL` is a numeric-loopback-only test override used by the
harness to avoid real search traffic. Leave it unset for normal Google searches.

## Notes

- The chrome UI talks to the host over a WebSocket on `127.0.0.1` protected by a per-run token and Origin check.
- Browser profile lives in `%LOCALAPPDATA%\AIBrowser\Profile`.
- Model settings live in `%APPDATA%\AIBrowser\models.json`; API keys are kept in Windows Credential Manager (separate entries per provider).
- `models-cloud.json` in the same directory preserves nonsecret cloud settings when selecting a local model.
- Use **✦ Ask AI** to open the AI workspace. Page Q&A shares text only with **Use current page** checked; Task mode has separate explicit page-sharing consent and navigation approvals.
- The model gateway supports OpenAI Chat Completions and Responses streaming endpoints (including OpenAI, Microsoft Foundry v1, Ollama, LM Studio, OpenRouter, and other `/v1` servers), legacy Azure OpenAI, Anthropic Claude, and Gemini. Local HTTP is permitted only for loopback addresses.
- For Microsoft Foundry's OpenAI v1 Responses API, choose **OpenAI-compatible**, set the URL to the full endpoint (for example `https://<resource>.services.ai.azure.com/openai/v1/responses`), enter the deployed model name, and provide its key. The key is sent as an `Authorization: Bearer` header and remains in Windows Credential Manager. Do not add an `api-version` query to the v1 URL.
- For Claude, choose **Anthropic**, enter the Anthropic API key and a supported Claude model ID. The gateway uses Anthropic's Messages API and its required `x-api-key` and version headers.
- For a local Ollama server, choose **OpenAI-compatible**, use `http://localhost:11434/v1`, and set the model name from `ollama list`. For LM Studio, use its local server URL (commonly `http://localhost:1234/v1`) and the model identifier shown in LM Studio. Local loopback endpoints do not need an API key.
- The debug executable is not an installer. Windows installation packaging is planned for the shipping phase; CEF runtime files and first-run setup still need to be bundled and verified before producing an installable release.
- Shortcuts: `Ctrl+T` new tab, `Ctrl+W` close tab, `Ctrl+Tab`/`Ctrl+Shift+Tab` switch tabs, `Ctrl+L`/`Alt+D` focus omnibox, `F5`/`Ctrl+R` reload, `Alt+←/→` back/forward, `F12`/`Ctrl+Shift+I` DevTools.
