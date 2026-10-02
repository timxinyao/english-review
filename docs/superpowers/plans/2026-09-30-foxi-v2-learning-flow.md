# Foxi V2 Learning Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace low-value cloze/check tasks with Recall, selective full-sentence Production, and optional pure reading, while safely migrating existing progress.

**Architecture:** A nullable item-level override determines whether Production is required; review service remains the only Stage/mastery writer. V2 is a coordinated local-day-boundary release: Today creates every due task without waiting for AI, binds only the current/small-lookahead task, and rejects stale-day writes. Import, backup, Library Practice, Read, and frontend all consume the same effective goal contract.

**Tech Stack:** React + Vite + TypeScript, Tailwind + shadcn/ui, TanStack Query, Fastify, Zod, Drizzle + SQLite, Vitest, Playwright, pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-09-30-foxi-v2-learning-flow-design.md` (approved in conversation). Read it before executing this plan.

## Global Constraints

- Before code, read `AGENTS.md` and its seven required design/development docs; update `PRODUCT_DESIGN.md` first, then the other affected docs and a new Phase 9 record. Use Red → Green → Refactor for every behavior change.
- `productionEnabledOverride` is stored as `0 | 1 | null`; effective goal is `override ?? (type === 'chunk')`. Word defaults off, chunk defaults on. No AI goal classifier or full-library labeling.
- Formal Understanding is Recall (choice only as Hint); formal Production is a complete sentence with target visible. No new cloze or Read checks. Library Practice is one Recall, plus one Production only when enabled; it never changes formal Stage.
- Production intervals remain `1 / 3 / 7 / 14 / 30 / 60 / 120` days and existing pass/basic_pass/fail transition rules. New-item Production begins no earlier than the next local day. No daily due cap; unfinished is not fail.
- Live legacy P states reset once to L0 at V2 cutover; Understanding, attempts, Personal Examples, and daily stats remain. A V1.2 backup restored after cutover gets the same P reset independently of the database-wide migration marker.
- Retain old question/attempt rows for normal history retention. Keep the old cloze evaluator available until cutover; after cutover old-day submissions return 409, not a cloze grade.
- Release is **not** an automatic mid-day feature flip: deploy the coordinated V2 build at/after the next `APP_TIMEZONE` local-day boundary. Run one idempotent transactional migration on first V2 boot before serving requests or prefetch. Never deploy this plan's partial tasks separately to production.
- Keep existing React/Tailwind/Fastify/SQLite stack, Quiet UI, design tokens and shared components. Do not add an independent Practice page or a new business store.
- Do not commit, push, or deploy merely because a task says PASS. The user asked for a plan to hand to another agent; subsequent execution/release requires their direction. Preserve the unrelated dirty `.claude/skills/import-english/SKILL.md`.

## File Map / Interfaces

| Unit | Files | Responsibility |
| --- | --- | --- |
| Product contract | `docs/{PRODUCT_DESIGN,TECHNICAL_DESIGN,DATABASE,AI_RULES,ARCHITECTURE,PHASES}.md`, `docs/phases/phase-9-foxi-v2.md` | Make V2 authoritative before code; record decisions and results. |
| Goal model | `apps/api/src/modules/review/{goals,service}.ts`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/*`, `packages/shared/src/schemas/{learning-item,api/library}.ts` | Effective goal, conditional mastery, persisted three-state override. |
| Library/edit | `apps/api/src/modules/learning-items/{service,routes}.ts`, `apps/web/src/features/library/LibraryDetailPage.tsx`, `apps/web/src/features/library/api.ts` | Change override, reconcile status, cancel pending P, show three-state control. |
| Import/backup | `packages/shared/src/schemas/{import-export,api/import,api/backup}.ts`, `apps/api/src/modules/import-export/{service,routes}.ts`, `apps/web/src/features/library/ImportWizard.tsx` | Goal-aware preview/commit, V1.2 compatibility, V2 export/restore. |
| Cutover | `apps/api/src/modules/review/v2-cutover.ts`, `apps/api/src/{index,db/schema}.ts`, `apps/api/src/jobs/daily-prefetch.ts`, migration SQL | Transactional once-only P reset and Read-flag cleanup. |
| Questions/Today | `apps/api/src/modules/{questions,today}/{service,routes}.ts`, `packages/shared/src/schemas/api/today.ts`, `apps/web/src/features/today/{TodayPage,api}.ts(x)` and `components/*` | Route U/P question kinds, create pending tasks, bind lazily, reject stale writes, present retry state. |
| Practice | `packages/shared/src/schemas/api/practice.ts`, `apps/api/src/modules/practice/service.ts`, `apps/web/src/features/library/PracticeView.tsx` | Recall reveal/Hint and optional one Production, no formal progress. |
| Read | `apps/api/prompts/generate_read.v2.md`, `packages/shared/src/schemas/{ai/index,api/read}.ts`, `apps/api/src/modules/read/{service,routes}.ts`, `apps/web/src/features/read/components/{ArticleView,ReadCheckItem}.tsx` | Generate articles without checks; old answered checks read-only. |

Shared interfaces fixed for all tasks:

```ts
effectiveProductionEnabled(item: { type: 'word' | 'chunk'; productionEnabledOverride: 0 | 1 | null }): boolean
isMastered(u: ReviewStateSnapshot, p: ReviewStateSnapshot, productionEnabled: boolean): boolean
reconcileItemStatus(tx: DbTx, itemId: string, nowIso: string): void
applyV2Cutover(db: AppDatabase, now: Date, timezone: string): { applied: boolean }
prepareTodayTask(db: AppDatabase, deps: TodayDeps, timezone: string, now: Date, taskId: string): Promise<TodayTaskView>
```

API names: `PATCH /api/library/:id` accepts `productionEnabledOverride?: boolean | null`; `POST /api/today/tasks/:id/prepare` generates/binds a pending question and returns `TodayTaskView`. `TodayTaskView.question === null` means pending preparation, never an absent task or a revealed answer. The server determines whether a session/task belongs to the current local day on every mutating Today endpoint.

## Review Focus

- A word with explicit `false`, `true`, or `null` must not collapse these three states during import/export/restore (Task 1 and 3 tests).
- An exact duplicate import with a conflicting explicit goal must not be silently skipped, including CLI commit with `decisions: []` and a concurrent Library edit after preview (Task 3 tests).
- A second boot or post-cutover V1.2 restore must not reuse old P levels or reset V2 P progress twice (Task 4 tests).
- Failed/slow AI or two devices preparing/answering one task must not drop, duplicate, or double-score it (Task 6 and 7 tests).
- A stale tab from yesterday or a canceled P task after goal-off must not settle/undo/write feedback (Task 2 and 7 tests).

---

### Task 1: Authoritative docs, goal schema, conditional mastery

**Files:** Modify `docs/PRODUCT_DESIGN.md` first, then `docs/{TECHNICAL_DESIGN,DATABASE,AI_RULES,ARCHITECTURE,PHASES}.md`; create `docs/phases/phase-9-foxi-v2.md`; modify `apps/api/src/db/schema.ts`, add generated `apps/api/drizzle/0005_*.sql` and metadata via Drizzle CLI, create `apps/api/src/modules/review/goals.ts`, modify `apps/api/src/modules/review/service.ts`, `packages/shared/src/schemas/{learning-item,api/library}.ts`; test `apps/api/tests/unit/review-state-machine.test.ts`, `apps/api/tests/integration/migrate-smoke.test.ts`.

**Interfaces:** Produce `effectiveProductionEnabled`, `isMastered(u,p,productionEnabled)`, `reconcileItemStatus(tx,itemId,nowIso)` exactly as above; DB column `production_enabled_override INTEGER NULL CHECK (... IN (0,1) OR ... IS NULL)`. Shared item detail/list expose both `productionEnabledOverride: boolean | null` and `productionEnabled: boolean`.

- [ ] **Step 1 — docs:** Replace V1.2 user-visible rules with the approved V2 contract, open Phase 9 as `in-progress`, and record why old cloze/Read checks are retired. Check every stated rule against the spec and run `pnpm exec prettier --check docs/PRODUCT_DESIGN.md docs/TECHNICAL_DESIGN.md docs/DATABASE.md docs/AI_RULES.md docs/ARCHITECTURE.md docs/PHASES.md docs/phases/phase-9-foxi-v2.md`; do not mark phase done.
- [ ] **Step 2 — Red:** Add `word null → false`, `chunk null → true`, explicit 0/1 overrides, U-stable/no-P → mastered, U-stable/P-unstable/needs-P → active, paused/archived unchanged, and migration-column-default-null tests. Run `pnpm --filter @el/api exec vitest run tests/unit/review-state-machine.test.ts tests/integration/migrate-smoke.test.ts`; expect new assertions to fail.
- [ ] **Step 3 — Green:** Add column/migration and helper; update all callers of `isMastered` and the review-service write path to reconcile status through the helper. Do not let UI/AI set Stage. Run the same command; expect PASS.

### Task 2: Library goal control and active-session cancellation

**Files:** Modify `apps/api/src/modules/learning-items/{service,routes}.ts`, `apps/api/src/modules/today/service.ts`, `packages/shared/src/schemas/api/library.ts`, `apps/web/src/features/library/{LibraryDetailPage.tsx,api.ts}`; test `apps/api/tests/integration/{library,today}.test.ts`, `apps/web/tests/library-detail.test.tsx`, `apps/web/e2e/library.spec.ts`.

**Interfaces:** `UpdateLearningItemRequest.productionEnabledOverride?: boolean | null`; `updateLearningItem` calls `reconcileItemStatus` in its transaction. On effective on→off, cancel only noncompleted same-day P tasks (`canceledAt`), recompute session progress/completion; on off→on do not insert current-session tasks. A started item whose P state has never been activated gets L0 due on the next Today; previously active V2 P state retains its level/due date. Keep P row/history intact.

- [ ] **Step 1 — Red:** API tests assert all three edit values, type-change with `null`, mastered→active on goal-on, previously inactive P becomes L0 due next Today, U unchanged, P history retained, pending P canceled without attempt/stats change, completed P untouched, stale device answer returns 409, paused/archived remain so. Add Library UI/E2E test for the three choices. Run `pnpm --filter @el/api exec vitest run tests/integration/library.test.ts tests/integration/today.test.ts` and `pnpm --filter @el/web exec vitest run tests/library-detail.test.tsx`; expect red.
- [ ] **Step 2 — Green:** Implement service transaction and DTOs, then the Library control using existing UI components/tokens. On successful mutation invalidate Library and Today queries. Rerun the Red commands plus `pnpm --filter @el/web exec playwright test e2e/library.spec.ts`; expect PASS.

### Task 3: Import, export, and backup goal preservation

**Files:** Modify `packages/shared/src/schemas/{import-export,api/import,api/backup}.ts`, `apps/api/src/modules/import-export/{service,routes}.ts`, `apps/web/src/features/library/ImportWizard.tsx`, `apps/web/src/features/library/api.ts`; test `apps/api/tests/integration/{import-export,backup-restore}.test.ts`, `apps/web/tests/library-import.test.tsx`.

**Interfaces:** New library/backup exports use version `'2.0'`; import/restore accept existing `'1.2'` and `'2.0'`. V2 item field is optional `production_enabled_override?: boolean | null` on import, required nullable on backup. Preview adds `productionGoalChange: { from: boolean | null; to: boolean | null } | null`; commit requires an explicit `decisions[index]` when this is non-null. An explicit conflicting `null` means return to type default. Recheck original override in the commit transaction; concurrent change → 409/re-preview. `decisions: []` remains valid only when no goal conflict exists.

- [ ] **Step 1 — Red:** Tests for absent field preserving existing override; explicit `true`/`false`/`null` on new item; exact-duplicate conflict shown; empty-decision conflict rejected; explicit merge applies; explicit skip preserves; concurrent edit rejects; V2 export/backup round-trip; V1.2 import/backup compatibility. Run `pnpm --filter @el/api exec vitest run tests/integration/import-export.test.ts tests/integration/backup-restore.test.ts`; expect red.
- [ ] **Step 2 — Green:** Extend Zod, preview token snapshot, commit confirmation/recheck, import UI difference copy, and export/restore serialization. Reuse the goal/reconciliation helper; do not infer an absent field as `false`. Rerun the Red command plus `pnpm --filter @el/web exec vitest run tests/library-import.test.tsx`; expect PASS.

### Task 4: One-time cutover and old-backup reset

**Files:** Create `apps/api/src/modules/review/v2-cutover.ts`; modify `apps/api/src/db/schema.ts`, migration SQL/metadata, `apps/api/src/index.ts`, `apps/api/src/jobs/daily-prefetch.ts`, `apps/api/src/modules/import-export/service.ts`; test `apps/api/tests/integration/{migrate-smoke,backup-restore,today}.test.ts` and new `apps/api/tests/unit/v2-cutover.test.ts`.

**Interfaces:** `applyV2Cutover(db,now,timezone)` uses a singleton migration marker `foxi_v2` in a DB metadata table. In one transaction, if not marked: reset every existing P row to L0/stable=0/streaks=0/last=null; set `nextReviewAt=now` for started effective-P active items, null for other items; clear `needsReinforcement`; reconcile active/mastered without changing paused/archived; write marker. Expose a separate `normalizeRestoredV1_2BackupForV2(backup,now)` so each old restore resets its P regardless of marker. Call cutover after schema migrations and before API listen/prefetch; deploy only at/after next local-day boundary.

- [ ] **Step 1 — Red:** Seed mixed word/chunk, explicit overrides, New Queue, mastered, paused/archived, U/P levels, attempts/examples/stats/Read flags. Assert one run resets only P and flags, activates all started effective-P at `now`, preserves histories/U, and second run is byte-for-byte no-op. Assert V1.2 restore after marker resets P, V2 restore preserves P. Run `pnpm --filter @el/api exec vitest run tests/unit/v2-cutover.test.ts tests/integration/migrate-smoke.test.ts tests/integration/backup-restore.test.ts tests/integration/today.test.ts`; expect red.
- [ ] **Step 2 — Green:** Implement marker and atomic migration; make boot/job entry points run it before reading due rows. Normalize old backups inside restore transaction without erasing restored U/stats. Rerun the Red command; expect PASS.

### Task 5: Question routing and prefetch without cloze

**Files:** Modify `apps/api/src/modules/questions/service.ts`, `apps/api/src/modules/review/service.ts`, `apps/api/src/jobs/daily-prefetch.ts`, `packages/shared/src/constants/review.ts`; test `apps/api/tests/unit/{questions-production,daily-prefetch}.test.ts`, `apps/api/tests/integration/today-real-binding.test.ts`.

**Interfaces:** `questionTypesForDue(dimension): ['understanding'] | ['production']`; P question type is always `'production'` at L0–L7. `listUpcomingDue` excludes effective-P-off items. Retain legacy cloze row/parser/evaluator for history only; never acquire/generate/prefetch it for a new V2 task.

- [ ] **Step 1 — Red:** Assert U stock only understanding; enabled P stock only production at every level; disabled P never appears in due prefetch; existing cloze inventory is ignored even when plentiful; New Queue only understanding stock. Run `pnpm --filter @el/api exec vitest run tests/unit/questions-production.test.ts tests/unit/daily-prefetch.test.ts tests/integration/today-real-binding.test.ts`; expect red.
- [ ] **Step 2 — Green:** Remove stage-mix routing and cloze prefetch paths; keep legacy reader/evaluator code only where old rows/history need it. Rerun the Red command; expect PASS.

### Task 6: Fast Today creation and idempotent lazy binding

**Files:** Modify `apps/api/src/modules/today/{service,routes}.ts`, `packages/shared/src/schemas/api/today.ts`, `apps/web/src/features/today/api.ts`; test `apps/api/tests/{unit/today-start.test.ts,integration/today-real-binding.test.ts,integration/today.test.ts}`.

**Interfaces:** `startTodaySession` inserts every due U/P and eligible Learn task with nullable `questionId` before any AI await; `extendTodaySession` uses the same pending-Learn mechanism. The due query excludes effective-P-off items, and `progress.total` includes unbound tasks. `prepareTodayTask` validates same-day, active, pending, effective goal and current question snapshot; acquire/generate outside DB transaction under existing `question-generation` lock, then transactionally compare-and-bind one question. Route `POST /api/today/tasks/:id/prepare` returns answer-free `TodayTaskView`. A background best-effort lookahead of at most 2 tasks uses the same method; it must not delay start response. Generation failure leaves task pending for retry.

- [ ] **Step 1 — Red:** Fake a blocked/throwing AI provider and 100 due items; assert start returns all 100 promptly without awaiting provider work or losing tasks; same-day extend keeps pending Learn tasks on generation failure; prepare failure leaves count/state intact; retry binds; two simultaneous prepares bind one ID; later stale/canceled/goal-off prepare returns 409; existing same-day start is idempotent. Run `pnpm --filter @el/api exec vitest run tests/unit/today-start.test.ts tests/integration/today-real-binding.test.ts tests/integration/today.test.ts`; expect red.
- [ ] **Step 2 — Green:** Split task creation from binding; keep SQLite transactions short; make prepare idempotent and race-safe, and schedule bounded lookahead after response. Preserve existing question invalidation/exclusion rules. Rerun the Red command; expect PASS.

### Task 7: Today scoring, cross-day safety, and pending/feedback UI

**Files:** Modify `apps/api/src/modules/today/{service,routes}.ts`, `packages/shared/src/schemas/api/today.ts`, `apps/web/src/features/today/{TodayPage.tsx,api.ts}`, `apps/web/src/features/today/components/{ActiveSession,TaskCard,RecallCard,ProductionQuestionView}.tsx`; test `apps/api/tests/{unit/today-answer.test.ts,integration/today.test.ts}`, `apps/web/tests/{today-active,today-recall,today-production}.test.tsx`, `apps/web/e2e/today.spec.ts`.

**Interfaces:** `answerTodayTask`, defer, bad-question and feedback paths recheck `sessionDate === localDateString(now,timezone)` before idempotent replay or any mutation; undo already has this guard. Learn settlement initializes P only when effective goal is on (no-P item leaves P at L0/no due date); U-fail reinforcement remains capped by existing rules, P-fail does not reinforce same day. Pending `question === null` shows “正在准备” with retry/later and does not expose an answer; ready Recall uses Hint only as optional scaffold, Production keeps target visible and existing bottom input. No V2 cloze card is reachable.

- [ ] **Step 1 — Red:** API tests assert old-day answer/replay/defer/bad-question/feedback all 409 without attempt or stats writes; unbound answer 409; Learn activates P for chunks/override-on but not default words; U-fail respects the existing reinforcement cap and P-fail adds none; normal U/P settlement and bad-question/undo invariants still pass. Web/E2E tests assert loading→ready, failure→retry/later, no cloze, Hint-only choice, correct reveal on forgot/wrong, and reachable bottom input. Run `pnpm --filter @el/api exec vitest run tests/unit/today-answer.test.ts tests/integration/today.test.ts`, `pnpm --filter @el/web exec vitest run tests/today-active.test.tsx tests/today-recall.test.tsx tests/today-production.test.tsx`, and `pnpm --filter @el/web exec playwright test e2e/today.spec.ts`; expect red.
- [ ] **Step 2 — Green:** Add guards before evaluation and inside settlement transactions, wire prepare/retry UI, retain existing correction/reveal and iOS PWA keyboard geometry. Rerun the Red commands; expect PASS.

### Task 8: Library Practice as Recall + optional Production

**Files:** Modify `packages/shared/src/schemas/api/practice.ts`, `apps/api/src/modules/practice/service.ts`, `apps/web/src/features/library/PracticeView.tsx`; test `apps/api/tests/integration/practice.test.ts`, `apps/web/tests/library-production.test.tsx`, `apps/web/e2e/production.spec.ts`.

**Interfaces:** `PracticeQuestion` adds `qtype: 'recall'` with target/context and hidden-answer options for Hint; `PracticeAnswerRequest` accepts `recall?: 'recalled' | 'forgot'` or `selectedOptionId` with optional `hintUsed`. Start returns exactly `[recall]` or `[recall, production]`; no cloze. Answer/reveal may record nonformal attempts and save an eligible Personal Example, but never calls `advanceReviewState` or changes due/mastered/Today counts.

- [ ] **Step 1 — Red:** Assert one-question word and two-question chunk/override cases, Recall reveal/Hint answer, no target meaning leak before reveal, no cloze even with old P L1 stock, AI failure retry, no formal state/stats mutation after either answer. Add UI/E2E count and feedback cases. Run `pnpm --filter @el/api exec vitest run tests/integration/practice.test.ts`, `pnpm --filter @el/web exec vitest run tests/library-production.test.tsx`, and `pnpm --filter @el/web exec playwright test e2e/production.spec.ts`; expect red.
- [ ] **Step 2 — Green:** Build Recall Practice on existing Recall card primitives, route both answers through current practice API, and acquire one production question only when enabled. Rerun the Red commands; expect PASS.

### Task 9: Pure Read and versioned Prompt/Eval

**Files:** Rename/modify `apps/api/prompts/generate_read.v1.md` → `generate_read.v2.md`; modify `packages/shared/src/schemas/{ai/index,api/read}.ts`, `apps/api/src/modules/read/{service,routes}.ts`, `apps/web/src/features/read/components/{ArticleView,ReadCheckItem}.tsx`, `apps/api/tests/ai/eval/{fixtures/generate_read.sample.json,baselines/generate_read.json}`; test `apps/api/tests/integration/{read,read-detail}.test.ts`, `apps/web/tests/{read-article,read-history}.test.tsx`, `apps/web/e2e/read.spec.ts`.

**Interfaces:** `GenerateReadResult` is a strict Zod object with title/type/body/coverage and no `checks` (model output containing checks is rejected/retried); new articles store `checksJson='[]'`; `ReadArticleView.checks` allows `[]` for old/new serialization. `POST /api/read/:id/check` returns 409 after cutover (keep route for stale clients). Old stored answered checks remain visible read-only, old unanswered checks have no submit action. No Read path sets `needsReinforcement`.

- [ ] **Step 1 — Red:** Schema/API tests reject generated checks, accept new article without checks, preserve old article/check history read-only, reject old/new check submissions without flag/Stage writes. Web/E2E tests show pure article and legacy read-only results. Run `pnpm --filter @el/api exec vitest run tests/integration/read.test.ts tests/integration/read-detail.test.ts`, `pnpm --filter @el/web exec vitest run tests/read-article.test.tsx tests/read-history.test.tsx`, and `pnpm --filter @el/web exec playwright test e2e/read.spec.ts`; expect red.
- [ ] **Step 2 — Green:** Change Schema/service/UI and Prompt copy, bump frontmatter to version 2 and filename to `.v2.md`; update `AI_RULES.md` if task contract changed (it did). Rerun the Red commands; expect PASS.
- [ ] **Step 3 — Eval:** Run `pnpm ai:eval -- --task generate_read --provider glm` on fixed fixtures; compare old/new changed cases, correct regressions, then save baseline only for the reviewed version. Record case count, changes and trade-offs in Phase 9. If no real model credential, do not claim Prompt complete or release-ready.

### Task 10: Whole-flow acceptance and Phase 9 archive

**Files:** Update `apps/api/scripts/e2e-server.ts` seeds, affected old cloze/Read fixtures and tests, `docs/phases/phase-9-foxi-v2.md`, `docs/PHASES.md`; no unrelated files.

- [ ] **Step 1 — E2E:** Seed word/chunk/overrides, old cloze inventory, a legacy Read article and a large due queue. Add Playwright journeys for Learn→next-day Production, selective Library Practice, no-new-cloze Today, goal toggle cancel, pending/retry, pure Read, and narrow mobile/PWA keyboard. Run `pnpm e2e`; expect PASS.
- [ ] **Step 2 — Regression:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` and `pnpm ai:eval -- --task generate_read --provider glm`; all must exit 0. Check `pnpm format:check` and `git diff --check`. Investigate failures; do not mask them with deleted tests.
- [ ] **Step 3 — Release audit:** Check migration on a copy of a pre-V2 database, backup export/restore both versions, and local-day-boundary/stale-tab behavior. Record actual decisions, Eval summary, test counts and remaining risks; only then mark Phase 9 `done` and update `docs/PHASES.md`. Leave commits/push/deploy to explicit user direction.

## Self-review / handoff

The tasks cover every spec section: goal model (1–2), import/backup (3), migration (4), routing (5), Today generation/scoring/UI (6–7), Library Practice (8), Read/Prompt (9), and release verification (10). The cutover is one coordinated release, so splitting these into independently deployed plans would expose mixed V1/V2 contracts. Another agent should read the spec and this plan, then implement in task order; the plan author stops here.
