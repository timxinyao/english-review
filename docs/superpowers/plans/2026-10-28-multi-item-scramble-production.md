# Multi-item Scramble Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-typing Production with multi-item chip scramble (2–3 learning items per task, per-item FSRS writeback, one soft-cap slot), including a clean cutover that deletes old production questions/attempts and resets Production review states.

**Architecture:** Shared Zod contracts (`scramble_v1` payload + Today/Practice views + answer tokens + per-item results) first. Drizzle adds `review_task_items`, `question_items`, `attempt_item_results`. Today enqueue greedily groups due Production items; generation uses new prompts `generate_production_scramble` / optional `check_production_scramble`. Grading is **rule-first** (token normalize + target subsequence match); AI judge only for ambiguous edges. Web replaces `ProductionQuestionCard` typing UI with chip assemble. Boot runs idempotent `production_scramble_v1` cutover.

**Tech Stack:** Zod, Drizzle+SQLite, Fastify, React+Vite, Vitest, Playwright, pnpm monorepo, existing Prompt Registry.

**Spec:** `docs/superpowers/specs/2026-10-28-multi-item-scramble-production-design.md` (product-approved 2026-10-28).

## Global Constraints

- No free-typing Production UI; no cloze restoration; no speech/STT/gamification; no manual user grouping (spec §2.2).
- Soft-cap / 今日计划: **1 scramble task = 1 slot** even when bundling 2–3 items (spec §8).
- FSRS Production advances **per learning_item** from item_results, not from task-level one-shot (spec §6.2). AI must never return Stage / next_review_at (AGENTS §5).
- Chunk targets split into word-level chips; distractors ≈ 30%–50% of reference token count; reference sentence ≤16 tokens preferred (spec §5, §9).
- Cutover marker `app_metadata.production_scramble_v1`; destructive delete of old production/cloze questions+attempts; reset all Production `review_states`; keep Understanding/Learn/Read/Personal Examples (spec §7).
- Word default Production remains **off**; Chunk default **on**; `production_enabled_override` still wins (spec §3.4).
- First version: item results only `pass` | `fail` (no `basic_pass`); no auto Personal Example from scramble (spec §4.3.6, §9).
- Do not edit `.claude/skills/import-english/SKILL.md`. No secrets in docs. Commit author `timxinyao <timxinyao@users.noreply.github.com>`.
- Test memory: API unit tests serial; Playwright `E2E_API_PORT=5175 ... --workers=1` per DEVELOPMENT.md.
- Deploy only after Tasks 1–10 green + docs Task 11; coordinator scaffolding run must not deploy.

## File Map

| Unit | Path | Responsibility |
| --- | --- | --- |
| Shared scramble contracts | `packages/shared/src/schemas/question.ts`, `schemas/api/today.ts`, `schemas/api/practice.ts`, `schemas/ai/index.ts` | `ScramblePayload`, views, answer tokens, AI generate/check results, catalog entries |
| DB schema | `apps/api/src/db/schema.ts`, `apps/api/drizzle/0010_*.sql` | `review_task_items`, `question_items`, `attempt_item_results` |
| Cutover | `apps/api/src/modules/review/scramble-cutover.ts` (new), wire in `apps/api/src/index.ts` | Idempotent delete + P reset |
| Grouping | `apps/api/src/modules/today/scramble-group.ts` (new) | Pure: due items → groups of 1–3 |
| Rule judge | `apps/api/src/modules/questions/scramble-judge.ts` (new) | Normalize tokens; sentence match; per-target pass/fail |
| Questions service | `apps/api/src/modules/questions/service.ts` | Generate scramble; stop free-typing payload |
| Prompts | `apps/api/prompts/generate_production_scramble.v1.md`, `check_production_scramble.v1.md` | New keys; retire old after cutover |
| Today service | `apps/api/src/modules/today/service.ts` | Enqueue groups; scramble view; per-item writeback; undo/bad |
| Practice | `apps/api/src/modules/practice/service.ts` | Prefer single-item scramble |
| Web card | `apps/web/src/components/scramble-question-card.tsx` (new) | Chip pick/reorder UI |
| Today/Library wire | `ProductionQuestionView.tsx`, `PracticeView.tsx`, `TaskCard.tsx` | Submit `selectedTokens` |
| Tests | Per-task unit/integration + `apps/web/tests/scramble-*.test.tsx` + `e2e/production.spec.ts` | TDD |
| Docs | `docs/PHASES.md`, `docs/phases/phase-13-*.md`, PRODUCT/TECHNICAL/DATABASE/AI_RULES | After code |

**Cross-task interfaces (lock early):**

```ts
// packages/shared — payload in questions.payload_json
export const ScrambleTarget = z.object({
  learningItemId: z.string().min(1),
  surface: z.string().min(1),
  tokens: z.array(z.string().min(1)).min(1),
});
export const ScramblePayload = z.object({
  schema: z.literal('scramble_v1'),
  targets: z.array(ScrambleTarget).min(1).max(3),
  zhPrompt: z.string().min(1),
  referenceTokens: z.array(z.string().min(1)).min(1).max(24),
  distractors: z.array(z.string().min(1)),
  acceptableMorphology: z.array(z.string().min(1)).default([]),
  acceptanceNotes: z.string().default(''),
});

// Client-safe question view (NO referenceTokens)
export const ScrambleQuestionView = z.object({
  questionId: z.string(),
  kind: z.literal('scramble'),
  zhPrompt: z.string(),
  targets: z.array(z.object({ learningItemId: z.string(), surface: z.string() })).min(1).max(3),
  chips: z.array(z.string().min(1)).min(2),
});

// AnswerRequest adds selectedTokens?: string[] (giveUp mutual exclusion includes it)
// AnswerResponse adds:
//   itemResults: { learningItemId, surface, result: 'pass'|'fail' }[] | null
//   referenceTokens: string[] | null  // reveal only after submit / giveUp
```

```ts
// apps/api scramble-judge.ts
export function normalizeToken(t: string): string;
export function judgeScramble(input: {
  selectedTokens: string[];
  referenceTokens: string[];
  targets: { learningItemId: string; tokens: string[] }[];
  acceptableMorphology: string[];
}): {
  taskResult: 'pass' | 'fail';
  itemResults: { learningItemId: string; result: 'pass' | 'fail' }[];
};

// apps/api scramble-group.ts
export function groupProductionItems<T extends { id: string }>(
  dueAsc: T[],
  opts?: { min?: number; max?: number },
): T[][];
```

---

### Task 1: Shared Zod — scramble payload, Today/Practice views, answer contract

**Files:**
- Modify: `packages/shared/src/schemas/question.ts`
- Modify: `packages/shared/src/schemas/api/today.ts`
- Modify: `packages/shared/src/schemas/api/practice.ts`
- Modify: `packages/shared/src/schemas/ai/index.ts`
- Create test: `packages/shared/src/schemas/scramble.test.ts`

**Interfaces:** Produces `ScramblePayload`, `ScrambleQuestionView` (as `ProductionQuestionView`), extended `AnswerRequest`/`AnswerResponse`, AI generate/check scramble schemas + catalog entries.

- [ ] **Step 1: Write failing shared tests**

```ts
import { describe, expect, it } from 'vitest';
import { AnswerRequest, ScramblePayload } from '../index.js';

describe('ScramblePayload', () => {
  it('accepts scramble_v1 fixture', () => {
    const parsed = ScramblePayload.parse({
      schema: 'scramble_v1',
      targets: [{ learningItemId: 'a', surface: 'wear down', tokens: ['wear', 'down'] }],
      zhPrompt: '长期开会让我很累。',
      referenceTokens: ['Long', 'meetings', 'really', 'wear', 'me', 'down'],
      distractors: ['out', 'tire'],
      acceptableMorphology: ['wear', 'wears'],
      acceptanceNotes: '',
    });
    expect(parsed.targets[0].tokens).toEqual(['wear', 'down']);
  });

  it('rejects free-typing-shaped object as scramble', () => {
    expect(() =>
      ScramblePayload.parse({ schema: 'scramble_v1', mustUse: 'x', referenceAnswer: 'y' }),
    ).toThrow();
  });
});

describe('AnswerRequest selectedTokens', () => {
  it('accepts selectedTokens alone', () => {
    expect(AnswerRequest.parse({ selectedTokens: ['Long', 'meetings'] }).selectedTokens).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test — expect fail**

Run: `pnpm --filter @el/shared test`  
Expected: FAIL (missing exports / fields).

- [ ] **Step 3: Implement schemas**

In `question.ts` add `ScrambleTarget` + `ScramblePayload`.

In `today.ts` replace free-typing `ProductionQuestionView` with scramble-only:

```ts
export const ProductionQuestionView = z.object({
  questionId: z.string(),
  kind: z.literal('scramble'),
  zhPrompt: z.string(),
  targets: z
    .array(z.object({ learningItemId: z.string(), surface: z.string() }))
    .min(1)
    .max(3),
  chips: z.array(z.string().min(1)).min(2),
});
```

Extend `AnswerRequest` with `selectedTokens: z.array(z.string().min(1)).min(1).max(32).optional()` and include it in giveUp mutual exclusion.

Extend `AnswerResponse` with:

```ts
itemResults: z
  .array(
    z.object({
      learningItemId: z.string(),
      surface: z.string(),
      result: z.enum(['pass', 'fail']),
    }),
  )
  .nullable(),
referenceTokens: z.array(z.string()).nullable(),
```

Update Practice production branch to the same scramble shape (`qtype: 'production'` + scramble fields, or nested `kind: 'scramble'`).

In `schemas/ai/index.ts` add:

```ts
export const GenerateProductionScrambleResult = z.object({
  zh_prompt: z.string().min(1),
  reference_tokens: z.array(z.string().min(1)).min(1).max(24),
  distractors: z.array(z.string().min(1)),
  acceptable_morphology: z.array(z.string().min(1)),
  acceptance_notes: z.string(),
  target_surfaces: z.array(z.string().min(1)).min(1).max(3),
});
export const CheckProductionScrambleResult = z.object({
  explanation: z.string(),
  item_overrides: z
    .array(z.object({ learning_item_id: z.string(), result: z.enum(['pass', 'fail']) }))
    .optional(),
});
// AI_TASKS += generateProductionScramble, checkProductionScramble
```

Keep old `GenerateProductionPromptResult` / `CheckProductionResult` until Task 8 removes prompts (Registry still needs them until deleted).

- [ ] **Step 4: Re-run shared tests — pass**

Run: `pnpm --filter @el/shared test && pnpm --filter @el/shared typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git -c user.name=timxinyao -c user.email=timxinyao@users.noreply.github.com commit -m "feat(shared): scramble_v1 Zod contracts for multi-item production"
```

---

### Task 2: DB tables + Drizzle migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0010_scramble_production.sql` (confirm next id after `0009_*`)
- Test: extend migrate smoke or add `apps/api/tests/unit/scramble-schema.test.ts`

**Interfaces:** Tables matching spec §4.3.1 / §4.3.3 / §4.3.4.

- [ ] **Step 1: Failing test** asserting tables exist after `runMigrations`.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Add tables in schema.ts + SQL migration**

```ts
export const reviewTaskItems = sqliteTable(
  'review_task_items',
  {
    id: text('id').primaryKey(),
    reviewTaskId: text('review_task_id')
      .notNull()
      .references(() => reviewTasks.id, { onDelete: 'cascade' }),
    learningItemId: text('learning_item_id')
      .notNull()
      .references(() => learningItems.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // primary | participant
    result: text('result'), // pass | fail | void | null
    sortIndex: integer('sort_index').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    uq: uniqueIndex('uq_review_task_items_task_item').on(t.reviewTaskId, t.learningItemId),
    itemIdx: index('idx_review_task_items_item').on(t.learningItemId),
  }),
);
// question_items(questionId, learningItemId, sortIndex, createdAt)
// attempt_item_results(attemptId, learningItemId, result, detailJson, createdAt)
```

Hand-write SQL in the same style as `0009_*.sql`, or use the repo’s drizzle-kit generate flow.

- [ ] **Step 4: Migrate smoke pass**

- [ ] **Step 5: Commit** `feat(api): add scramble multi-item link tables`

---

### Task 3: Pure scramble judge (TDD)

**Files:**
- Create: `apps/api/src/modules/questions/scramble-judge.ts`
- Create: `apps/api/tests/unit/scramble-judge.test.ts`

- [ ] **Step 1: Failing tests**

```ts
describe('judgeScramble', () => {
  const targets = [
    { learningItemId: 'd', tokens: ['wear', 'down'] },
    { learningItemId: 'a', tokens: ['meetings'] },
  ];
  const ref = ['Long', 'meetings', 'really', 'wear', 'me', 'down'];

  it('all targets pass when full sentence matches', () => {
    const out = judgeScramble({
      selectedTokens: ref,
      referenceTokens: ref,
      targets,
      acceptableMorphology: ['wear', 'wears'],
    });
    expect(out.taskResult).toBe('pass');
    expect(out.itemResults.every((r) => r.result === 'pass')).toBe(true);
  });

  it('marks only missing target fail', () => {
    const selected = ['Long', 'meetings', 'really', 'tire', 'me', 'out'];
    const out = judgeScramble({
      selectedTokens: selected,
      referenceTokens: ref,
      targets,
      acceptableMorphology: [],
    });
    expect(out.itemResults.find((r) => r.learningItemId === 'd')?.result).toBe('fail');
    expect(out.itemResults.find((r) => r.learningItemId === 'a')?.result).toBe('pass');
    expect(out.taskResult).toBe('fail');
  });

  it('accepts morphology wear/wears', () => {
    const selected = ['Long', 'meetings', 'really', 'wears', 'me', 'down'];
    const out = judgeScramble({
      selectedTokens: selected,
      referenceTokens: ref,
      targets,
      acceptableMorphology: ['wear', 'wears'],
    });
    expect(out.itemResults.find((r) => r.learningItemId === 'd')?.result).toBe('pass');
  });
});
```

**Rules (v1):**
1. `normalizeToken`: lowercase; strip trailing `.?!`,`; keep internal apostrophes.
2. Target **pass** iff its tokens appear as an ordered contiguous subsequence in selected tokens (after morphology expansion via `acceptableMorphology` + exact ignore-case).
3. `taskResult = pass` iff every target passes **and** selected length equals reference length **and** each position matches reference under morphology (strict — blocks lucky subsequences with junk chips).
4. Empty selected → all fail; task fail.

- [ ] **Step 2–4: fail → implement → pass**

- [ ] **Step 5: Commit** `feat(api): rule-based scramble judge with per-item results`

---

### Task 4: Grouping helper

**Files:**
- Create: `apps/api/src/modules/today/scramble-group.ts`
- Create: `apps/api/tests/unit/scramble-group.test.ts`

- [ ] **Step 1: Tests** — greedy pack max 3; remainder 1; empty → `[]`.

```ts
expect(
  groupProductionItems([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }], { max: 3 }),
).toEqual([[{ id: '1' }, { id: '2' }, { id: '3' }], [{ id: '4' }]]);
```

v1: **due-order greedy only** (no semantic co-occurrence). Spec heuristics deferred.

- [ ] **Step 2–5: implement + commit** `feat(api): greedy scramble production grouping`

---

### Task 5: Cutover `production_scramble_v1`

**Files:**
- Create: `apps/api/src/modules/review/scramble-cutover.ts`
- Modify: `apps/api/src/index.ts` boot (after migrations / existing cutovers)
- Create: `apps/api/tests/unit/scramble-cutover.test.ts`

**Single transaction, idempotent:**
1. Marker `production_scramble_v1` exists → `{ applied: false }`.
2. DELETE attempts tied to `questions.type in ('production','cloze')`.
3. DELETE those questions.
4. Cancel/delete incomplete `review_tasks` with `task_type='production'`.
5. RESET all Production `review_states` to inactive (mirror `v2-cutover.ts` field clears).
6. For active started items with `effectiveProductionEnabled`, activate Production due next local day via existing `initialProductionActivation`.
7. Insert marker UTC ISO.
8. Keep Personal Examples / Understanding / Learn / Read.

- [ ] **Step 1: Test** seed free-typing P question+attempt+P state → cutover removes them; U intact; second apply no-op.

- [ ] **Step 2–5: implement + wire + commit** `feat(api): production_scramble_v1 cutover`

---

### Task 6: Generate scramble prompt + questions service

**Files:**
- Create: `apps/api/prompts/generate_production_scramble.v1.md`
- Modify: `apps/api/src/modules/questions/service.ts`
- Modify: `apps/api/tests/unit/questions-production.test.ts`, `questions-generate.test.ts`
- Add eval fixture stubs under `apps/api/tests/ai/eval/fixtures/`

**Service sketch:**

```ts
export async function generateProductionScramble(
  db: AppDatabase,
  deps: QuestionDeps,
  items: Array<{ id: string; type: string; target: string; meaning: string }>,
): Promise<QuestionRow>;
```

- `completeStructured('generateProductionScramble', vars)` **outside** write txn.
- Validate: each target surface’s tokens appear contiguous in `reference_tokens`; distractors in ~30–50% of n; `reference_tokens.length <= 24`.
- Persist `ScramblePayload`; `learningItemId = primary`; write `question_items`.
- Stop generating `{ mustUse, referenceAnswer }` payloads.

- [ ] TDD with fake AI fixture → payload parses as `ScramblePayload`.

- [ ] Commit `feat(api): generate production scramble questions`

---

### Task 7: Today enqueue + answer + undo/bad multi-item writeback

**Files:**
- Modify: `apps/api/src/modules/today/service.ts` (production paths only)
- Modify: `today-production.test.ts`, `today-answer.test.ts`, `today-start.test.ts`, `today-session-tasks.test.ts`, integration `today.test.ts`

**Enqueue:** collect due P items → `groupProductionItems` within soft-cap (**1 group = 1 slot**) → one `review_tasks` + N `review_task_items` → bind scramble question.

**View:** `ScrambleQuestionView` with `chips = shuffle(reference ∪ distractors, seed=questionId)`; never send `referenceTokens` pre-answer.

**Answer:**
1. `selectedTokens` or giveUp.
2. `judgeScramble` for scores (v1 rules-only; optional AI explanation later).
3. Tx: `attempts` + `attempt_item_results`; update `review_task_items.result`; per-item Production FSRS; stats +1 task; reinforce fail items only (≤1 each, ≤2/item/session).
4. Response: `itemResults` + `referenceTokens` reveal.

**Undo/bad:** roll back **all** participants; void attempt + item_results; cancel reinforcements.

- [ ] Tests: 2-item one fail one pass; progress counts 1; undo restores both.

- [ ] Commit `feat(today): multi-item scramble enqueue and per-item writeback`

---

### Task 8: Practice path + retire free-typing prompts

**Files:**
- Create: `apps/api/prompts/check_production_scramble.v1.md` (only if AI explanation used)
- Modify: `apps/api/src/modules/practice/service.ts` — single-item scramble
- Remove `generate_production_prompt` / `check_production` from catalog + delete prompt files once no references remain (Registry boot must stay green)
- Update `production-contract.test.ts`, `promptRegistry.test.ts`

- [ ] Commit `feat(api): practice scramble + retire free-typing production prompts`

---

### Task 9: Web ScrambleQuestionCard + unit tests

**Files:**
- Create: `apps/web/src/components/scramble-question-card.tsx`
- Create: `apps/web/tests/scramble-question-card.test.tsx`
- Modify: `apps/web/src/components/question-answer.ts` — add `itemResults` / `referenceTokens` on result type
- Retire typing UI in `production-question-card.tsx` after wire (or delete in Task 10)

**UI:** zhPrompt; faint target surfaces; chip bank; tap to assemble / tap to remove; Submit; giveUp; result shows per-target marks + revealed reference.

- [ ] Test: click chips in order → `onSubmitTokens([...])`.

- [ ] Commit `feat(web): scramble chip assemble card`

---

### Task 10: Wire Today + Library + E2E

**Files:**
- Modify: `apps/web/src/features/today/components/ProductionQuestionView.tsx` — body `{ selectedTokens }`
- Modify: `TaskCard.tsx`, `PracticeView.tsx`
- Modify: `apps/web/tests/today-production.test.tsx`, `library-production.test.tsx`
- Modify: `apps/web/e2e/production.spec.ts`

- [ ] Commit `feat(web): wire scramble production into Today and Library practice`

---

### Task 11: Docs + Phase 13 + deploy checklist

**Files:**
- Create: `docs/phases/phase-13-scramble-production.md`
- Modify: `docs/PHASES.md`, `PRODUCT_DESIGN.md`, `TECHNICAL_DESIGN.md`, `DATABASE.md`, `AI_RULES.md`

**Deploy checklist (after Tasks 1–10 green):**
1. Merge `feat/scramble-production` → `main`.
2. Backup SQLite before boot cutover.
3. `pnpm install`; shared typecheck; api tests serial; web tests + build.
4. Restart API → migrations + `production_scramble_v1` once.
5. Smoke: health; login; Today Production is chips; submit; Library practice; Settings OK.
6. SQL: no free-typing production payloads; `review_task_items` present; U states intact.
7. Update phase leave-behind.

**Do not deploy in the coordinator scaffolding run that only writes this plan + shared/UI stubs.**

---

## API contract sketch (web)

| Endpoint | Change |
| --- | --- |
| `GET /api/today` `currentTask.question` | `{ kind:'scramble', questionId, zhPrompt, targets[], chips[] }` |
| `POST /api/today/tasks/:id/answer` | `{ selectedTokens: string[] }` or `{ giveUp: true }` |
| Answer response | + `itemResults` + `referenceTokens` (post-submit) |
| `GET /api/today/tasks` | same view; undoableTaskId unchanged |
| Library practice | scramble production; answer via `selectedTokens` |

---

## Parallelism (GLM teammate)

- **GLM backend:** Tasks 2–8 on `feat/scramble-production`.
- **Parallel OK:** Task 1 + Task 9 against fixtures; Task 10 waits on live `itemResults`.
- Avoid conflicting edits in `today/service.ts` without sync.

---

## Self-review

1. **Spec coverage:** §2.1→Tasks 3–10; schema A→2; generate §5→6; grade §6→3+7; cutover §7→5; soft-cap §8→7; success §11→10–11.
2. **Placeholders:** semantic grouping deferred explicitly (due-order greedy).
3. **Type consistency:** `scramble_v1`, `selectedTokens`, item `pass|fail` only.

## Execution

Plan path: `docs/superpowers/plans/2026-10-28-multi-item-scramble-production.md`.

Use **Subagent-Driven** (recommended) or continue GLM backend + parallel shared/web scaffolding.
