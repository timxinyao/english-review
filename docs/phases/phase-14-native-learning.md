# Phase 14 — Native learning reliability

Status: implemented and locally verified, 2026-10-29. See `../NATIVE_LEARNING_QA.md` for exact verification and remaining platform acceptance limits.

## Decisions
- Source translations are supplied once with learning content, not generated at runtime. A nullable example translation column is added non-destructively; re-import backfills only missing translations and never resets progress. Earlier no-migration scope applied to the original upgrade; this explicitly requested follow-up adds migration 0011.
- Preserve Phase 13 scramble and existing data, no migration/reset or deployment.
- Keep proven FSRS parameters; fix due fairness, evidence validation and multi-item data integrity.
- Cold-white iOS-feeling design, terracotta action, system text, readable serif targets; no fake haptics.

## Completion
- [x] Backend and interaction regressions verified
- [x] Native visual system implemented and compared against concept
- [x] Repeated simulated operations and image QA
- [x] Full quality gates and documented platform limitations

## Changelog
- 2026-10-29: Added optional `source_example_translation` import/export and `sourceExampleTranslation` Today/Library projection, answer-only reveal, Library edit preservation, old-data compatibility and progress-safe translation backfill. Independent review resolved stale-field and lifecycle edge cases; 1,025 tests, lint, all typechecks and production build passed. Browser-runner limitation and exact evidence: `../SOURCE_TRANSLATION_QA.md`.
- Preserved Phase 13 data contracts; added regression-tested learning integrity, native-feeling interaction system, and iterative responsive visual verification.
