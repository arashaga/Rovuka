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

Distinguish Windows-tested functionality from unverified macOS work. Update the
parity matrix, remaining-work checklist and dated change log. Keep README's
phase and installer status accurate; never describe a development executable
as an installable release.

The parity guide is intentionally local and Git-ignored. Do not stage it or
upload it; maintain the existing local copy. On a new checkout, create a local
guide before adding platform changes. Public build/usage details belong in README.
Never commit runtime model settings, personal endpoints, browser profiles,
environment secrets or credential exports.
