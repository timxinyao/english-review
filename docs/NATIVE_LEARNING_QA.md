# Native learning upgrade — verification

> 2026-10-30：本报告保留原升级的历史验证。后续暖纸配色、圆角、复习卡片间距及本轮浏览器门禁见 [暖纸 UI 验证](WARM_REVIEW_UI_QA.md)。

Date: 2026-10-29. Base: `d4a6799`.

## Automated verification

| Gate | Result |
| --- | --- |
| API Vitest | 61 files, 659 tests passed |
| Web Vitest | 44 files, 319 tests passed |
| Shared Vitest | 11 tests passed |
| API / Web / Shared TypeScript | All passed |
| Repository ESLint | Passed |
| Production Vite + service-worker build | Passed |
| `git diff --check` | Passed |
| New compact Playwright regression | Discovery/compilation passed; browser-runner execution not claimed |

Commands use the installed package CLIs: `node node_modules/vitest/vitest.mjs run`, `node node_modules/typescript/bin/tsc --noEmit` in each package; root `node node_modules/eslint/bin/eslint.js .`; Web `node node_modules/vite/bin/vite.js build`. New E2E discovery: `node node_modules/@playwright/test/cli.js test e2e/native-learning.spec.ts --list`.

A clean base checkout with the same dependencies established **26 API failures / 572 passes** and **3 Web failures / 293 passes** before repairs. Most failures were stale Phase 13 free-typing, queue, prefetch and model-task-count fixtures; explicit-model discovery also had a real unnecessary-network dependency. Historical free-typing records remain explicitly tested as historical fixtures, not silently converted into current scramble behavior. New safety assertions cover zero-write rejection, per-item evidence, independent dimensions, pruned audits, lifecycle transitions and stale feedback.

## Actual browser operations

The production JS/CSS was served through a local preview and exercised in Chromium with the real Fastify services and a throwaway seeded SQLite database. AI generation used the existing mock provider. This was not a static screen mock. A responsive iframe provided actual 402×874, 320×568 and 1024×768 CSS viewports; it was not an iPhone hardware simulator.

Repeated operations included:
- Login, idle plan, start, stable chip selection/removal/clear, exact submission and partial-evidence submission.
- A one-shot local 503 before the answer service; the nine-chip draft remained intact and retry advanced progress exactly once.
- Recall reveal, rating, explicit undo confirmation/cancel/Escape, restored task and redo; complete five-card sessions.
- Read-only history with per-target evidence, Library search/detail and persisted FSRS/history, local mock Read generation, desktop reading, Settings feedback opt-in.
- Focus containment/restoration, pending destructive-action guards, reduced-motion/capability failures and duplicate submission have additional unit coverage.

External audio transport was not used for acceptance. The existing TTS proxy attempted an outbound request during the first pass; that request was denied, with no successful response confirmed. Subsequent QA explicitly returned local 503 for TTS and blocked external fetches in the fixture process. Product audio code was not removed or changed to evade that restriction.

## Iteration and visual acceptance

The reference concept preceded the redesign. Actual screenshots were inspected, corrected and recaptured rather than accepted after one pass.

| Finding | Correction / evidence |
| --- | --- |
| 320px header icons collided with route title | Mobile header retains Settings; statistics and safe refresh remain available in Settings. `09-today-320-final.jpg` |
| Narrow heading left an awkward final character | Balanced wrapping, `09-today-320-final.jpg` |
| Scramble bank clipped behind a tall dock | Compact horizontal action dock, stable bank; `10-scramble-402-final.jpg` |
| Short-screen reveal left meaning out of view | Scroll revealed meaning to nearest visible position; `13-recall-320-reveal-visible.jpg` |
| History contradicted per-target Hard evidence | Today and Library use participant verdicts; `14-history-per-target-final.jpg`, `21-library-per-item-final.jpg` |
| Empty queue offered extra new words | Cap by actual queue count; `22-completed-empty-queue-final.jpg` |
| Retry error was below the scroll region | Error stays above fixed actions, draft retained; `23-visible-error-dock-final.jpg` |
| Feedback control looked like a plain checkbox | Accessible native-style switch, `24-settings-native-switch-final.jpg` |

Fidelity review covered: cool off-white/terracotta token palette; system UI text plus serif vocabulary; quiet hierarchy and grouped lists; 18px surfaces and large primary actions; safe-area-aware fixed chrome/docks; stable chips and readable feedback; short-screen scroll behavior; desktop sidebar and reading line length. Intentional deviations from the concept: existing 提交/不会/继续 vocabulary is retained, real fixture counts/content replace illustration data, and the narrower two-column scramble dock preserves usable content height. No fabricated streaks or metrics were added.

Screenshots are external QA artifacts, not bundled application assets. The local artifact set contains the concept and numbered before/after JPEGs. The final set includes Today, recall, scramble, error/retry, history, completion, Library, mobile/desktop Read and Settings.

## Remaining acceptance boundaries

- No Safari/iPhone hardware run, native keyboard/safe-area measurement, physical haptic verification, or real AI quality evaluation is claimed. The current scramble workflow uses chips rather than a software keyboard.
- WebKit has no dependable Vibration API support for this use case: [standards position](https://github.com/WebKit/standards-positions/issues/267), [Safari/iOS request](https://bugs.webkit.org/show_bug.cgi?id=288846). Feature detection is only a request capability, not proof of a physical pulse.
- The environment could not launch the shell Playwright browser. The managed browser operations above and API tests were performed separately; the full existing Playwright suite still requires execution in a supported browser-runner environment.
- The supported browser API exposed screenshots but no continuous video recording. No continuous recording or synthetic video is presented as evidence.
- Deterministic assembly is not free-form grammar correction. Legitimate alternative word orders may be rejected; target-surface semantic alignment still depends on generated content. Existing FSRS parameters were not retuned and improved long-term retention is not claimed.

The original upgrade above did not include migrations, historical regrading, production data access, a new audio feature, authentication changes or deployment. The subsequently requested source-translation follow-up adds nullable migration 0011; see [SOURCE_TRANSLATION_QA.md](SOURCE_TRANSLATION_QA.md). It still does not reset learning progress or add runtime AI translation.
