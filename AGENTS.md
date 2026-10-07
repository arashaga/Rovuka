# Development documentation

Keep [Mac OS parity](mac-os-parity.md) current whenever a development phase adds
or changes features, native dependencies, platform behavior, filesystem
locations, security boundaries, or packaging requirements.

After code changes, rebuild the standard `target\debug\rovuka.exe` the user
launches (close a running Rovuka first, telling the user). Never leave a fix only
in an alternate `--target-dir`; the diagnostic log's first line shows which build ran.

Model HTTP requests reuse a bounded pair of cookie-free clients in `aib-models`:
cloud/default-proxy and loopback/no-proxy. Do not rebuild a client for every
actor/reader request or put authentication in shared default headers. Headers,
model, prompt, schema and trusted clock context belong to each fresh request.
Preserve the 15-second connection timeout, refused redirects and explicit
build/connect/cache errors. Pooling adds no application-level inference retry,
permission or task resumption. Test one keep-alive connection across changed
keys and a keyless request, and verify a redirect target receives no request.

Agent decisions use the strict schema in `crates/aib-app/src/protocol.rs`; change
the Rust types, `decision_schema()` and `INSTRUCTION` together. Travel URLs (`tfs`,
`ts`) are undocumented Google formats pinned by unit tests: after changing them,
the reader (`perception.js`) or travel instructions, also run
`node .\scripts\test-agent.cjs --live-web` and inspect prices, not just status.

Preparation has a separate strict `browser_operator` protocol in `operator.rs`
and a fixed isolated-world executor in `operator.js`. Keep its schema, parser,
native policy, control descriptions, UI review and tests aligned. Model output
must never supply executable scripts, selectors, coordinates or navigation URLs.
Research remains the default; legacy research-only grants must never authorize
preparation. Explicit `approveAll` grants cover supported actions only for the
current task/tab and mode; `allowAllResearch` remains the narrower legacy API.
All operations require exact, expiring, single-use native permits, successful
audit persistence and final document/control/value revalidation.
Revoke invalidates unconsumed automatic permits using the permission epoch;
Stop, manual takeover and terminal status retire grants. Never let approve-all
authorize booking/payment, messages, uploads or arbitrary submissions.

Operator changes must pass `node .\scripts\test-agent.cjs --operator-only` and
the full native suite after rebuilding. Preserve the original travel price-card
compactness, separate result tabs, retained findings and reader protocol.
Exercise permit replay/expiry/mismatches, replaced nodes, property-only value
drift, same-URL reload, manual input, cancellation, audit failure and action/page
bounds. Growing action history must not enlarge the sticky stop header or hide
reviewed values behind approval buttons. Do not describe this public-search
preview as a general form operator, transaction firewall or complete sandbox.
Stopped preparation must retain a visible cause and a consent-reset retry draft.
Webpage pointer/keyboard/wheel takeover detection must not mistake assistant
approval input for page input. Revalidation logs use fixed metadata reason
codes, never input keys, coordinates or field-value dumps. Hotel approval tests
must include trusted pointer clicks and preselected destinations, not only
synthetic element.click() calls.
Trusted fixture clicks must wait for an enabled, in-viewport hit target with
stable geometry before dispatching pointer input; approval smooth scrolling and
responsive reflow must not redirect clicks to a different action.
UI continuation checks must wait for a new native approval ID after an async
click rather than accepting the previous pending proposal. Trusted webpage
keyboard tests must verify native content focus, not merely a CDP target.
Require an actual trusted event in the website document before expecting
takeover; browser-consumed Escape and deferred wheel delivery are not proof.

Hotels.com preparation uses the native `hotel_search.rs` contract and typed
`hotelSearch` payload, not arbitrary form submission. Keep the native scope
parser, nine-field GET builder, result checks and trip review aligned. Do not
guess region IDs or silently omit children, room allocation or extra filters.
Only the verified GET form/destination controls may tolerate unrelated DOM
churn; immutable form/dialog/node identity and relevant values still must match.
Support the observed inline input without assuming a menu-trigger data-stid and
the compact portal dialog. Run `--hotel-only` and the full suite after rebuilding;
`--hotel-only --live-hotel` must verify the original exact Cancun prompt in at
most four approvals without manual controls or model calls. Use disposable
storage, public metadata only and no certificate or challenge bypass.
Also run `--hotel-only --live-hotel --approve-all-hotel` for the natural request
and actual task-wide UI approval. Independent completion needs both the exact
loaded query and displayed dates/party, not a correct requested URL alone.

Reliability boundaries use `requirements.rs`, `evidence.rs`, `structured.rs`,
`verification.rs` and the separate fixed `operator_verify.js` readback.
The hotel resolver reads user messages only; never accept page defaults,
omitted/changed known values or silently dropped filters. The no-tools reader
returns exact source-checked quotes, never tool instructions. Original protected
observations remain the authority for existing price/source checks; projected
evidence alone must not replace that grounding. Do not claim injection immunity
or independently verified narrative facts.
Rejected reader output may use one native-excerpt-ID recovery. Generate only
bounded, source-native, nonmasked/non-instruction-like candidates; resolve IDs
natively and rerun unchanged exact projection checks. Never accept a paraphrase
with fuzzy matching or send rejected quotes to the acting agent. Valid empty
evidence and initial provider failures are not retries. Count recovery requests,
repairs and settled latency; Stop/audit failure must prevent further work.

Research shortlists use `research.rs`, not a brand/site recommendation router.
Keep discovery, candidate verification and synthesis separate: native bounded
progress lists only safe observed unvisited links, and `followLink.sourceId`
scopes a link to an earlier task observation (null preserves latest-page
behavior). Guide actionable comparisons to reserve reads for distinct candidates
before additional catalogues or single-choice price-shopping; this is model
planning guidance, not a new native budget or a mandatory fake shortlist.
Actor navigation uses checked projections; original protected
snapshots still ground prices and exact option quotes. Only successfully
settled native navigation may map an observed redirect wrapper to its landing
page. Earlier links still need the current task's lease, policy and approval.
Nonempty actionable options require directly read named-choice evidence and
specific observed destinations; shared generic catalogues are not shortlists.
Retain bounded checked named-choice quotations from declared direct sources
alongside model-selected quotes. Do not replace forged quotes or invent support
for missing criteria; provenance is not an independent semantic certification.
Prefer native source-assigned quote IDs over model-retyped text. Resolve only
the selected source's bounded checked catalogue; reject mixed text/IDs, unknown
IDs, source mismatch and UTF-8 byte overflow. IDs must be removed before native
report validation, UI output and archival; unresolved references cannot be stored.
Keep legacy exact text quotes compatible, without fuzzy acceptance.
Named-choice identity may use a leading exact native hostname namespace plus an
observed exact name. Never strip arbitrary brands or invented variant suffixes.
Use the same source-bound identity proof for candidate and destination review.
Rank exact native primary-title, same-source verified-price, heading and checked
body-quote identity in that order for candidate destinations: related-product
mentions must not make distinct primary pages a shared catalogue. Equally
strong distinct read URLs remain ambiguous; do not pick the first match.
This ranking must not invalidate or replace a valid explicit source-backed
destination merely because another reference page has a more similar title.
Price-component identity must belong to the checked quote's source, not another
declared source. Checked quotes still prove provenance, not semantic suitability.
Preserve the reviewed travel-result-page exception and native price sorting.
Do not accept shared catalogue targets just because product headings occur on
the listing. Promote a specific destination over unrelated navigation links.
Budget exhaustion still permits report-only corrections using existing native
source IDs and null link IDs; never instruct the model to discard already-read
candidate evidence. Starting/from prices are not exact variant totals; check
the protected source context even when the proposed quote strips the qualifier.
Separate `researchProgress.readDestinations` report references from unvisited
`availableLinks` navigation. Emit only directly read factual, safe, unchanged
source observations. Null link IDs belong only to report destinations, never
`followLink`. At any remaining-page count, first repair names/quotes/links using
existing exact evidence; navigate only for genuinely missing facts. Preserve
the loop guard and bounded protocol correction. Show the native review reason
and guidance in Activity, without briefly publishing rejected recommendations.
Repair unrelated destination links from unique, checked, declared candidate
sources without another model round; record the native correction in Activity.
Count other options' matching candidate sources as shared targets before repair,
so a multi-name catalogue cannot become several specific destinations.
Only explicit cross-site-hop exhaustion may recover, at most twice within the
existing task iteration bound and after native document readiness is rechecked.
Exclude every attempted/paused target in the failed route from further tools;
do not create factual sources or settled aliases for it. Keep the failure visible
in Activity/model progress. Other guard/readiness/lease errors still fail closed.
At most two native completion-review rounds provide explicit evidence gaps
without expanding page/question/time budgets or temporarily publishing weak
cards. Limited sourced briefs may have no options; never fabricate alternatives.
Valid-empty research readers expose navigation-only projections, not raw prose
or factual source authority, and still consume a page. Keep strict comparison
empty-reader behavior unchanged. Per-option exact quotes are bounded, remain
untrusted and survive historical archives; source checks do not certify fit,
live stock or semantic truth. Inferred legacy quotes must preserve byte bounds.
Supplied option quotes need the same native provenance checks in brief mode;
legacy briefs without that field must retain their original compatibility.
Run `--research-only`, `--eval-only --repeat 2` and the full native suite after
rebuilding. `--live-web --live-research` is a separate explicit cost/network opt-in;
verify meaningful distinct read destinations, exact capability quotes and
prices or explicit gaps, not only completed status. Custom live goals must not
receive an automatic unrelated travel reply. Keep live JSON/logs/screenshots
private and never enable that mode in CI. GUI suites run sequentially.

Evaluation changes must pass `--eval-only --repeat 2` and the full native suite.
Keep model-protocol and native-end-to-end scopes, fixed case IDs, suite version,
complete planned denominators and fixture/mock versus selected-model provenance
aligned across Rust, the UI and runner. Counts/latencies and expected failures
must reflect actual checks. Preserve opt-in provider charges, Stop, no browser
side effects, authenticated APIs, task/evaluation exclusion and lazy metadata-only
storage. CI uses a mock model and relative dates; upload only the bounded result
JSON, never profiles/settings/logs/screenshots or provider credentials.
Imports are local/unsigned, not certified or trusted user instructions.

Selected-tab comparisons use `comparison.rs` and a separate fixed native
snapshot path, not a relaxation of the active-tab navigation/operator guard.
Freeze 2-6 explicit native tab IDs, exact URLs and document epochs; revalidate
before reads and publication, and deduplicate URL/fragment copies without
silently adding sources. Metadata listing is not sharing consent. Refresh,
selection/mode changes and retry reset consent; recognizable unsafe/loading/
failed/trusted pages remain unavailable.
Keep FrameTree/isolated-world/fixed-reader steps ordered, expiring and single-use
across permit clones, with audited authority checks before dispatch and after
replies. Revoke must discard unaccepted automatic reads and recover with
bounded fresh approval, including revocation during permit authorization.
Stop retires scope and prevents late publication. Legacy navigation-only
grants cannot authorize selected-page sharing.

Retain original protected snapshots and source-specific checked evidence.
Readers have no tools and concurrency two; synthesis sees only their checked
quotes. Align the comparison types, strict schema, instruction, validator and
UI: one row per source, bounded unique criteria, exact same-source normalized
quotes or null/Unknown, no invented/calculated values or model URLs. One bounded
correction only; failed readers never publish a partial table. All-Unknown
tables are NoEvidence, not completed results or protocol errors. Search snippets
remain leads. Do not claim semantic fact-checking, live availability, immutable
page data or isolated cookies. Persistence is only the explicitly configured
local Memory feature below, never implicit task resumption.
The optional web-research workspace creates one ordinary task tab, preserves
unread originals and reuses existing bounds/guards. Stop/completion release its
lease while leaving it for review; comparisons create no worker tabs.
Run `--multitab-only` and the full native suite after rebuilding, including
trusted selection/approval, unselected/form privacy, copy denial, reload/close
through model latency, revoke/Stop, duplicates, malformed evidence/citations,
all-Unknowns, retained comparison and 320px light/dark layout. GUI suites must
run sequentially. Restore and test the compact 1008x605 viewport after narrow
layout emulation, including trusted sharing consent. CI remains local/mock-only
with no private artifacts.
`--live-multitab` is a separate opt-in selected-model/public-Wikipedia smoke
check with possible provider costs, disposable storage and owned-browser
cleanup. Never include it in default or CI fixtures.

Local memory uses `memory.rs`, authenticated `memory_api.rs` routes and a
separate fixed native capture bridge. SQLite/FTS5 is lazy, default-off and
single-owner; `AIB_MEMORY_DIR` is independent of the CEF profile override.
Use bundled SQLite, parameterized SQL, literal keyword/date validation,
bounded records and visible corruption/unavailable-store errors. Never reset
a broken database silently or block the CEF thread on its database mutex:
capture policy/status have separate locks, and SQLite work belongs on blocking
workers. Cover lock contention and late discovery of stored privacy settings.
Native captures freeze tab/URL/document/privacy generations. Keep ordered
FrameTree/world/fixed-reader stages expiring and single-use across clones;
pause/exclusions/clear must invalidate queued reads and prevent late commits.
No model-supplied method/script/selector or relaxed operator authority.

Archive only native finished research/comparison contents, not client-supplied
reports, approvals, leases, live state, diagnostics or provider settings.
Preserve resolved source links and native totals losslessly. Validate stored
reports without weakening the strict live-model parser's native-only field
rejection. Archived renderers remain historical/read-only, not fresh citations
or resumed preparation. Exclusions purge dependent research; clear-all removes
preferences and persistently pauses capture. Do not claim encryption,
forensic/backup/provider erasure or exhaustive sensitive-page detection.

Sharing needs an exact native preview plus separate explicit research consent.
Limit selected items/excerpts, expiry and pending previews; consumption rechecks
privacy generation, item versions/deletion/retention and recognizable secrets.
No default selections or ordinary-task inheritance. Planner/synthesis receive
separate historical context; quarantined page readers never receive it.
Legitimate bounded task corrections retain the same frozen context. Mode/goal/
scope changes, retries and new tasks reset consent; preparation refuses sharing.
Context never supplies source authority or approves browser actions.
Run `--memory-only`, `--tabs-only` and the full native suite after rebuilding.
Native fixtures isolate `AIB_MEMORY_DIR`, use actual owned-browser restarts and
retain trusted click/focus checks. Tabs must preserve full active/close visibility,
clear theme borders, overflow/new controls, continuous keyboard navigation and
exact 84px native chrome. Keyboard activation keeps native chrome focus through
the optional IPC flag; pointer activation and native page shortcuts retain
content focus and every tab activation still interrupts active tasks.
Mirror the flag in Rust/TypeScript and preserve its older default wire shape.
The default full suite includes memory, not live/scoped comparison-only runs.
CI remains local/mock-only and uploads no memory artifacts.

Privacy/audit changes must pass `node .\scripts\test-agent.cjs --safety-only`
after rebuilding. Native fixtures isolate `AIB_AUDIT_DIR` from the real history.
Start-page/assistant-shortcut changes must also pass
`node .\scripts\test-agent.cjs --start-page-only`. The normal launch/new-tab page
must stay in a separate trusted BrowserView, never a token-bearing content tab.
Opening a task draft must not call a model or preselect sharing consent.
Reference-redesign changes must also pass `--redesign-only` after rebuilding.
Preserve 84-DIP dark chrome and the 384-DIP preferred assistant; respect theme,
keyboard, close/new/overflow controls and trusted native hit targets.
The intent studio maps only to supported brief/options/preparation/selected-tab
drafts. Mirror optional draft-only IPC fields and preserve old wire defaults;
they never carry selections, sharing consent or action permission.
Use real native model/memory metadata, not reference mock claims or static
results. Cross-surface change hints contain no data; re-fetch authenticated
metadata on successful writes and retain visible errors. Ship local SVG/CSS,
not the reference's CDN, decorative window controls or unsupported features.
Navigation changes must pass `--navigation-only` and the full native suite.
Keep pending/failed address metadata separate from the committed document URL
used by native guards. Main-frame errors use the separate trusted start view,
not a token-bearing website URL; failed/loading pages cannot become AI evidence.
Cover cached Back/Forward recovery, exact-destination Retry/Reload, normal Stop,
superseded loads, successful recovery, failed subframes and real site error
documents. Inferred HTTPS-to-HTTP fallback is a one-time manual bare-root
connection retry, never an alias map, explicit/data-bearing HTTPS downgrade,
certificate/SSL/DNS/offline bypass or agent permission. Cover genuine redirects,
HTTP warnings, no retry loops and Stop/supersession; retire stale candidates.
New ordinary-navigation logs omit URL queries/fragments. The optional
`--navigation-only --live-browsing` smoke test accesses public sites without model
calls; never bypass certificate failures or website verification to make it pass.
Keep the durable audit metadata-only: never add goals, snapshots, full URLs,
model responses or endpoints. Sensitive outbound URLs and audit write failures
must fail explicitly; allow-all never bypasses these checks.

Distinguish Windows-tested functionality from unverified macOS work. Update the
parity matrix, remaining-work checklist and dated change log. Keep README's
phase and installer status accurate; never describe a development executable
as an installable release.

The parity guide is intentionally local and Git-ignored. Do not stage it or
upload it; maintain the existing local copy. On a new checkout, create a local
guide before adding platform changes. Public build/usage details belong in README.
Never commit runtime model settings, personal endpoints, browser profiles,
environment secrets or credential exports.
