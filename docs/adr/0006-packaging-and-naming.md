# ADR-0006: Packaging — single HACS repo `ha-visit-heatmap`

## Status: Accepted
## Date: 2026-08-06

## Context

Two components (integration + card) could ship as one HACS repo or as two. The user
chose one repo, both components included.

## Decision

One repository, **`ha-visit-heatmap`**, installed via HACS as a single integration
that also ships the card bundle. Layout:

```
ha-visit-heatmap/
├── custom_components/
│   └── visit_heatmap/          # companion integration (JSON storage, WS command)
├── www/
│   └── visit-heatmap-card.js   # bundled custom card
├── hacs.json            (integration)
├── manifest.json        (integration)
└── README.md, docs/
```

Name: repo/integration `ha-visit-heatmap`, card element `visit-heatmap-card`.

## Consequences

- (＋) One install path for users; one place to document, issue-track, version.
- (＋) The integration can register the card JS as a frontend resource automatically
  (`websocket_api` + `http` frontend resource registration), so the card is available
  with no extra `yaml` step.
- (＋) Easier first-party maintenance (one of the user is the solo maintainer).
- (－) A card-only consumer (who has their own recording) can't install just the card;
  acceptable and rare at this scale.

## Rejected

- **Two separate repos** (one HACS integration, one HACS frontend) — double versioning,
  docs, and release overhead for a solo project.