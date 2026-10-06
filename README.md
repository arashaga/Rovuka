# Rovuka

An AI-first, local-first task browser built on Chromium (CEF) with a Rust host and a React/TypeScript chrome UI.

> Status: **Phase 6 multi-tab intelligence and research workspace**. Compare 2-6 explicitly selected tabs using source-checked quotations and Unknown cells, or research in one new tab without replacing your originals. Model studio, page Q&A, privacy/audit, Reliability and public search preparation remain available. Choose one-action approval or **Approve all for this task**; supported operations still need fresh native checks and audited permits. General website automation, bookings/payments, production sandboxing, bundled inference and installers are not shipped yet.

Porting guidance is maintained in the local [Mac OS parity](mac-os-parity.md)
guide, which is intentionally Git-ignored. Copy it separately when moving to
a Mac; it is not included in a fresh clone.
Update that document whenever a development phase introduces platform-specific
behavior, dependencies, or packaging requirements.

## Layout

| Path | Purpose |
|------|---------|
| `crates/aib-app` | Main executable (`rovuka.exe`): CEF bootstrap, window/tabs, localhost UI + IPC server |
| `crates/aib-ipc` | Shared wire protocol between the chrome UI and the host |
| `crates/aib-models` | Provider configuration, streaming chat, and secure API-key storage |
| `crates/aib-local` | Hardware profile, loopback runtime discovery, reviewed model catalog and Ollama downloads |
| `ui/` | React + TypeScript chrome UI, illustrated start page and assistant workspace, built with Vite |

## Prerequisites (Windows)

- Rust (stable, edition 2024)
- Visual Studio 2022 Build Tools with the C++ workload (MSVC, CMake, Ninja)
- Node.js 22.12+ (the native test harness uses the built-in WebSocket client)
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
.\target\debug\rovuka.exe
```

Flags:

- `--url=<url>` — open this initial page instead of the Rovuka start page
- `--remote-debugging-port=<port>` — expose CDP (useful for automated testing)
- `--graphics=auto|software|gpu` — `auto` uses software rendering on Windows for graphics-driver compatibility, GPU on other platforms. Explicit `gpu` opts into hardware acceleration. Browser rendering does not determine local-model acceleration.
- `--profile-dir=<absolute path>` — use a separate CEF profile, useful for disposable tests. Without this flag the usual user profile is used.

Close the browser before rebuilding; running CEF processes lock `rovuka.exe` and
the build fails. Always run the freshly built `.\target\debug\rovuka.exe`. If you
are unsure which build is running, check the first line of the diagnostic log or
the **Build** line on a task failure screen (version, executable path and build time).
Native fixtures can select an alternate executable with the absolute
`AIB_TEST_BROWSER_EXE` environment variable; they still use disposable profiles.

The app is now **Rovuka**: native window title, assistant branding, HTML title and
executable name are updated. Launch `rovuka.exe`, not an old `aibrowser.exe`
left in a previous build folder. The internal `AIBrowser` configuration/profile
directories, credential-store service and `AIB_*` environment variables remain
unchanged so existing keys, local-model preferences, cookies and settings work
without migration. This rename does not create an installer.

## Rovuka start page

Launch without `--url` to see the welcome/new-tab workspace. It includes a
top **What's new** strip, an illustrated overview, a task composer, shopping,
travel and research examples, feature shortcuts and an explanation of current
safety boundaries. Illustrations are local SVGs; there are no remote artwork,
news-feed requests or model calls just to display the page. The update strip
describes this build's shipped features, not a remotely fetched feed.

- Use **Prepare a task** or an example card to open an editable draft in
  Task mode. Opening a draft does not start research, select page-sharing
  consent, approve navigation or replace the current page. Choose/configure a
  model, review the draft, explicitly allow sharing and press **Start task**.
- **Connect your model**, **Explore local models**, **Open Ask AI** and
  **Review safety** open their existing assistant workspaces. **Just browse**
  focuses the address bar; ordinary browsing does not need a model.
- The **Home** toolbar button opens the start page in a separate tab. The
  **+** button, native new-tab command and closing the last tab also show it.
  Back/Forward can return between that blank-tab state and a visited website.
  Explicit `--url` launches and ordinary result links still open their requested
  destination, not the start page.
- Findings remain session-only and are preserved when opening Home. Return
  through **Task mode → View findings**. Preparing a new draft does not erase
  the previous server-held result; a workspace shortcut stops an active run
  before switching away, just like other manual workspace changes.

The start page is a separate trusted native BrowserView above a blank content
tab, not a token-bearing website in tab history. Its authenticated UI URL stays
out of the omnibox, tab snapshots and model-facing observations. Page Q&A
explicitly refuses to share it: open a real webpage first. Themes, responsive
320px layouts, focusable controls and reduced-motion artwork use the existing
Clawpilot design. What's new introduces selected-tab comparisons, research in a
new tab and task-wide or step-by-step approval. Runtimes,
booking/non-search submission automation and installers are still not bundled.

## Ordinary browsing and navigation errors

Type or paste an address into the toolbar and press Enter. Ordinary Chromium
browsing does not require a configured model. The address bar keeps the requested
address while a page is loading, separately from its actual committed document
URL; agent guards still use the committed URL.

Bare hostnames try HTTPS first. If a manually entered, inferred HTTPS **root**
fails with an eligible connection error, Rovuka retries its HTTP root once and
follows the site's real redirects. Typing `hotel.com` therefore reaches secure
Hotels.com through its actual redirect; there is no hardcoded domain alias.
Explicit HTTPS, addresses with paths/query/fragment data, credentials, ports,
IP addresses, certificate/SSL errors, DNS/offline errors and agent navigation
do not get this fallback. If an external address remains HTTP, the toolbar shows
**Not secure**; do not enter private information.

A main-page connection, DNS, timeout or certificate failure displays a local
**Couldn't open this page** screen rather than leaving the welcome page visible
with an empty address. It shows the failed address and Chromium error:

- **Try again** and toolbar **Reload** retry that exact failed destination,
  not the previously loaded document.
- **Edit address** focuses the address bar without losing the failed address.
- **Go back**, when history permits, returns to the previous website or blank
  welcome tab. Cached Back/Forward restoration clears the previous error state.

The error uses the separate trusted start BrowserView; its internal authenticated
URL never enters website history, tab metadata or model observations. Failed or
still-loading pages explicitly refuse page Q&A; failed pages cannot be read or
prepared by an AI task. Cancelling or superseding navigation is not shown as a
network error, and a failed iframe does not hide its successful main page.

Website-provided error/challenge documents (including HTML 404/429 responses)
remain website content. Rovuka does not bypass certificate checks or website
verification. An explicit `https://hotel.com/` can still fail rather than
downgrade. The Hotels.com service uses `https://www.hotels.com/`, and may require
manual verification.

Native navigation-start, load-failure and main-response status diagnostics are
written to the existing local log. These new events omit URL query/fragment data;
other task diagnostics retain their existing local-only privacy limitations.

## GPU context errors (Windows)

Errors such as `GPU process exited unexpectedly` or `Failed to create shared
context for virtualization` indicate a Chromium GPU/driver context failure,
not a model endpoint error. The Windows default now disables hardware browser
compositing and logs a compatibility warning rather than suppressing diagnostics.

```powershell
.\target\debug\rovuka.exe --graphics=software --url=https://example.com
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

## Page questions versus web research

**Ask this page** answers from the current page (when sharing is checked) or
from the model alone. It does not search websites. Use **Research the web**
beside the question composer for flights, hotels, shopping or sourced comparisons.
This transfers your text into Task mode's search-first comparison form.
Review the goal, grant page-sharing consent and choose **Start task**; transferring
the request does not start research or approve navigation.

If the current page has no readable text, the inline error offers **Research
this request** and **Edit and retry**, preserving your original question.
To ask the model without page context, uncheck **Use current page** and retry.
This does not provide verified live availability or prices.

## Task mode: the first browser agent

1. Open the browser and wait for the active tab to finish loading.
2. Open **Ask AI → Task mode**. Use a model configured in settings or Local models.
3. Choose **Search the web in this tab** (the default) for a new research goal. It does not
   read/share the starting tab, so Example Domain is not used as travel evidence.
   Choose **Research the current page** only when that page is relevant.
   Enter a focused goal with the details needed to research it.
4. Review the privacy note and explicitly allow sharing task pages with the model.
5. Choose **Start task**. Watch the activity timeline.
6. Review each proposed search query or link's exact URL and reason. Web searches
   use Google and require approval before sending the query to that site unless
   you grant automatic research for this task.
   **Approve navigation**
   replaces the current page; **Decline & stop** performs no navigation.
   **Approve all for this task** approves this proposal and subsequent
   search/observed-link navigation in this run. It does not authorize transactions.
7. The outcome distinguishes **More details needed**, **No verified result**,
   protocol failure and **Your results are ready**. When the assistant asks a
   question, type in **Your reply** directly beneath it and choose
   **Send reply & continue**. Each reply resumes the same task with the original
   goal, prior questions/replies, visited evidence and selected model. No need to
   edit the original goal or restart; no dates or travelers are guessed.
   Source buttons open cited pages in new tabs after results are ready.
8. **Searches performed** shows each approved query and whether its page was
   actually read. An accepted final answer opens the full-width **Research
   workspace** automatically; it does not leave the final result on Google.

### Phase 6: selected tabs and preserved research

**Compare selected tabs (read-only)** compares pages you have already opened,
without activating, navigating, filling or clicking them. Nothing is selected
automatically. The native scope freezes the tab IDs, exact URLs and document
versions for 2-6 tabs; at least two distinct pages are required. Duplicate URLs
and fragment copies count as one source. Failed/loading pages, the trusted start
page and recognizable account, transaction or credential-bearing URLs cannot
be selected. Signed-in cookies still apply; this is not a private cookie profile
or exhaustive sensitive-page detector.

After explicit sharing consent, choose **Approve this page read** for one page
or **Approve all for this task** for the remaining selected scope. Refreshing
the list or changing selection resets consent. Approve-all cannot expand the
scope, navigate a selected tab or authorize transactions. **Ask before each
page read** revokes future automatic reads; **Stop / take over** cancels local pending
work. Neither can undo text already shared with your configured provider or
guarantee cancellation of remote inference/billing.

Snapshots use only fixed native read methods in an isolated world. They capture
bounded readable main-document text, not private form values or all hidden,
iframe, image or PDF content. Quarantined no-tools evidence readers run at
**concurrency two**; comparison synthesis receives only source-checked quotes,
not raw page prose, unrelated tabs or their content. Every cell must be an exact
normalized quote found in both its protected source snapshot and checked
evidence, or **Unknown**. Missing details are not estimated, calculated, treated
as free or silently filled from another source. A malformed comparison gets at
most one correction. If a reader's nonempty output is rejected, it gets one
bounded recovery: select IDs from at most 128 native-captured safe excerpts,
instead of copying their text again. Native code resolves those IDs and reruns
the same exact source checks; invalid IDs, sensitive/instruction-like excerpts
and failed recovery still prevent partial publication. A valid empty reader
result is an explicit evidence gap, not a retry. An all-Unknown
table is **No verified result**, with the unknowns still available to inspect.

The full-width research workspace keeps your question, comparison table,
captured-source links and activity trail. **Copy comparison with sources**
includes citations and caveats; clipboard denial offers visible manual copying.
Sources open in new tabs, and **View findings** restores the existing result
without another model call. Beginning public-search preparation also retains a
completed comparison.

**Important limits:** native checks establish quote membership and source
identity, not semantic correctness. Criterion selection and quote placement
remain model judgments; search snippets remain leads, not provider-confirmed
facts. Dates, prices, fees and availability may change. Snapshots must stay on
the same document through publication; this does not freeze live in-page data
or independently verify offers. The displayed timestamp is the snapshot-run
start. Each page needs a model reader request and at most one additional reader
recovery request. Recovery is visible in Activity and request/repair counts;
endpoint fallback may require extra HTTP attempts. Model time sums settled request durations,
including provider errors, not parallel wall-clock completion time. Cancelled
unfinished requests may have no recorded duration. Results are session-only,
not browser memory.

To research across sites without replacing existing pages, select **Search the
web in a new research tab**. This creates one ordinary task tab and reuses the
existing approved search/link loop, six-page and ten-minute limits and
transaction restrictions. Originals are not read or replaced. Stop/completion
release the task lease and leave the research tab for manual review. This is
bounded multi-site research, not unrestricted parallel browsing; selected-page
comparisons create no worker tabs. The existing same-tab search remains default.

#### Try Phase 6

1. Launch `.\target\debug\rovuka.exe` and configure a model in **Connect your
   model** if needed. Ordinary browsing does not need a model.
2. Open these two public pages in separate tabs:
   `https://en.wikipedia.org/wiki/Rust_(programming_language)` and
   `https://en.wikipedia.org/wiki/Python_(programming_language)`.
   Wait for each to display readable text.
3. Open **Ask AI → Task mode**. Keep **Research only**, then choose
   **Compare selected tabs (read-only)**.
4. Check only those two pages. Paste:
   **Compare these pages on typing style, memory management and intended uses.
   Quote each page for factual claims. Leave details not established by that
   page Unknown. Do not browse or perform any actions.**
5. Check **Allow sharing only my selected pages with my selected model** and
   choose **Start task**, then **Approve all for this task**.
6. Expect two rows, source-checked quotes or explicit Unknowns and source
   buttons. Neither original tab should change. Open a source; it must open a
   new tab. Return through **Task mode → View findings** to see the same table.
7. For the second feature, choose **New task**, select **Search the web in a new
   research tab**, and ask: **Compare Notion, Obsidian and OneNote for offline
   solo project planning. Use official sources, mark unknown pricing, and do
   not sign in or buy anything.** Grant sharing consent and approve navigation
   individually or task-wide. Originals stay open; the new task tab visits
   only the bounded approved sources.

These are manual provider tests, not a promise of a particular live-model
answer. If a page reloads/closes, the run stops rather than combining stale
documents; refresh your selections and provide fresh consent. Unreadable pages
or unsupported model output produce an explicit failure/evidence gap.

### Conversation layout and date awareness

Questions and the reply composer stay together; search history and collapsed
activity sit below the conversation, actions and result. **Expand task** gives
the active conversation a centered, full-width workspace; **Show browser**
returns to the sidebar without stopping the task.

While running, **Working** has animated dots (static with reduced-motion enabled).
The sticky header shows the latest native step and seconds spent on that step;
this is waiting feedback, not invented progress or proof that a provider is healthy.
Live activity opens automatically and its timeline follows new entries. Scrolling
back pauses following; **Jump to latest** resumes it. While following, the
workspace keeps the live timeline visible; scrolling upward pauses following. Approvals
and questions take priority, and waiting/terminal states stop the working animation.
Connection errors explicitly replace Working with a reconnecting status.

A blocked navigation is a failed run, not a shortlist. The diagnostic includes
destination origin/path and navigation type, omitting queries/fragments. A
successfully repaired model-format diagnostic is explicitly marked repaired; a
fatal second rejection opens its stage and exact cause.

### Redirects during research

Real sites redirect constantly (locale paths, `www` canonicalization, HTTPS
upgrades, and search-result wrappers such as Google's `/goto?url=...`). The
native guard applies one policy to **server redirects and script navigations
without user activation**:

- **Same site** (same host ignoring one leading `www.`, same port, same scheme
  or an HTTP→HTTPS upgrade): followed inside the approved navigation, up to 8
  hops. Each hop is listed in Activity and the Permission trail.
- **Another website**: the load is cancelled before it starts and the task
  pauses with **Follow this redirect to another website?** showing the real
  destination. **Approve all for this task** also covers these redirects
  and records them. Declining stops the task; the other site is never opened.
  At most 3 cross-site hops per approved navigation.
- **Never followed**: checkout/account-changing destinations (same heuristic as
  links), non-HTTP(S) schemes, embedded credentials, the trusted browser UI,
  and redirect loops. These fail the task with the blocked destination.
- Script navigations from the *previous* page while an approved navigation is
  pending are cancelled, so they cannot replace the approved destination.
  User-initiated clicks inside the task tab, non-GET navigation, popups and
  downloads are still blocked.
- Same-document URL updates (`pushState`, `replaceState`, fragments) keep the
  task on the same page instead of failing with "page URL changed". Only moves
  the guard approved are adopted; any other URL change still fails.

These are research navigations only: following a redirect never submits forms,
books or buys anything.

Model repairs receive the **exact rejected response as quoted data**, along with
the validation error and original evidence. Previously they received only the
error text. Valid search/link actions missing a non-executable `reason` now show
an explicit missing-explanation notice instead of aborting; the exact target,
observed-link checks, approvals and task limits are unchanged. Empty queries,
invented URLs/citations and multiple actions are still rejected.
One narrow exception handles a reproduced provider response shape (relevant when a
provider does not use structured output): exactly two
byte-identical JSON objects collapse to one action with an explicit activity
notice. Native validation and approval run before that single action; different
objects, three copies, extra prose and duplicate JSON keys remain rejected.

Per-option source arrays may be derived when omitted/empty **only from references
already inside that same option**: inline citations, destination source IDs and
price-component references. Native code deduplicates these IDs and checks them
against the declared finish sources, visited pages, observed links and price
evidence. It never substitutes the entire top-level source list or overwrites a
nonempty declared option list. Options without any own references still fail.
The activity trail records this normalization. Missing prices remain unavailable.

**Inspect rejected model response** exposes the last rejected output in memory
(up to the 32 KB decision limit), with attempt/stage/resolution status. It may
contain task/page content: inspect before sharing. Starting a new task or closing
the browser discards it from the UI (an excerpt is also in the local log below).
Normal malformed output gets one repair, never an unbounded retry loop.

### Structured decisions

Every task decision is requested with the provider's **structured output** and a
strict JSON schema named `browser_decision`: Responses API `text.format` (OpenAI,
Microsoft Foundry v1), Chat Completions/Azure `response_format`, an Anthropic forced
tool with `disable_parallel_tool_use`, or Gemini `responseJsonSchema`. The model fills
typed fields of one flat object instead of writing free-form JSON: `action` is
`search`, `flightSearch`, `hotelSearch`, `followLink`, `needsInput`, `unable` or
`finish`, and fields that action does not use are `null`. The schema shapes output;
native parsing, validation, approvals and price checks still decide what happens.

- An endpoint that rejects schemas (HTTP 400/404/422) is retried once without one.
  Activity shows "does not support structured output", the log records the provider
  error, and that endpoint/model stays on validated plain JSON for the session.
- Some models append a second output message after the decision (for example an
  imagined result of the step). Structured streams keep only the first output item
  and log "Ignored an extra model output item".
- Unused fields are ignored. Unknown fields, missing required fields, empty queries
  and invented URLs are still rejected and repaired once.
- The log records `structured=true|false` for every decision.

### Native flight and hotel search

Travel prices no longer depend on generic web searches. The model returns typed
parameters; native code validates them and builds a fixed `www.google.com` URL with
`hl=en-US&gl=us&curr=USD`:

- **`flightSearch`**: IATA origin/destination, `YYYY-MM-DD` dates (today to one year
  ahead, return not before departure), adults, children and lap infants (at most 9
  seats, no more infants than adults) and cabin. Native code encodes Google Flights'
  `tfs` parameter. Fares include taxes and fees for all passengers, so
  "$1,576 round trip" is the party total.
- **`hotelSearch`**: place, check-in/check-out (1-30 nights) and **one room's** guests
  (adults and child ages 0-17). Dates and guests are encoded in Google Hotels' `ts`
  parameter and `q` is only `Hotels near <place>`. Google's natural-language parser
  silently drops dates when the place contains a comma and shows default one-night
  prices. The model multiplies the room total by the number of rooms.
- Both use the task's research permission (approve once, or approve all for this task) and appear in
  **Searches performed** labelled **Flights** or **Hotels**. Their result pages are
  directly read `page` sources, so quoted fares and stay totals can pass native price
  verification; ordinary web-search pages remain leads.
- Google Hotels cards show nightly rates; the stay total with taxes sits in each
  card's hover panel. On Google travel pages only, the reader prepends a
  **Google Hotels price cards** list built solely from strictly patterned values
  (`$N nightly`, `$N total`, `N nights with taxes + fees`). No other hidden text is read.
- An identical repeated search is rejected even after Google rewrites the URL
  (`ved`, re-encoding): searches compare host, path and decoded `q`/`tfs`/`ts`.
- Option cards show each component's cost, e.g. `Flight: United · $1,576.00` and
  `Hotel: … · 2 × $777.00`, next to the ranked total.

Reader rules: `aria-hidden` no longer hides content, because modal dialogs (such as a
Google Hotels promo) set it on the still-visible page behind them; computed visibility
and layout decide. Same-page `#fragment` links are never offered as navigation.

`tfs` and `ts` are undocumented Google parameters, verified live on 2026-10-04 and
pinned by unit tests. If Google changes them, `--live-web` shows the effect.

### Diagnostics and logs

Every launch appends to a local log at `%LOCALAPPDATA%\AIBrowser\logs\rovuka.log`
(rotated to `rovuka.log.1` above 5 MB; override the folder with `AIB_LOG_DIR`,
verbosity with `RUST_LOG`, default `info`). It records:

- the build: version, executable path and its build time (spot stale binaries);
- task start (goal, model, options), every Activity step and permission event;
- each model decision's latency/size, and rejected model responses (≤4 KB) with
  the validation stage and cause;
- every navigation-guard decision with full URLs: same-site redirects followed,
  cross-site redirects paused, blocked navigations/redirects, same-document URL
  updates adopted, and any task-tab URL change that was **not** approved;
- final status, page count, option count, or the full error cause chain.

Preparation revalidation also records a fixed reason code (changed document,
form/dialog identity, visibility, control state or destination), without
logging input-event keys, coordinates or extra field values. Stale actions stay
unexecuted. Activity explains the bounded fresh observation/permit retry rather
than presenting it as a completed action.

It stays on this machine and never contains API keys or page text, but it does
contain your task text, visited URLs and model-output excerpts; delete it anytime.
Failure screens and the research trail show the build and log path, plus
**Copy diagnostic report**, which copies status, error, model diagnostics,
Activity, permissions, searches and pages read as plain text.
"Page URL changed" errors now name the expected and actual page (origin/path).

Results also degrade instead of failing: an option price whose quotation is not
found on the cited page is removed (shown as **Price unavailable**), and an option
link that does not resolve to an observed link is dropped. Each removal appears
in Activity. Neither can turn into an invented price or URL.

For an opt-in end-to-end check on the **real web**,
`node .\scripts\test-agent.cjs --live-web` runs your configured model on
`AIB_LIVE_GOAL` (default: an Austin→LAX Thanksgiving flights + hotels request) in
a disposable, signed-out profile with real Google search. It grants research
permission on the first approval, answers one clarification generically, waits
up to 11 minutes, then prints the result (each option's components, quotes and
scope), Activity and log tail. Set `AIB_LIVE_SCREENSHOT=<absolute .png path>` to
also capture the finished results screen. It incurs model
usage and real site traffic; checkout/account pages, form submissions and
downloads stay blocked. Site availability, bot checks and prices vary over time.

For an opt-in real-provider smoke test, `node .\scripts\test-agent.cjs --live-model`
uses the currently configured model/key without changing settings and sends only
the scripted synthetic task and disposable loopback site evidence. This incurs
model usage, uses no signed-in browser profile, permits only exact loopback
destinations, and does not certify live travel availability. The default fixture
command does not contact the configured cloud model. Add `--family` to exercise
four travelers (including children aged 8 and 15) and two rooms against explicitly
defined synthetic per-person/per-room rates.

Developer regression: `--replay-option-sources <absolute-response-json-path>`
replays the captured two-option/five-source failure shape using local fixture
observations and source/link IDs. It does not contact a cloud model or certify
the captured claims against live pages. Keep captured responses outside the
repository because they can include personal task/page content.

Failures and no-evidence outcomes also open the workspace automatically, rather
than leaving an empty web area with an easy-to-miss sidebar error. The exact
protocol diagnostic is visible. **Retry with my details** fills a new task form
with the original goal and user replies, requiring fresh page-sharing consent.
It does not resume or pretend to repair a failed task.

Every model request (including page Q&A and task corrections) receives the
system clock's current UTC/local timestamp, local date/year, IANA timezone and
current UTC offset. Task prompts also retain a start-time anchor across replies.
The model is instructed to resolve relative dates and state exact dates instead
of asking a year already implied by the clock. For example, on October 4, 2026,
upcoming US Thanksgiving is November 26, 2026. US Thanksgiving calendar dates
are calculated natively, not guessed from model training data.

The clock/timezone are shared with the selected model. They are based on OS
settings, not geolocation; keep those settings correct. Ambiguous holiday locales
or travel ranges can still need clarification. A current UTC offset does not
predict daylight-saving offsets at a future destination. These are model
instructions, not a guarantee that every model interprets dates correctly.

### Actionable results workspace

The results view is action-first: a short summary, then numbered choices and
provider links. Supporting reports, caveats, source pages and search/activity
history sit **below the options**, collapsed when there is a shortlist.
Each option's detailed evidence and tradeoffs are expandable, not a wall of prose.

The default **Result format → Actionable options · prices & direct links** requires a
structured final report, rather than accepting only prose. The planner is asked
for 2-4 concrete alternatives when evidence supports them. Cards are always
numbered **Option 1, Option 2, ...**, including the best-fit card. There is
no forced minimum: missing alternatives must be explained, not invented.
Choose **Research brief / explanation** for explanatory tasks and compatibility
with models that only return a cited plain answer.

**Travel:** when flights and hotels are requested together, instructions require
named flight + hotel combinations, dates, travelers/rooms/nights, separate
flight/hotel links (or an observed package link), and comparable cost breakdowns.
**Shopping:** named products/variants, compatibility and seller links come first.
General services and explanatory questions have their own guidance. The embedded
instruction profiles live under `crates/aib-app/src/instructions/`; the model
selects the matching intent without an extra classification call or brittle
keyword router. Rebuild the native binary after editing those instructions.

**Price ordering is native, not a model's claimed ranking.** Optional offers use
integer minor-unit amounts and quantities, with exact short price quotations from
directly read page text. Native code checks quotation/amount provenance, computes
component subtotals (for example round-trip fare x travelers + nightly room rate x
room-nights), and sorts ascending **within the same currency, cost basis and
scope**. The best-fit recommendation stays attached to its option after sorting.
Mixed groups are labelled; currencies are not converted, nightly/per-person
costs are not ranked against whole-trip costs. Unpriced options follow priced
groups and explicitly say **Price unavailable**.

USD/EUR/GBP/CAD/AUD with English-style currency-prefixed decimal prices are
currently supported. Other formats require an unpriced option, not guessed
conversion. Search snippets cannot support a priced offer. A flight + hotel trip
subtotal requires both priced components. Exclusions remain visible in details;
taxes, bags, resort fees and shipping are not assumed included.
These checks establish snapshot provenance and arithmetic, **not** semantic
correctness, live inventory or a bookable quote. The bounded reader cannot
operate airline/hotel date pickers; if provider pages do not expose suitable
prices, it must say so rather than fabricate a cheap trip.

Each option can include up to three direct-site buttons for manual booking,
buying or further reading. The model references observed `sourceId`/`linkId`
pairs; native code resolves the URLs and rejects missing/invented links. Labels
identify whether a destination was read or is only a link observed on a source.
Legacy option reports fall back to directly read source pages, not search
snippets disguised as bookable offers. When no destination was established,
the card says so explicitly. An observed destination is not verified stock,
availability or a guarantee that it matches the option.

Click a direct-site button to open the real website in a new foreground tab with
user control. The current tab is not replaced, and the results stay available
through **View findings** at the top of the Task mode sidebar. This also applies
to citations, source cards and search-history links, including sidebar sources.
Dates, variants, rooms, availability, taxes and final prices must be checked
there. No automatic checkout, form filling, booking or purchase takes place.

Recommendations are model judgments, not independent certification. Every option
and finding must reference visited sources included in the accepted answer.
Unknown source IDs, invalid recommendation indexes, oversized report fields and
unsupported report properties are rejected and get the existing one correction
attempt. In **Research brief / explanation**, models that return the older answer-only shape remain supported
and receive a readable brief, without manufactured option cards.

Search pages are labeled **Search lead**, not verified offers. The planner is
instructed to follow relevant publisher/provider links after useful searches
instead of repeatedly rephrasing queries, and to finish with explicit gaps when
the six-page budget is exhausted. This is model guidance, not a guarantee that
every model will research optimally.

**Back to conversation** restores the sidebar. Opening a source/revisiting a
search opens a new tab and returns to normal browsing. **View findings** reopens the same
in-memory report without another model call. **New task** replaces that run when
started. Failures/no-evidence open automatically; for stopped runs, **View research trail**
shows an incomplete result with the failure and observed pages—never a fake winner.

This view expands the existing trusted CEF assistant across the content area;
it does not navigate the web tab to a token-bearing UI URL or execute model HTML.
Model strings are rendered as React text. Findings and conversations are
session-only, not saved/exported reports yet.

### Task-scoped approval controls

- Defaults to **ask before each navigation**. Pending approvals have a visible
  waiting banner, prominent primary button and a gentle halo. The halo respects
  reduced-motion preferences; it never auto-confirms an action.
- **Approve all for this task** is explicit, cross-site and session-only.
  It authorizes validated searches, observed-link GET navigation and redirects
  those pages make to other websites for this
  task, with the existing six-page/ten-minute limits. It includes sharing read
  page content with the selected model and using the browser's existing profile.
  In opt-in preparation, it also covers supported public search operations,
  never transactions or arbitrary form submissions.
- The automatic-task banner includes **Ask before each navigation** in research
  or **Ask before each action** in preparation to revoke subsequent authorization.
  Use **Stop / take over** to cancel current model/reader waits; an action already
  consumed by the native executor cannot be undone.
- Grants expire on completion, failure, no evidence, cancellation or manual
  takeover, and never transfer to a new task. Stale approvals cannot grant them.
- The native guard still blocks non-GET navigation, popups, downloads and
  redirects into checkout/account pages (see **Redirects during research**).
  Recognizable checkout/account-changing
  paths/actions are conservatively refused during research and left for manual
  handoff. This URL heuristic is not comprehensive action detection: GET requests
  and site scripts can have side effects, and ordinary signed-in cookies/network
  activity still apply.
- A timestamped **Permission trail** records one-time approvals, automatic
  navigation authorization, revocation and expiry, with exact destination URLs.
  Exact destinations appear in the session trail; the durable audit stores only
  metadata, origins and permission decisions.

The legacy research-only API grant remains narrower and never authorizes
preparation. The new task-wide grant is separately explicit, scoped to the same
task/tab, and cannot override native action limits, privacy checks, audit errors,
document/control checks or unsupported capabilities.

Isolated task profiles, comprehensive personal-data detection, a general LLM
critic and strong transaction confirmation remain before broader automation.
Native privacy checks, a no-tools task reader, independent outcome checks and
durable metadata-only audit are implemented as described below.

### Safe Browser Operator: public search preparation preview

**Research only remains the default.** Preparation is a separate opt-in
capability, not permission added to an existing research grant.

1. Open a public search page, or expand **Details, costs & sources** on a
   research option and choose **Prepare on this page**. The latter opens a new
   provider tab and an editable draft; it does not start, share pages or approve
   anything. Your previous completed research findings stay available.
2. In **Ask AI → Task mode**, select **Prepare public search fields - choose
   your approval scope**. Preparation starts on the current webpage, not the
   trusted welcome page. Configure/select your model as usual.
3. Supply literal values and ISO dates. For example:

   > Find hotels in Cancun from 2026-11-20 to 2026-11-25 for two adults,
   > one room. Do not book.

   Use future ISO dates within the supported horizon. This complete, basic
   Hotels.com request uses a native shortcut described below. For other
   compatible controls, missing exact dates or observed option labels require
   clarification; webpage instructions cannot supply invented values. English
   month names, relative dates and ambiguous numeric dates are not automatically
   normalized by the verified hotel shortcut.
4. Explicitly allow sharing task pages, then choose **Start task**. Review the
   website, exact control and value before **Approve this action only**.
   GET searches additionally show the full destination and every parameter that
   will be sent. Generic GET searches include existing form values; the
   Hotels.com shortcut forwards only its reviewed nine fields.
   Or choose **Approve all for this task** once to authorize subsequent supported
   operations. Every operation still needs a fresh exact, single-use native
   permit and successful audit persistence; it is not permission to book.
5. Watch **Page actions** and live Activity. **Stop / take over**, tab changes,
   manual navigation or trusted input on the webpage cancel further preparation.
   An already executing approved action may finish; actions are not rolled back.
6. Review the prepared page and continue manually. **Return to previous research
   findings** reopens your original shortlist without another model call.

**Practical Hotels.com shortcut.** On the verified public GET search form,
Rovuka supports both the inline destination input and the compact destination
dialog, including its suggestions rendered outside the form. It performs:

1. Open the destination dialog, if the compact layout requires it.
2. Enter your exact city.
3. Select the website's matching city suggestion, not an airport or similarly
   named neighborhood. A genuinely ambiguous city needs a destination choice.
4. Open the reviewed GET search with your exact check-in/out and party.

That means **three actions inline, four in the compact layout**, or fewer
when the exact city is already accepted. Choose individual approvals or **one
task-wide approval**. The complete supported native request needs
no model calls or repeated manual suggestion, calendar or guest-picker steps.
The final review displays destination, dates and adults/room prominently; its
nine technical parameters are expandable. The selected location and region ID
come from the current website, never a guessed production constant. No raw
form submission, `FormData`, opaque fields or POST handler is used, and the
result URL must retain the verified search route and every reviewed parameter.
The independent verifier also checks the displayed result dates and
adult/traveler/room summary; a correct URL alone is not sufficient.

This shortcut accepts labelled future ISO dates within 366 days, **1-9 adults
and exactly one room**. Child ages and multiple-room allocations are explicitly
unsupported, not silently omitted. The zero-model shortcut recognizes the
original complete prepare/open-search request and common basic wording such as
the example above, including number-word adults/rooms. Flexible wording uses a
strict user-only structured resolver, not webpage defaults. Additional price,
amenity or other requirements must not be silently dropped or presented as an
applied filter.
It is search preparation, not a guarantee of availability, booking or universal
hotel-widget support. Site challenges still require manual verification, and
ordinary website notices may need dismissing.

Supported controls are labeled public-search text/search/date/number/time/month
inputs, single-choice filters, limited calendar/guest/filter buttons, disclosure
controls, observed links and 600-pixel scroll steps. Native GET searches are
constructed from reviewed fields without clicking submit or invoking a form's
submission handlers. Arbitrary buttons, custom widgets, POST or other form
submissions, messages/applications, uploads/downloads, bookings/payments and
account changes require manual use. Unsupported pages fail explicitly rather
than gaining broader permissions.

The separate strict `browser_operator` protocol accepts numeric observed control
IDs, not model scripts, selectors, coordinates or invented URLs. Native
single-use permits expire after two minutes and require successful audit
persistence before execution. The isolated-world executor rechecks the exact
document, node, URL and current value. Generic controls also require the whole
document's mutation revision. Verified hotel controls instead check their full
destination/region state and immutable form/dialog identity, so unrelated
advertisement churn does not force repeated approvals. Replaced controls/forms,
value-only changes and reloads still invalidate old approvals. Site readiness
and suggestions get bounded waits; trusted manual input during waiting stops
the task. A stopped task now explains whether a webpage click, keyboard input,
scrolling, a browser command or the Stop button took over. The stopped run keeps
its reason and offers **Retry with my details**, which prefills an editable draft,
resets sharing consent and requires fresh approval; it never resumes or replays
automatically. While preparation is running, use the assistant panel to review
Activity or approvals: clicking, typing or scrolling on the **webpage** hands
control back to you and expires the task grant. Limits are 12 executed actions, six page reads,
three cross-site redirect hops per action, five clarification replies and ten
minutes per task. **A legacy research-only grant never authorizes preparation**,
including its cross-site redirects. Explicit supported-task authorization does
not remove any of these checks or limits.

Input values and opaque option values are excluded from the model-facing
control snapshot. Approved action values remain in the session trail, not the
durable audit; the audit adds only task mode and executed-action counts. Older
reader audit records still load as research with zero page actions.

**This is not general-purpose or transaction-safe automation.** Website scripts
can transmit an entered value immediately using normal signed-in cookies, and
GET requests can have side effects. Labels and URL heuristics cannot prove that
a website is safe. A general LLM critic, isolated task profiles and production
sandboxing are still deferred. No booking/payment is
authorized by this preview; do not use sensitive or transactional pages.

### Phase 5: reliability and model capabilities

**Requirements come from the user, not the website.** Hotel preparation
displays the interpreted destination, check-in/out ISO dates, adult count and
room count before approval. A flexible-wording resolver receives only user
messages and the host date, with a strict `hotel_requirements` schema. Native
checks require literal destination, exact date roles and matching counts; known
values cannot be changed or omitted to ask redundant questions. Latest explicit
user corrections are respected. Missing/ambiguous requirements need clarification;
unsupported extra constraints fail explicitly rather than completing a partial
basic search. Repeated already-answered questions stop instead of looping.

**Page interpretation is separate from acting.** Research page text goes first
to a no-tools reader returning bounded factual quotes. Native code checks every
quote against the original protected page; fabricated, masked and recognized
instruction-like quotes are rejected. The actor receives the quote projection
and observed source/link IDs, not raw webpage prose. Preparation receives safe
control metadata, user messages and executed actions, not raw page text or input
values. Labels and quotes are still untrusted: this reduces injection risk, not
guarantees immunity. Page Q&A retains its separate explicit sharing/privacy path.
Research normally adds one reader request per page, so cloud usage can cost more.

**Completion requires independent evidence.** A fixed read-only verifier
checks that filled/selected values remain on the actual control. Completion
rechecks retained values and known user requirements, or verifies an actually
loaded, reviewed public GET search. Hotels.com also needs the observed selected
city and displayed date/party summary. Arbitrary clicks or a model's `done`
claim cannot certify a preparation outcome. Generic widget-only tasks without
a provable final value/search remain unsupported.

Failures show a bounded recovery category and exact error; model request,
reader, repair and latency diagnostics remain visible. Request counts are
logical model calls; schema negotiation can make an additional HTTP request.
**Retry with my details** prefills an editable draft with your user messages and
resets sharing consent. Review corrections or conflicting values before starting
again. Preparation re-inspects the current page with fresh approval scope.
Already applied changes remain; this is not rollback or automatic replay.
Research source/price checks do not independently fact-check every narrative
claim or establish live inventory.

Open **Ask AI → Reliability** for selected-model capability reports:

- Explicitly approve the selected-model evaluation and possible provider charges,
  then choose **Run selected model checks**. Six built-in synthetic checks cover
  hotel requirements, genuine missing dates, grounded reader quotes, exact public
  field proposals, injected sensitive-control refusal and observed-link selection.
- No browser tools run and no real pages/history/forms/files are shared. These
  are protocol checks, not live website success-rate certification. Ordinary
  browsing remains available, but browser tasks and evaluations cannot overlap.
- **Stop evaluation** cancels the outstanding local request; remote processing
  or billing may continue. Planned/not-run checks remain in the denominator,
  rather than making a stopped run look 100% successful.
- Reports show provider/model, package build/suite version, provenance, each
  outcome/failure category, passed/planned percentage and median measured latency.
  Fixture/mock evidence is never labelled a real-model capability rating.
- Metadata-only reports persist locally under
  `%LOCALAPPDATA%\AIBrowser\model-evaluations`, with an absolute
  `AIB_EVALUATION_DIR` development override. Up to 50 runs and 128 KB per report;
  no raw prompts, page text, responses, endpoint URLs or keys. Storage is checked
  before paid requests; corruption/write failures are explicit. Files are plain
  JSON with user-directory permissions (0600 on Unix), not encrypted or signed.

The local runner additionally checks eight actual native fixture task cases:
natural and structured hotels, a public GET form, priced shopping options,
quarantine, revocation, wrong results and task-grant permit checks. The mismatch
case tests both changed query values and a correct URL with wrong displayed
travelers. The runner uses disposable profiles/settings/audit/evaluation storage.

```powershell
node .\scripts\test-agent.cjs --eval-only
node .\scripts\test-agent.cjs --eval-only --repeat 2 --eval-output "$env:TEMP\rovuka-native-evaluation.json"
```

Repeats accept 1-10. Output paths must be absolute. Import that JSON in
**Reliability → Native end-to-end regression reports** to retain it alongside
model checks. Imports are local/unsigned reports, not independent certification;
the complete planned suite is validated. `--eval-only --live-model` explicitly
opts into your configured provider and possible charges on synthetic/local
fixtures; never use it for unattended CI. Evaluation fixtures do not navigate
live websites.

The Windows [reliability workflow](.github/workflows/reliability.yml) builds the
UI and standard native executable, checks formatting, runs serial Rust workspace
tests and repeats the relative-date native fixture evaluations with a mock model.
It uploads only the metadata JSON, not profiles, settings, screenshots or logs.
No paid provider or secret is needed. The workflow has been added; remote
GitHub execution is not claimed until it is published and run. Local full
regression and optional live-site tests are separate from this CI benchmark.

### Phase 4 increment: privacy shield and local task audit

Open **Ask AI → Safety** to review the research boundaries and local audit.
The privacy shield is always enabled; it cannot be turned off by a model or an
allow-all research grant.

- **Before model calls:** task goals/replies, page text, titles, headings and
  link labels are checked natively. Recognizable API tokens, labelled passwords,
  bearer tokens, private keys, one-time codes, US SSN-shaped strings and
  Luhn-valid card numbers are replaced with `[redacted]`. A saved model key is
  also masked by exact value once loaded. Page Q&A uses the same checks and
  displays a masking notice. Ordinary prices, traveler counts and travel dates
  are preserved.
- **Before navigation:** sensitive query parameters (such as `access_token`,
  `password`, signed-link signatures and OAuth codes), recognizable secrets and
  redacted placeholders are refused in research URLs. Percent-encoded values
  are checked too. Unsafe observed links are excluded without renumbering safe
  link IDs. The native redirect guard applies the same rule, even under
  allow-all; the normal user's manual browsing is unchanged.
- **Before diagnostics:** complete tracing records are buffered and masked
  before console/file output, including secrets split across formatter writes.
  Diagnostic logs can still contain other personal task text and URLs, and old
  log generations are not retroactively scrubbed. Do not publish them unreviewed.
- **Local audit:** each task atomically updates a small JSON record under
  `%LOCALAPPDATA%\AIBrowser\task-audit`. It contains timestamps, last recorded
  status, counts, site origins and permission decisions—not the goal, page text,
  answer, full URL/query/fragment, model endpoint or credential. Up to 50 recent
  records are retained. The report and conversation are still session-only.
  An audit is not replay, task resumption, or tamper-proof evidence.
- **Explicit storage failures:** a task cannot start if its audit cannot be
  saved. A later audit write failure stops the run and exposes the error instead
  of silently claiming an audited result. Approval/reply continuations are
  signalled only after persistence succeeds, and native leases reject commands
  from failed/stopped tasks.
- **Controls:** Safety can copy the redacted audit (excluding the OS storage
  path) or delete it after a second confirmation. Deletion is refused while a
  task is active. Clearing it does not delete session findings or diagnostic
  logs. Audit data is never uploaded automatically; site origins/timestamps
  can still be personal, so review a copy before sharing.

`AIB_AUDIT_DIR=<absolute directory>` overrides the audit location for development.
The native fixtures set it to their disposable directory, not your real history.
Files use the OS user's directory permissions (0600 on Unix); they are plain
JSON, not encrypted. A record left by a crash shows its **last recorded** state,
not a currently running or resumable task.

Closing the browser stops and joins the trusted server runtime and its
filesystem workers before CEF shutdown. This prevents audit work from being
abandoned during native teardown.

**Limits:** deterministic masking is defense in depth, not comprehensive secret
or personal-data detection. It cannot reliably identify every custom token or
instruction hidden in a webpage. Task research now has a separate no-tools
quote reader, but page data remains untrusted and a general critic is not
implemented. Existing cookies, website
scripts and their network requests still run. Do not share sensitive pages you
would not otherwise send to your model. Production sandboxing remains pending.

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
native privacy checks also mask recognizable secrets in visible content. This
is not comprehensive detection of sensitive information.

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
The task waits up to 30 seconds for the approved page to settle and checks
consecutive not-loading states before reading/accepting a decision. Guard-approved
moves (same-site redirects, same-document URL updates) are adopted; a loading race
in the reader or just before approved navigation is retried within that bound.
Unapproved URL changes, blocked redirects/downloads, closed/switched
tabs, other CDP failures and persistent loading still fail explicitly.
Cancellation interrupts those waits; no navigation approval is bypassed.
Empty/unvisited source lists never become accepted research results.
Repeated invalid output fails with an actionable message, not a fabricated answer. The
runtime permits at most **six pages**, **two minutes per model decision**, and
**ten minutes per task**, including approval and clarification waits.
At most **five clarification questions** are allowed per task. Stop/manual
takeover cancels a waiting question; duplicate, stale or late replies are rejected.
Questions and user replies are sent to the pinned model and kept only in memory.

During a run, native navigation guards block user-initiated or non-GET main-frame
navigation, redirects into checkout/account pages, popups and downloads; other
redirects follow the redirect policy above. Every
model-proposed navigation needs fresh native authorization, through one-action
approval or the explicit supported-task grant; approvals cannot be reused after
stopping.

**Important limits:** This is a reader agent, not a full operator. No clicking,
typing in research, uploads, purchases, unapproved autonomous search, screenshot/vision fallback,
accessibility-tree merge, iframe/shadow-DOM traversal, parallel research or
full snapshot/replay audit is implemented yet. The durable audit is metadata
only. Ordinary site scripts, their
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
cargo test --workspace -- --test-threads=1
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
layouts. Additional fixtures exercise a non-travel comparison, explanatory
findings without a winner, report-source rejection, same-URL loading churn,
native full-width expansion and source/back/reopen navigation. It does not call
your cloud model or modify your normal settings.
Result-link checks verify new foreground tabs, exact hotel/flight/seller and
source destinations, unchanged existing tabs and preserved findings without
new model calls. Returning after closing a destination tab is also covered.
Safety checks verify masking before task/page-Q&A model calls, unchanged prices
and dates, withheld sensitive links, blocked secret-bearing queries/redirects,
metadata-only audit files, failed approval/reply persistence, token/origin controls,
320px light/dark UI, copy and confirmed deletion without losing session findings.
For a focused, loopback-only safety run after building:

```powershell
node .\scripts\test-agent.cjs --safety-only
```

For scoped selected-tab, comparison and preserved-research regression coverage:

```powershell
node .\scripts\test-agent.cjs --multitab-only
```

This uses synthetic public pages and a local mock model, never real provider
credentials. It checks frozen scope/consent, reader concurrency two, unchanged
originals and private fields, explicit Unknown cells, citations/copy, 320px
themes, duplicates, reload/close, Stop/revoke, bounded protocol correction,
all-Unknown evidence gaps and the new research tab's lease cleanup. The full
suite includes these groups. Windows CI runs this focused suite after the
repeated native evaluations; only metadata evaluation JSON is uploaded.

An explicitly opted-in live check uses your configured model and public
Rust/Python Wikipedia articles with the exact manual-test prompt above:

```powershell
node .\scripts\test-agent.cjs --live-multitab
```

This can incur provider charges. It uses a disposable browser profile, verifies
two source-bound rows and three criteria, unchanged original tabs and source
links in new tabs, then closes its own browser. `AIB_LIVE_SCREENSHOT=<absolute
image path>` optionally saves the comparison locally. It is never part of CI
or the default mock suite, and it does not certify arbitrary pages or models.

The full suite includes 12 operator groups: opt-in draft handoff, exact reviews,
native dates/filters/scroll/GET parameters, retained findings, injected or
transactional proposal rejection, stale nodes/values/documents, trusted manual
takeover, audit-failure gating and the 12-action limit. Reviews are tested at
320px in both themes, with bounded sticky headers, unobscured exact values and
reduced motion. For a focused preparation run:

```powershell
node .\scripts\test-agent.cjs --operator-only
```

The unit suite also checks permit replay, wrong task/tab/URL/mode, expiry,
approval cancellation and backward-compatible reader audit records. These are
local mock-model/website fixtures, not a claim that every hotel site is supported.

For focused Hotels.com preparation validation:

```powershell
node .\scripts\test-agent.cjs --hotel-only
node .\scripts\test-agent.cjs --hotel-only --live-hotel
node .\scripts\test-agent.cjs --hotel-only --live-hotel --approve-all-hotel
```

The 14 local groups cover inline and compact/portal layouts, exact three/four
approval sequences, zero model questions for the complete request, nine curated
GET parameters without submission handlers, 320px review in both themes,
metadata-only audit, preselected cities, form/control replacement, value/region
drift, permit replay, GET-to-POST changes, missing regions, manual takeover,
Stop/reload, result-parameter changes, unsupported party requirements and
unchanged generic behavior on other origins.

`--live-hotel` additionally types bare `hotel.com`, follows the authentic
redirect, prepares the complete Cancun request through native approvals and
checks the actual result title, dates and party. It uses disposable storage and
a local mock model; the supported real-site task must make **zero model calls**.
Add `--approve-all-hotel` to exercise the natural example and click the real
native **Approve all for this task** button once, checking fresh permits and
grant expiry as well as the exact result.
No booking, payment, sign-in, certificate bypass or challenge solving occurs.
`AIB_TEST_HOTEL_SCREENSHOT=<absolute image path>` optionally saves the public
result; `AIB_TEST_HOTEL_DOM=<absolute JSON path>` saves public form metadata
without field values, cookies or headers.

`--shutdown-only` checks native window/server/CEF shutdown with the same isolated
fixture storage and no model request.

For focused welcome/new-tab validation:

```powershell
node .\scripts\test-agent.cjs --start-page-only
```

This mode deliberately omits `--url` to test the normal launch. Its nine checks
cover the trusted start-page boundary, local graphics and themes, shortcuts,
editable drafts without automatic consent/model calls, approved task results,
preserved findings, navigation/new/last tabs and live task cancellation.
The complete local suite also runs these checks with an explicit startup URL.
Both modes use disposable fixture storage and require a normal zero-exit
shutdown, not forced termination.

For focused ordinary-browsing/error validation:

```powershell
node .\scripts\test-agent.cjs --navigation-only
```

Its 13 local groups cover actual omnibox paste before URL commit, exact address
retention, visible trusted error UI, 320px light/dark controls, Edit/Retry,
Back/Forward, failed-page Q&A/research/preparation refusal, slow loading, Stop,
superseded navigation, real HTML 404/429 documents and failed subframes. Four
additional groups cover a one-time inferred-HTTPS root fallback and genuine
redirects, explicit/data-bearing HTTPS exclusions, HTTP warning/no-retry loops,
and cancellation/supersession of fallback candidates. These
checks require no model calls and are also included in the complete local suite.
`AIB_TEST_NAVIGATION_SCREENSHOT=<absolute image path>` saves the native error UI.

An explicitly network-enabled, model-free smoke test additionally visits
example.com, hotel.com and www.hotels.com:

```powershell
node .\scripts\test-agent.cjs --navigation-only --live-browsing
```

It checks that example.com displays its real document and that hotel destinations
show either actual website content or a visible native failure, retaining the
address. It does not solve site challenges, change settings or certify booking
support. All browsers use disposable profiles and close normally.

Current Windows verification: **116 workspace Rust tests and all 153 native
regression groups pass**, preserving all 150 preceding groups and adding three
reader-recovery groups. The 16 scoped multi-tab, comparison and preserved-research
groups cover trusted
selection/approval, exact two-reader concurrency, unselected/form privacy,
source-checked/Unknown cells, reload/close, revoke/Stop, failed synthesis latency,
bounded correction, copy denial, retained findings and one-tab lease cleanup.
Rejected copied quotes recover through native excerpt IDs without fuzzy quote
acceptance. Provider/empty-selection failures and Stop during recovery remain
explicit; the additional reader requests and corrections are counted.
Existing ordinary navigation, hotel preparation, task-wide approval, manual
takeover, narrow themes, privacy/audit and shutdown checks remain passing.
A separate two-repeat evaluation passes **16/16 native task cases and all six
mock model-protocol checks**, including wrong-query and wrong-displayed-result
failures, Stop and both 320px themes. UI type-check, production UI build, standard
native build, formatting and editor diagnostics also pass. Fixture UI transitions
and live-activity checks use explicit synchronization, not fixed delay guesses.
The original Rust/Python Wikipedia request also completed with the configured
live model, including an actual rejected-quote recovery, two source-bound rows,
three criteria and preserved originals/new-tab source links. One initial full
run hit the existing conversation-expansion focus timeout; its unchanged rerun
passed all 153 groups. Live model results can vary; this is not a guarantee of
all future outputs.

The actual native live-hotel test followed bare `hotel.com` to secure Hotels.com
and completed the natural Cancun request with **one human task-wide approval,
four fresh audited actions, zero questions, zero model calls and no manual
widget steps**. Its independently checked visible results showed Cancun,
November 20-25, 2026, and 2 travelers in 1 room; all nine required query values
also matched. Hotels.com may show its ordinary taxes/fees notice over the
prepared results; dismiss it yourself to review offers. Notices, challenges and
sign-in are not silently acknowledged or bypassed.

A further live preselected-Cancun run held its approval for nine seconds before
a trusted task-wide pointer click. It completed one GET action, independently
verified the new November 21-26 dates and exact party/query values, and made zero
model requests. A fixture separately replaces a preselected form while paused:
the old permit is rejected with a fixed reason code and a fresh audited permit
is required to continue under the task grant.

The earlier separate model-free live-browsing smoke displayed example.com and
the Hotels.com homepage; **explicit** `https://hotel.com/` retained its honest
connection-refused error without a downgrade. These fixtures do not certify
live model accuracy or macOS readiness. Windows CI independently runs the
relative-date mock/native evaluations and scoped multi-tab fixtures; it never
uses personal models, profiles or credentials.

It also checks comparison-format correction, observed direct destinations,
invented-link rejection, scoped grants/revocation/expiry, page bounds, native
redirect/download guards under automatic research, manual option handoff,
approval visibility and reduced-motion behavior.
The harness opens a temporary debug port; close it after testing.
`AIB_MODEL_SETTINGS_FILE=<absolute file path>` overrides the model settings file
for isolated development tests; unset it for normal use. API keys are still in
the system credential store, never in that file.
`AIB_AGENT_TEST_SEARCH_URL` is a numeric-loopback-only test override used by the
harness to avoid real search traffic. Leave it unset for normal Google searches.
`AIB_AGENT_TEST_TRAVEL_URL` likewise points native flight/hotel searches at a
loopback fixture; the harness checks the encoded `tfs`/`ts` dates and travelers,
the hidden-total price-card digest, structured-output requests, and the one-time
plain-JSON fallback.
For optional visual inspection, run `node .\scripts\test-agent.cjs --inspect`.
`AIB_TEST_SCREENSHOT=<absolute image path>` saves a native findings screenshot
during the fixture run. The harness closes its own browser afterward.
`AIB_TEST_APPROVAL_SCREENSHOT=<absolute image path>` captures the pending
approval screen, including the scoped allow-all choice.
`AIB_TEST_CONVERSATION_SCREENSHOT=<absolute image path>` saves the focused
full-width task question/reply screen during an ordinary fixture run.
`AIB_TEST_OPERATOR_SCREENSHOT=<absolute image path>` captures the native exact
page-action review. Screenshots and fixture profiles are not release artifacts.

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
