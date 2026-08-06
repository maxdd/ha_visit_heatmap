# 08 — HACS publishing readiness

**What to build:** Make the repo genuinely installable by others via HACS: a README with quickstart and a config reference, validated `hacs.json`/`manifest.json` (integration category, versioned releases), and CI that lints and unit-tests the integration (ruff + pytest) and type-checks/builds the card. Also a documented release checklist so cutting a version is repeatable.

**Blocked by:** 05 — Card renders the fading visit layer; 06 — Moving fixes and journey dotted lines; 07 — Card config surface and visual editor; 03 — Backfill from recorder; 04 — Integration options flow

**Status:** ready-for-agent

- [x] README documents install, quickstart, config reference (integration options + card config), and the glossary defaults.
- [x] `hacs.json`/`manifest.json` validate; the repo installs from a HACS-added repository.
- [x] CI runs ruff + pytest for the integration and build for the card. — The card is plain JS (no TypeScript sources), so "typecheck" is delivered as the esbuild build + `node --check` on the bundle (`.github/workflows/ci.yml`).
- [x] A release checklist is documented so version cuts are repeatable. — README "Releasing" section.
