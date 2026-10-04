# Development documentation

Keep [Mac OS parity](mac-os-parity.md) current whenever a development phase adds
or changes features, native dependencies, platform behavior, filesystem
locations, security boundaries, or packaging requirements.

Distinguish Windows-tested functionality from unverified macOS work. Update the
parity matrix, remaining-work checklist and dated change log. Keep README's
phase and installer status accurate; never describe a development executable
as an installable release.

The parity guide is intentionally local and Git-ignored. Do not stage it or
upload it; maintain the existing local copy. On a new checkout, create a local
guide before adding platform changes. Public build/usage details belong in README.
Never commit runtime model settings, personal endpoints, browser profiles,
environment secrets or credential exports.
