# Development documentation

Keep [Mac OS parity](mac-os-parity.md) current whenever a development phase adds
or changes features, native dependencies, platform behavior, filesystem
locations, security boundaries, or packaging requirements.

After code changes, rebuild the standard `target\debug\rovuka.exe` the user
launches (close a running Rovuka first, telling the user). Never leave a fix only
in an alternate `--target-dir`; the diagnostic log's first line shows which build ran.

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
page data, isolated cookies or persistent browser memory.
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

Privacy/audit changes must pass `node .\scripts\test-agent.cjs --safety-only`
after rebuilding. Native fixtures isolate `AIB_AUDIT_DIR` from the real history.
Start-page/assistant-shortcut changes must also pass
`node .\scripts\test-agent.cjs --start-page-only`. The normal launch/new-tab page
must stay in a separate trusted BrowserView, never a token-bearing content tab.
Opening a task draft must not call a model or preselect sharing consent.
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
