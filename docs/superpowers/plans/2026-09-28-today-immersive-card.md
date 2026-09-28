# Today Immersive Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-screen Today cards, direct “不会”, question-specific correction, result progress, item-based history, and precise latest-answer undo.

**Architecture:** Today service remains the sole owner of formal grading and rollback. Extend shared Zod/API contracts, derive history from the existing session-tasks endpoint, and give Today a viewport-filling card with a bottom action dock. Library Practice keeps its present semantics.

**Tech Stack:** React + Vite + TypeScript, Tailwind + shadcn/ui, TanStack Query, Fastify, Drizzle + SQLite, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-today-immersive-card-design.md`; product contract: `docs/PRODUCT_DESIGN.md` §§5.1, 6.5, 7.6.

## Global Constraints

- Before code, read the seven required project docs and `docs/phases/phase-8-today-card-flow.md`; follow `docs/DEVELOPMENT.md` Red → Green → Refactor.
- No new Practice page, AI task, Prompt edit, or DB column. Correct answers come from bound question payload after settlement; `TodayTaskView` never contains them.
- Never bypass review service stage changes. Ordinary undo is distinct from bad-question and does not change question status.
- Use existing UI tokens/components; add a warning token in `apps/web/src/styles/globals.css` before yellow. Do not change Library Practice behavior.
- Do not commit/push without explicit user confirmation (`AGENTS.md`). The receiving agent implements; plan author stops here.

## File map and interfaces

| Unit | Files | Responsibility |
| --- | --- | --- |
| Shared contract | `packages/shared/src/schemas/api/today.ts`, `packages/shared/src/schemas/review.ts` | Give-up request, reveal/replay fields, `undoableTaskId`, undo response, `gave_up` feedback value. |
| Server Today | `apps/api/src/modules/today/{routes,service}.ts` | Give-up settlement, replay, latest attempt, atomic rollback and replacement. |
| Question pool | `apps/api/src/modules/questions/service.ts` | Honor `excludeQuestionIds` in acquisition. |
| History preservation | `apps/api/src/modules/learning-items/service.ts` | Recover replaced Personal Example/pruned production history on undo. |
| Today UI | `apps/web/src/features/today/TodayPage.tsx`, `api.ts`, `components/*` | Card, correction, progress, history and undo. |
| Shared question UI | `apps/web/src/components/{choice-question-card,cloze-question-card,production-question-card}.tsx` | Optional Today-only dock; Practice defaults unchanged. |
| Styling | `apps/web/src/styles/globals.css`, `apps/web/src/app/shell.tsx` | Warning token and Today-only viewport sizing. |

Contract: `AnswerRequest.giveUp?: true` excludes `selectedOptionId`, `answerText`, `recall`, `hintUsed`; `AnswerResponse` adds `gaveUp: boolean`, `selectedOptionId: string | null`, `submittedAnswerText: string | null`, `referenceAnswer: string | null`, `answerNote: string | null`. `TodaySessionTasksResponse` adds `undoableTaskId: string | null`; `POST /api/today/tasks/:id/undo` returns `{ ok: true, progress: TodayProgress }`. First settlement and replay return the same reveal fields. Persist `attempt.feedback='gave_up'`; `TaskFeedbackRequest` remains `guessed|too_easy`.

## Review Focus

- Unsubmitted tasks must not leak answers (Task 1 API test).
- Two devices answering/undoing must not double-settle or roll back a non-latest answer (Task 2 integration test).
- Undo of reinforcement/read-reinforcement must preserve the original quota slot/read flag (Task 2 tests).
- Undo of Learn must restore queue, both dimensions, quota and session completion (Task 2 test).
- Short mobile viewport plus keyboard must keep input and primary action reachable (Task 3 E2E).

---

### Task 1: Direct give-up and exact reveal

**Files:** Modify `packages/shared/src/schemas/api/today.ts`, `packages/shared/src/schemas/review.ts`, `apps/api/src/modules/today/service.ts`; test `apps/api/tests/integration/today.test.ts`, `apps/api/tests/unit/today-answer.test.ts`.

**Interfaces:** `AnswerRequest.giveUp?: true`; response fields above; `replayAnswer(exec, task)` reconstructs every field from attempt/question.

- [ ] **Red — API tests:** Add named cases `give up reveals correct choice and reason`, `give up reveals complete cloze and accepted answer`, `give up reveals production reference without AI grading`, `unsubmitted task hides answers`, `replay preserves give-up and submitted answer`. Assert fail/correct=false, per-type reveal, zero production evaluator calls and equal replay fields.
- [ ] **Red — validation:** Reject give-up combined with option/text/recall/hint; reject missing answer without give-up. Run `pnpm --filter @el/api exec vitest run tests/integration/today.test.ts`; expect new tests to fail.
- [ ] **Green — service/schema:** Add Zod mutual exclusion and service validation; bypass evaluation only on give-up, then use existing fail settlement, Learn, reinforcement and stats rules. Choice reveals correct option/explanation; cloze reveals complete sentence/accepted answer/explanation; production uses bound payload `referenceAnswer`/`acceptanceNotes`, no fabricated diff. Genuine answers return submitted option/text, give-up returns null.
- [ ] **Green — replay:** Update `replayAnswer` and session task serialization; keep `TodayTaskView` answer-free. Run the same integration test plus `pnpm --filter @el/api exec vitest run tests/unit/today-answer.test.ts`; expect PASS.

### Task 2: Atomic latest-answer undo and replacement

**Files:** Modify `apps/api/src/modules/today/{routes,service}.ts`, `apps/api/src/modules/questions/service.ts`, `apps/api/src/modules/learning-items/service.ts`, `packages/shared/src/schemas/api/today.ts`; test `apps/api/tests/integration/today.test.ts`, `apps/api/tests/unit/today-later-bad-feedback.test.ts`, and a focused questions-acquisition test under `apps/api/tests/unit/`.

**Interfaces:** `undoTodayTask(db, deps, timezone, now, taskId): Promise<UndoResponse>`; `POST /api/today/tasks/:id/undo`; `TodaySessionTasksResponse.undoableTaskId`; `acquireQuestion(db, itemId, type, now, excludeQuestionIds?: string[])`. Extend `StateSnapshot` in Today service with optional `replacedPersonalExample` and `prunedProductionAttempts` row snapshots; extend `PersonalExampleSaveResult` with `replacedExampleSnapshot`, and make `trimProductionHistory` return the rows it deletes. Serialize those rows into the current attempt's `postStateJson` after trimming; keep earlier snapshot readers backward-compatible. Select the latest non-void Today attempt in today's session by SQLite `attempts.rowid DESC` (not task sort key, UUID or millisecond timestamp).

- [ ] **Red — target/race:** Tests `undo targets latest answer across tasks`, `stale task ID returns 409 without mutation`, `parallel undo only settles once`, `answer cannot replay canceled task`, `completed session reopens`, `different calendar day rejects undo`. A repeat undo must not void an older answer accidentally. Run targeted Vitest; expect red.
- [ ] **Red — rollback:** Cover pass/basic/fail, Learn, production pass/fail/give-up, `daily_stats.formal/new_items_started/production_attempts/production_pass`, both review dimensions, mastery, Read flag, inserted reinforcement, and reinforcement quota. Replacement must match item/type/dimension/origin but have a different question ID; old question status stays unchanged. No alternative question → retryable error, original answer/session unchanged.
- [ ] **Red — retained data:** Undo of production replacing an unpinned Personal Example restores the exact displaced row; undo of newly added example removes it. If the new example was pinned/edited since answer, return 409 rather than destroy user changes. At the 10-record production-history boundary, restore any pruned row. Run targeted Vitest; expect red.
- [ ] **Green — acquisition:** Honor `excludeQuestionIds` on inventory and post-generation acquisition; test distinct ID in both cases. Failed prefetch never starts rollback.
- [ ] **Green — transaction:** Prefetch different question, then transactionally recheck session date, exact latest attempt, task completion, dependent-data safety and replacement. Restore pre snapshot, cancel only recorded reinforcement IDs, reverse all stats/quotas, restore displaced example/history, void attempt, cancel old task, insert replacement at queue tail, clear `completed_at`. Replacement inherits original `taskType`, `dimension`, `origin`; cancellation frees a reinforcement slot, its replacement occupies that same slot, so no extra slot is charged. `read_reinforcement` remains so later completion clears its flag. Do not call bad-question or change question status. Factor rollback primitives used by bad-question only if they preserve its distinct status/eligibility rules.
- [ ] **Green — replay/summary:** `getSessionTasks` returns `undoableTaskId` for the valid latest answer only; `progressOf`/summary ignore canceled tasks and void attempts. Run targeted integration, bad-feedback and question-acquisition Vitest; expect PASS.

### Task 3: Immersive card and unified correction

**Files:** Modify `apps/web/src/features/today/components/{ActiveSession,TaskCard,RecallCard,ChoiceQuestionView,ClozeQuestionView,ProductionQuestionView}.tsx`, shared question cards under `apps/web/src/components/`, `apps/web/src/features/today/TodayPage.tsx`, `apps/web/src/app/shell.tsx`, `apps/web/src/styles/globals.css`; test existing `apps/web/tests/today-{active,choice,cloze,production,recall}.test.tsx`, `apps/web/tests/library-production.test.tsx`, `apps/web/e2e/today.spec.ts`.

**Interfaces:** Today-only layout props/slots for shared question cards, defaulting to current Practice layout. `useAnswer` submits `{ giveUp: true }`. Card has scrollable prompt/feedback and bottom dock for options or input/buttons. Give-up/wrong answer stays for manual next; Recall self-recall pass retains auto-advance.

- [ ] **Red — feedback tests:** Direct give-up per type; choice wrong/give-up both mark correct option and show reason, but give-up marks no fictitious wrong option. Cloze shows complete sentence/accepted form; production give-up shows reference/usage without diff, actual wrong answer retains diff. Hint-correct proceeds as `basic_pass` without “其实是蒙的”. Run relevant web Vitest; expect red.
- [ ] **Red — layout/regression:** Verify bottom dock and reachable input/action on short/keyboard viewport, AppShell nav outside card, and unchanged Library Practice shared-card behavior. Add mobile Playwright coverage; confirm red.
- [ ] **Green — layout:** Today route uses available `dvh` between fixed header/nav including iOS safe area; remove inherited `pb-40` for active Today only. Prompt/feedback uses `min-h-0 overflow-y-auto`; dock uses bounded independent scrolling if options are long. Desktop remains readable max-width.
- [ ] **Green — feedback:** Reuse per-type correction layout for wrong/give-up; remove Today-only “其实是蒙的”, keep `too_easy` only for genuinely correct answers if still applicable. Never show answer before result. Run targeted web Vitest and Playwright; expect PASS.

### Task 4: Result progress and item-based “今日学习”

**Files:** Modify `apps/web/src/features/today/components/{ActiveSession,CompletedToday}.tsx`, optionally create `apps/web/src/features/today/components/TodayLearningSheet.tsx`, modify `apps/web/src/styles/globals.css`; test `apps/web/tests/{today-navigation,today-completed}.test.tsx`, `apps/web/e2e/today.spec.ts`.

**Interfaces:** Use `GET /api/today/tasks` in active/completed UI. Exclude canceled tasks from denominator; derive pass/basicPass/fail/pending from non-canceled entries. Group record rows by `task.item.id`; completed result rows are read-only, with original question, submitted answer, correct answer and explanation.

- [ ] **Red — progress:** Assert green pass, yellow basic pass, red fail, gray pending and numeric/text counts; reinforcement changes total; canceled attempts leave counts. Progress click opens sheet without changing current task. Run `pnpm --filter @el/web exec vitest run tests/today-navigation.test.tsx`; expect red.
- [ ] **Red — history:** Repeated item appears once with multiple result rows; each row shows selected option/text or “不会”, correct answer and explanation; pending/canceled records are not navigable. Bad-question remains on a specific completed record; a server 409 for an older record explains why it cannot be invalidated. Completed page uses same grouping. Run targeted tests; expect red.
- [ ] **Green — UI:** Add warning token for basic_pass; use existing success/destructive/muted tokens for others. Replace order-based “回看” navigation and completed-page “今日回顾” with grouped sheet. Run targeted tests and Playwright; expect PASS.

### Task 5: Single-icon latest-answer undo

**Files:** Modify `apps/web/src/features/today/{api.ts,TodayPage.tsx}`, `apps/web/src/features/today/components/{ActiveSession,TaskCard,CompletedToday}.tsx`; optionally create a Today-local confirmation component; test `apps/web/tests/{today-active,today-completed}.test.tsx`, `apps/web/e2e/today.spec.ts`.

**Interfaces:** `useUndoAnswer()` calls undo route and invalidates Today queries; clear frozen result on success. One icon with `aria-label="撤销最近一次作答"` at card top right and completed page, sourced from server `undoableTaskId`. Confirmation identifies target, task type, result. On 409 refresh and explain newer answer exists.

- [ ] **Red — UI:** Current feedback targets current answer; after advance targets previous latest; after another answer targets newer one; completed page still offers icon; no answer hides icon. Cancel makes no request; confirm sends one; successful undo returns to live queue; stale 409 does not clear another device's answer. Run targeted Vitest; expect red.
- [ ] **Green — hook/icon:** Implement mutation and accessible confirmation. Keep distinct from bad-question; do not reopen revealed question. On success clear frozen/cursor and refetch before showing replacement. Run targeted Vitest and Playwright; expect PASS.

### Task 6: Full verification and phase archive

**Files:** Modify `docs/phases/phase-8-today-card-flow.md`, `docs/PHASES.md` only after implementation/verification.

- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`; all four must exit 0. No Prompt change means no `pnpm ai:eval`.
- [ ] Inspect narrow/wide mobile and desktop Today plus Library Practice regression; resolve failures rather than assuming success.
- [ ] Update Phase 8 decisions/change log with actual behavior and checks; mark `done` only when all criteria pass. Leave changes uncommitted/unpushed unless user explicitly confirms.
