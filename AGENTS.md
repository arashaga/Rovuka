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
Research remains the default; research grants must never authorize preparation.
All operations require exact, expiring, single-use native permits, successful
audit persistence and final document/control/value revalidation.

Operator changes must pass `node .\scripts\test-agent.cjs --operator-only` and
the full native suite after rebuilding. Preserve the original travel price-card
compactness, separate result tabs, retained findings and reader protocol.
Exercise permit replay/expiry/mismatches, replaced nodes, property-only value
drift, same-URL reload, manual input, cancellation, audit failure and action/page
bounds. Growing action history must not enlarge the sticky stop header or hide
reviewed values behind approval buttons. Do not describe this public-search
preview as a general form operator, transaction firewall or complete sandbox.

Privacy/audit changes must pass `node .\scripts\test-agent.cjs --safety-only`
after rebuilding. Native fixtures isolate `AIB_AUDIT_DIR` from the real history.
Start-page/assistant-shortcut changes must also pass
`node .\scripts\test-agent.cjs --start-page-only`. The normal launch/new-tab page
must stay in a separate trusted BrowserView, never a token-bearing content tab.
Opening a task draft must not call a model or preselect sharing consent.
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
