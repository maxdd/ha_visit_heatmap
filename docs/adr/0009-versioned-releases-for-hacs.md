# ADR-0009: Versioned releases — HACS compares the tag, not a commit

## Status: Accepted
## Date: 2026-10-19

## Context

The Release workflow (see ADR-0006 for the packaging) published a GitHub release
for every push and tagged it with the short commit SHA. `hacs.json` uses
`zip_release`, so that release's `visit-heatmap.zip` is what HACS installs.

HACS decides whether an update is available by comparing two strings
(`hacs/utils/version.py`, `HacsRepository.pending_update` in the HACS
integration):

- the **installed** version, read from
  `custom_components/visit_heatmap/manifest.json`;
- the **available** version: the tag of the newest release that is neither a
  draft nor a prerelease.

The comparison is `AwesomeVersion(available) > AwesomeVersion(installed)`. When
either string has no recognized strategy, HACS falls back to plain string
inequality — "different" means "update".

Commit hashes fit neither side of that. A seven-digit all-digit SHA parses as a
build number (`5229304`) that outranks every semantic version, so each
SHA-tagged release looked newer than any release with `0.3.0` in its manifest.
A SHA containing a letter parses as `UNKNOWN`, so HACS fell back to string
inequality and again reported an update forever. Every installation was
permanently "out of date", and the release selector showed hashes where versions
belong.

## Decision

Releases are **tagged with the integration version**: the exact string in
`custom_components/visit_heatmap/manifest.json`, no `v` prefix and no commit
hash, so tag and manifest are identical and both parse as semver. The Release
workflow reads the version from the manifest, refuses anything that is not
`X.Y.Z`, and publishes one release per version. A push that does not change the
version publishes nothing (with a notice in the log); a manual run re-publishes
the current version's asset. The build commit is recorded in the release notes
rather than in the tag.

## Consequences

- (＋) HACS update detection works: a `0.3.0` install is not offered `0.3.0`,
  and `0.3.1` is offered once its release exists.
- (＋) The HACS release selector lists real versions, and a version tag matches
  the manifest inside its zip, so installing that version is reproducible.
- (＋) The release history reads by version; the commit SHA stays in the release
  body for traceability.
- (－) Forgetting to bump the manifest means the push is not released. The
  workflow logs a notice and skips, but the bump has to be noticed.
- (－) Old SHA-tagged releases stay in the repository. They are older than every
  version tag, so HACS ignores them; deleting them by hand is optional.
- (－) Re-running the workflow for a version replaces that release's asset, so a
  version is a snapshot until someone does so deliberately.

## Rejected

- **Keep SHA tags and let HACS fall back to string comparison** — every install
  shows a permanent update, so the update entity never settles and "update"
  carries no information.
- **Tag `vX.Y.Z` while the manifest says `X.Y.Z`** — AwesomeVersion accepts both
  and compares them equal, but the HACS UI, the tag and the installed version
  would spell the same version two ways. One spelling: the manifest's.
- **Publish a release on every push regardless of version** — the tags would
  stay versions, so HACS would compare equal and offer nothing, while the
  released zip silently drifted from the version its tag claims.