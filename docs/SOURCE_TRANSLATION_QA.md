# Source-sentence translation verification

2026-10-29 follow-up on `ac446449d73f4a2baa7ca90d3a73c105db10f63c`.

## Scope and data safety

- `显示答案` reveals the saved original-sentence Chinese translation for Learn and Understanding. Before reveal and after advancing, it remains hidden. Missing/null/blank legacy content shows no empty translation block.
- Optional import/export field: `source_example_translation`; Today/Library API: `sourceExampleTranslation`. New chat imports include a full-sentence translation. Library supports explicit viewing/editing and import preview displays the supplied translation.
- Migration 0011 only adds nullable `learning_examples.translation`; the populated-0010 migration regression verifies existing data remains unchanged.
- Import fills missing translations on the matching sentence and preserves existing conflicting translations with a warning. Capitalization is preserved for translation association. Unchanged goals do not trigger progress/status reconciliation; backfill tests cover review states, history, personal examples, sessions, tasks and statistics.
- Source or personal sentence edits clear stale translations. Unchanged extra sentences retain their translation. Library submits the translation only when intentionally changed, using the initial editor baseline even across background refetches.
- Ordinary library export preserves the source translation; complete backup preserves translations for all example kinds and accepts old backups without the field.
- No runtime AI translation, external inference, corpus backfill or deployment was performed for this follow-up. The user will deploy independently.

## Fresh automated gates

| Gate | Result |
| --- | --- |
| API Vitest | 63 files, 677 tests passed |
| Web Vitest | 44 files, 333 tests passed |
| Shared Vitest | 2 files, 15 tests passed |
| Total | 1,025 tests passed |
| API / Web / service-worker / Shared TypeScript | Passed |
| Repository ESLint | Passed |
| Production Vite and service-worker build | Passed |
| `git diff --check` | Passed |
| Compact Playwright regression | Discovery/compilation passed; browser execution blocked |

Used installed CLIs directly: per-package `node node_modules/vitest/vitest.mjs run` and `node node_modules/typescript/bin/tsc --noEmit`; Web additionally checks `-p tsconfig.sw.json` and runs `node node_modules/vite/bin/vite.js build`; root `node node_modules/eslint/bin/eslint.js .`. Known React Router future-version notices remain in Web test stderr, with no test failures.

The new unit/API regressions were run failing-first, then green, including the independent review's stale personal-translation, editor-refetch and content-only lifecycle cases. Both repository import-skill copies were updated; a dry-run changed from omitting the translation to including it and retaining preview/merge rather than destructive restore.

## Browser acceptance limit

The compact E2E test now imports a translation through the real preview/commit API and asserts hidden-before, visible-after and hidden-on-next-card behavior at 320×568. Its discovery passes. Chromium launch is blocked by the execution sandbox's socket restriction; the authorized escalation failed during sandbox startup, before the browser command executed. No restriction was bypassed. No new rendered screenshot, iPhone/Safari run, physical-device acceptance or successful full Playwright run is claimed for this follow-up.
