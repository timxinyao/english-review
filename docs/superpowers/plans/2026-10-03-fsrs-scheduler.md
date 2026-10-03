# FSRS 记忆调度算法 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 ts-fsrs（默认参数，目标记忆率 0.90）替换固定阶梯排期核心，attempts 全量回放幂等迁移，产品层（补强/撤销/稍后/New Queue/Read）不变。

**Architecture:** 新增纯函数 FSRS 引擎封装（`review/fsrs-engine.ts`）承担评分映射与 Card 演进；`review/service.ts` 的 `computeNextReviewState` 等核心换轨；schema 删 `level/stable` 加 `difficulty/stability/reps/lapses`；一次性幂等回放迁移（`app_metadata.fsrs`）+ 旧备份恢复后重建；序列化与前端标签同步。

**Tech Stack:** ts-fsrs（MIT，open-spaced-repetition 官方 TS）、Drizzle+SQLite、Fastify、Zod、Vitest、Playwright、pnpm monorepo。

**Spec:** `docs/superpowers/specs/2026-10-03-fsrs-scheduler-design.md`（已过审）。

## Global Constraints

- 目标记忆率 `request_retention: 0.90`；`maximum_interval: 365`；间隔下限 1 天（spec §1，实现处 clamp）。
- 评分映射（`ReviewOutcome` → Rating）：`fail→Again`、`basic_pass→Hard`、`pass→Good`、`pass+tooEasy→Easy`（U 的"简单"经 tooEasy 传入，P 无 Easy）。
- master 谓词：所需维度（U 恒需；P 仅有效造句目标）全部 `stability ≥ 120`；paused/archived 不自动变（spec §3）。
- `review_states` 列：删 `level`、`stable`；加 `difficulty REAL NULL`、`stability REAL NULL`（NULL=未激活）、**实现必要补充（spec §2 注记）**：`reps INTEGER NOT NULL DEFAULT 0`、`lapses INTEGER NOT NULL DEFAULT 0`（FSRS Card 跨重启重建需要）。`next/last_review_at`、streaks 保留并照常更新。
- 快照（today/service.ts 的 pre/post JSON）：删 `level/stable`，加 `difficulty/stability/reps/lapses` 可空字段；旧快照缺省保持现值。
- 回放规则：仅 `mode='today'` 且题目 kind=`understanding`（→U）/`production`（→P）的 attempts，按 `created_at` 升序；跳过 cloze、`read_check`、`library_practice`。幂等（二次运行 no-op），boot 顺序：迁移→Registry 校验→v2 cutover→fsrs 回放→listen。
- 备份 2.0：导出加 `difficulty/stability/reps/lapses` 可空；恢复旧格式（只有 level/stable）→ 落库后用恢复的 attempts 跑回放重建，无 attempts 的行保持未激活。
- 阶段标签按 stability 分档：null=未开始、<7 新、<30 巩固、<120 熟练、≥120 掌握。
- 删除 `INTERVALS_DAYS`、`LEVEL_MIN/LEVEL_MAX`、`TOO_EASY_EXTRA_LEVELS`、`BASIC_PASS_INTERVAL_FACTOR`、`FAIL_INTERVAL_FACTOR`、`MIN_INTERVAL_DAYS` 的阶梯语义（shared constants 清理，调用方同步）。
- 测试命令串行（1.9G 内存）；Playwright `E2E_API_PORT=5175 ... --workers=1`。
- 每 Task 完成即 commit（HAPI 尾注；绝不动 `.claude/skills/import-english/SKILL.md`）；部署只在 Task 4 末尾一次。

## File Map / Interfaces

| 单元 | 文件 | 职责 |
| --- | --- | --- |
| FSRS 引擎 | `apps/api/src/modules/review/fsrs-engine.ts`（新） | 参数、ratingOf、Card 演进/重建、回放纯函数 |
| 状态机 | `apps/api/src/modules/review/service.ts`、`goals.ts` | FSRS 化的 compute/initial/advance/reconcile、S≥120 mastered |
| 契约 | `packages/shared/src/constants/review.ts`、`schemas/learning-item.ts`、`schemas/import-export.ts`、`schemas/api/*` | 删阶梯常量、阶段分档、DTO 字段 |
| DB | `apps/api/src/db/schema.ts`、`drizzle/0007_*.sql`（生成） | 列变更 |
| 消费方 | `apps/api/src/modules/today/service.ts`、`learning-items/service.ts`、`import-export/service.ts`、`apps/web/src/features/library/LibraryDetailPage.tsx` | 快照/序列化/learn 结算/标签 |
| 迁移 | `apps/api/src/modules/review/fsrs-cutover.ts`（新）、`apps/api/src/index.ts` | marker + 回放 + boot 接线 |
| 测试 | review-state-machine / fsrs-engine / fsrs-cutover / migrate-smoke / backup-restore / today / library 等 | 全量重写受影响用例 |

**Interfaces（跨任务）:**
- Task 1 产出：`ratingOf(outcome: ReviewOutcome): Rating`；`newCard(now: Date): Card`；`advanceCard(prev: Card, now: Date, rating: Rating): Card`（含 1..365 天 clamp）；`cardFromSnapshot(s: {difficulty; stability; reps; lapses; nextReviewAt; lastReviewAt}, now: Date): Card`；`replayRatings(entries: {at: Date; rating: Rating}[]): Card`。
- Task 2 产出的 `ReviewStateSnapshot` 形状（Task 3/4 依赖）：
```ts
export interface ReviewStateSnapshot {
  difficulty: number | null;
  stability: number | null;
  reps: number;
  lapses: number;
  nextReviewAt: string | null;
  lastReviewAt: string | null;
  correctStreak: number;
  wrongStreak: number;
}
```

---

### Task 1: ts-fsrs 依赖与 FSRS 引擎封装

**Files:**
- Create: `apps/api/src/modules/review/fsrs-engine.ts`
- Create test: `apps/api/tests/unit/fsrs-engine.test.ts`
- Modify: `apps/api/package.json`（依赖）

**Interfaces:** Produces 见上。

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @el/api add ts-fsrs`
Expected: 安装成功（锁定当前稳定版），`apps/api/package.json` 出现 `ts-fsrs`。

- [ ] **Step 2: 写失败测试**

创建 `apps/api/tests/unit/fsrs-engine.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { Rating } from 'ts-fsrs';
import {
  advanceCard,
  cardFromSnapshot,
  newCard,
  ratingOf,
  replayRatings,
  type FsrStateFields,
} from '../../src/modules/review/fsrs-engine.js';

const T0 = new Date('2026-10-03T00:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe('ratingOf（ReviewOutcome → FSRS Rating）', () => {
  it('fail→Again / basic_pass→Hard / pass→Good / pass+tooEasy→Easy', () => {
    expect(ratingOf({ kind: 'fail' })).toBe(Rating.Again);
    expect(ratingOf({ kind: 'basic_pass' })).toBe(Rating.Hard);
    expect(ratingOf({ kind: 'pass' })).toBe(Rating.Good);
    expect(ratingOf({ kind: 'pass', tooEasy: true })).toBe(Rating.Easy);
  });
});

describe('advanceCard（含 1..365 天 clamp）', () => {
  it('Good：间隔 ≥1 天；Easy > Good；Again 最短且下限 1 天', () => {
    const c0 = newCard(T0);
    const good = advanceCard(c0, T0, Rating.Good);
    const easy = advanceCard(c0, T0, Rating.Easy);
    const again = advanceCard(c0, T0, Rating.Again);
    const d = (c: ReturnType<typeof newCard>) => (c.due.getTime() - T0.getTime()) / DAY;
    expect(d(good)).toBeGreaterThanOrEqual(1);
    expect(d(easy)).toBeGreaterThan(d(good));
    expect(d(again)).toBeLessThan(d(good));
    expect(d(again)).toBeGreaterThanOrEqual(1);
  });

  it('连续 Good：due 单调向前且 stability 单调不减', () => {
    let card = newCard(T0);
    let prevDue = T0.getTime();
    for (let i = 1; i <= 8; i++) {
      card = advanceCard(card, at(i * 30), Rating.Good);
      expect(card.due.getTime()).toBeGreaterThan(prevDue);
      prevDue = card.due.getTime();
    }
    expect(card.stability).toBeGreaterThan(newCard(T0).stability);
  });
});

describe('cardFromSnapshot / replayRatings', () => {
  it('快照字段重建 Card 后再演进，与连续演进结果一致（同间隔同评分）', () => {
    const c1 = advanceCard(newCard(T0), T0, Rating.Good);
    const fields: FsrStateFields = {
      difficulty: c1.difficulty,
      stability: c1.stability,
      reps: c1.reps,
      lapses: c1.lapses,
      nextReviewAt: c1.due.toISOString(),
      lastReviewAt: T0.toISOString(),
    };
    const rebuilt = cardFromSnapshot(fields, at(7));
    const a = advanceCard(rebuilt, at(7), Rating.Good);

    let direct = c1;
    direct = advanceCard(direct, at(7), Rating.Good);
    expect(a.stability).toBeCloseTo(direct.stability, 6);
    expect(a.due.toISOString()).toBe(direct.due.toISOString());
  });

  it('replayRatings 按时间序回放；空序列=New 状态', () => {
    const card = replayRatings([
      { at: T0, rating: Rating.Good },
      { at: at(3), rating: Rating.Good },
      { at: at(10), rating: Rating.Again },
      { at: at(11), rating: Rating.Good },
    ]);
    expect(card.reps).toBe(4);
    expect(card.lapses).toBe(1);
    expect(replayRatings([]).reps).toBe(0);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @el/api exec vitest run tests/unit/fsrs-engine.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现 fsrs-engine.ts**

```ts
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
} from 'ts-fsrs';
import type { ReviewOutcome } from './service.js';

export const MS_PER_DAY = 86_400_000;
export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 365;

/** spec 2026-10-03：默认权重 + 目标记忆率 0.90 + 上限 365 天 */
const SCHEDULER = fsrs(
  generatorParameters({ request_retention: 0.9, maximum_interval: MAX_INTERVAL_DAYS }),
);

export function ratingOf(outcome: ReviewOutcome): Rating {
  if (outcome.kind === 'fail') return Rating.Again;
  if (outcome.kind === 'basic_pass') return Rating.Hard;
  return outcome.tooEasy === true ? Rating.Easy : Rating.Good;
}

export function newCard(now: Date): Card {
  return createEmptyCard(now);
}

/** 单次演进；due 按 1..365 天 clamp（FSRS 输出为浮点天） */
export function advanceCard(prev: Card, now: Date, rating: Rating): Card {
  const { card } = SCHEDULER.next(prev, now, rating);
  const days = Math.min(
    Math.max((card.due.getTime() - now.getTime()) / MS_PER_DAY, MIN_INTERVAL_DAYS),
    MAX_INTERVAL_DAYS,
  );
  return { ...card, due: new Date(now.getTime() + Math.round(days * MS_PER_DAY)) };
}

/** review_states 行字段 → FSRS Card（elapsed 由 last_review 推导；NULL=未激活→New 卡） */
export interface FsrStateFields {
  difficulty: number | null;
  stability: number | null;
  reps: number;
  lapses: number;
  nextReviewAt: string | null;
  lastReviewAt: string | null;
}

export function cardFromSnapshot(s: FsrStateFields, now: Date): Card {
  if (s.difficulty === null || s.stability === null || s.lastReviewAt === null) {
    return createEmptyCard(now);
  }
  const last = new Date(s.lastReviewAt);
  return {
    due: s.nextReviewAt !== null ? new Date(s.nextReviewAt) : now,
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: Math.max(0, Math.round((now.getTime() - last.getTime()) / MS_PER_DAY)),
    last_review: last,
    reps: s.reps,
    lapses: s.lapses,
    state: s.reps > 0 ? State.Review : State.New,
  } satisfies Card;
}

/** 迁移回放：按时间序逐条演进（起点 New 卡） */
export function replayRatings(entries: { at: Date; rating: Rating }[]): Card {
  let card = createEmptyCard(entries[0]?.at ?? new Date());
  for (const e of entries) card = advanceCard(card, e.at, e.rating);
  return card;
}
```

注：`ReviewOutcome` 从 `./service.js` 导入会形成循环引用（service 之后也 import 本模块）——把 `ReviewOutcome` 接口**移到 fsrs-engine.ts 并从 service.ts re-export**（消费方 import 路径不变）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @el/api exec vitest run tests/unit/fsrs-engine.test.ts`
Expected: PASS 全绿。若 `satisfies Card` 因 ts-fsrs 版本字段差异报错，按其 `Card` 类型对齐（如缺 `learning_steps`），测试断言不变。

- [ ] **Step 6: 提交**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/modules/review/fsrs-engine.ts apps/api/tests/unit/fsrs-engine.test.ts
git commit -m "feat(api): ts-fsrs 引擎封装——参数/评分映射/演进 clamp/快照重建/回放纯函数"
```

### Task 2: 契约、schema 与状态机切换（原子联动）

**Files:**
- Modify: `packages/shared/src/constants/review.ts`（删阶梯常量与 reviewStageLabel，新增分档）
- Modify: `packages/shared/src/schemas/learning-item.ts`、`schemas/import-export.ts`、`schemas/api/library.ts`（DTO 字段）
- Modify: `apps/api/src/db/schema.ts`（review_states 列）+ 生成 `apps/api/drizzle/0007_*.sql`
- Modify: `apps/api/src/modules/review/service.ts`、`goals.ts`
- Modify: `apps/api/src/modules/today/service.ts`（DimSnapshot/learn 结算/快照恢复）
- Modify: `apps/api/src/modules/learning-items/service.ts`、`import-export/service.ts`（序列化/初始态/restore）
- Modify: `apps/web/src/features/library/LibraryDetailPage.tsx`（阶段标签）
- Test: `tests/unit/review-state-machine.test.ts`（重写）、`tests/unit/today-answer.test.ts`、`tests/integration/{today,library,migrate-smoke}.test.ts` 等受影响用例；`apps/web/tests/library-detail.test.tsx`

**Interfaces:**
- Consumes: Task 1 全部导出。
- Produces: `ReviewStateSnapshot`（新形状，见 Global Constraints）；`stabilityStageLabel(stability: number | null)`；`computeNextReviewState(current, outcome, now)` 签名不变（内部 FSRS）；`initialUnderstandingAfterLearn(outcome, now)` 签名**变更**（补 outcome 参数）。

- [ ] **Step 1: 重写 review-state-machine 单测（红）**

用 FSRS 语义重写 `apps/api/tests/unit/review-state-machine.test.ts`，保留文件内 mastery/目标相关用例结构，删除 level/tooEasy 语义，核心新断言：

```ts
describe('computeNextReviewState（FSRS）', () => {
  const now = new Date('2026-10-03T00:00:00.000Z');

  it('未激活输入 + Good：激活并排期 ≥1 天；Easy 间隔 > Good；Again 最短', () => {
    const inactive = INACTIVE_SNAPSHOT;
    const good = computeNextReviewState(inactive, { kind: 'pass' }, now);
    const easy = computeNextReviewState(inactive, { kind: 'pass', tooEasy: true }, now);
    const again = computeNextReviewState(inactive, { kind: 'fail' }, now);
    expect(Date.parse(good.nextReviewAt!) - now.getTime()).toBeGreaterThanOrEqual(86_400_000);
    expect(Date.parse(easy.nextReviewAt!)).toBeGreaterThan(Date.parse(good.nextReviewAt!));
    expect(Date.parse(again.nextReviewAt!)).toBeLessThan(Date.parse(good.nextReviewAt!));
    expect(good.stability).toBeGreaterThanOrEqual(0);
  });

  it('连续 Good：stability 单调增、间隔递增、reps 累计；fail 后 lapses+1', () => {
    let s = computeNextReviewState(INACTIVE_SNAPSHOT, { kind: 'pass' }, now);
    const s2 = computeNextReviewState(s, { kind: 'pass' }, new Date(now.getTime() + 3 * 86_400_000));
    expect(s2.stability).toBeGreaterThan(s.stability);
    expect(s2.reps).toBe(s.reps + 1);
    const s3 = computeNextReviewState(s2, { kind: 'fail' }, new Date(now.getTime() + 4 * 86_400_000));
    expect(s3.lapses).toBe(s2.lapses + 1);
    expect(s3.wrongStreak).toBe(1);
  });

  it('streaks：pass 记对、basic_pass/fail 清对；fail 记错', () => { /* 同既有断言迁移 */ });

  it('mastered 谓词：U/P 均 S≥120 且目标开 → mastered；S<120 不 master', () => {
    const mk = (stability: number): ReviewStateSnapshot => ({
      difficulty: 5, stability, reps: 5, lapses: 0,
      nextReviewAt: '2027-01-01T00:00:00.000Z', lastReviewAt: '2026-10-01T00:00:00.000Z',
      correctStreak: 5, wrongStreak: 0,
    });
    expect(isMastered(mk(130), mk(130), true)).toBe(true);
    expect(isMastered(mk(130), mk(60), true)).toBe(false);
    expect(isMastered(mk(130), mk(0 as never), false)).toBe(true); // P 不要求
  });
});
```

同轮把 `tests/unit/today-answer.test.ts`、`tests/integration/today.test.ts` 中断言 `level/stable/nextReviewAt=+1d` 的夹具改为 FSRS 宽松断言（`nextReviewAt >= now+1d`），learn 结算断言改为"按首答 outcome 建 U"。集成夹具里直接写 review_states 行的地方改用新列。

- [ ] **Step 2: 跑受影响套件确认红**

Run: `pnpm --filter @el/api exec vitest run tests/unit/review-state-machine.test.ts tests/unit/today-answer.test.ts`
Expected: FAIL（新断言/新签名）。

- [ ] **Step 3: shared 契约切换**

`packages/shared/src/constants/review.ts`：删 `INTERVALS_DAYS/LEVEL_MIN/LEVEL_MAX/TOO_EASY_EXTRA_LEVELS/BASIC_PASS_INTERVAL_FACTOR/FAIL_INTERVAL_FACTOR/MIN_INTERVAL_DAYS/PRODUCTION_STAGE_*` 中仅被阶梯使用的导出（`PRODUCTION_FIRST_REVIEW_DELAY_DAYS=1` 保留）；`reviewStageLabel(level, stable)` 替换为：

```ts
export type ReviewStageLabel = '未开始' | '新' | '巩固' | '熟练' | '掌握';
export function stabilityStageLabel(stability: number | null): ReviewStageLabel {
  if (stability === null) return '未开始';
  if (stability < 7) return '新';
  if (stability < 30) return '巩固';
  if (stability < 120) return '熟练';
  return '掌握';
}
```

`schemas/learning-item.ts`（及 `api/library.ts` 若有独立副本）：reviewState DTO 删 `level/stable`，加 `difficulty: number | null`、`stability: number | null`；`schemas/import-export.ts` 备份行加四个可空字段 `difficulty/stability/reps/lapses`（旧字段 `level/stable` 转为 `optional` 以接受旧备份）。

- [ ] **Step 4: schema + migration 0007**

`apps/api/src/db/schema.ts` review_states：删 `level/stable` 两列定义，加：

```ts
    difficulty: real('difficulty'), // FSRS D；NULL=未激活
    stability: real('stability'), // FSRS S；NULL=未激活
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
```

Run: `pnpm --filter @el/api exec drizzle-kit generate`（生成 `drizzle/0007_*.sql`：重建表删旧列加新列；检查 SQL 只动 review_states）。更新 `tests/integration/migrate-smoke.test.ts` 的列断言。

- [ ] **Step 5: review/service.ts + goals.ts 核心**

- `ReviewOutcome` 移至 fsrs-engine 并 re-export；`ReviewStateSnapshot` 换新形状（Global Constraints 版）。
- `computeNextReviewState(current, outcome, now)`：`const card = advanceCard(cardFromSnapshot(current, now), now, ratingOf(outcome))`；返回映射 `difficulty/stability/reps/lapses` + `nextReviewAt=card.due.toISOString()`（mastered 项也照常排期，上限 365）+ `lastReviewAt=now` + streaks 规则不变。
- `initialUnderstandingAfterLearn(outcome: ReviewOutcome, now)`：改为直接 `computeNextReviewState(INACTIVE_SNAPSHOT, outcome, now)`（learn 首答即首评分）。
- `initialProductionActivation(now)`：`difficulty/stability=null`、`reps/lapses=0`、`nextReviewAt=+PRODUCTION_FIRST_REVIEW_DELAY_DAYS`。
- `goals.ts isMastered`：`u.stability !== null && u.stability >= 120 && (!productionEnabled || (p.stability !== null && p.stability >= 120))`。
- `ensureProductionDueAfterGoalEnabled`：判"未激活"改 `difficulty===null && stability===null && nextReviewAt===null && lastReviewAt===null`；insert 值改新列。
- `advanceReviewState` 落库 values 改新列（level/stable 删除）。

- [ ] **Step 6: today/service.ts 适配**

- `DimSnapshot`（快照 JSON）与 `writeDimState`/恢复函数：字段换 `difficulty/stability/reps/lapses`（恢复时快照缺字段保持现值，沿用既有 optional 兼容写法）。
- Learn 结算（约 :1667）：`writeDimState(tx, itemId, 'understanding', deps.initialUnderstandingAfterLearn(outcome, now), nowIso)`——把 learn 的判定 outcome 传进去（recall 自评映射：重来=fail、良好=pass、简单=pass+tooEasy）。
- `today/service.ts` 内如有对 `level`/`stable` 字面量的分支（如 P 激活判断、取消当日 P 的筛选）逐处改为 `stability === null` 语义。

- [ ] **Step 7: 序列化与前端**

- `learning-items/service.ts`：DTO 组装删 level/stable，加 difficulty/stability（real 列直读）；`reviewStageLabel` 调用点换 `stabilityStageLabel(s.stability)`。
- `import-export/service.ts`：`commitImport` 新项初始 review_states insert（:406 附近）改新列（difficulty/stability null）；导出（:697）加四字段；restore insert（:842）映射新字段（旧备份 level/stale 字段忽略，留待 Task 3 回放）。
- `apps/web/src/features/library/LibraryDetailPage.tsx:563`：`reviewStageLabel(rs.level, rs.stable)` → `stabilityStageLabel(rs.stability)`；import 与相关测试（`apps/web/tests/library-detail.test.tsx`）同步。

- [ ] **Step 8: 全量回归（绿）**

Run: `pnpm --filter @el/api exec vitest run && pnpm --filter @el/web exec vitest run && pnpm typecheck && pnpm lint`
Expected: 全绿（受影响断言已在 Step 1/7 同步；发现仍引用已删导出的测试逐个改为 FSRS 语义）。

- [ ] **Step 9: 提交**

```bash
git add -A -- ':!.claude/skills/import-english/SKILL.md'
git commit -m "feat: 排期核心换轨 FSRS——删阶梯列加 D/S/reps/lapses（0007），mastered=S≥120，快照/序列化/阶段标签同步"
```

### Task 3: fsrs 回放迁移与旧备份重建

**Files:**
- Create: `apps/api/src/modules/review/fsrs-cutover.ts`
- Modify: `apps/api/src/index.ts`（boot 接线）、`apps/api/src/modules/import-export/service.ts`（restore 后回放）
- Test: `apps/api/tests/unit/fsrs-cutover.test.ts`（新）、`tests/integration/backup-restore.test.ts`

**Interfaces:**
- Consumes: `replayRatings`、`ratingOf`、`advanceReviewState` 写库路径（或直接 update 行）。
- Produces: `applyFsrsCutover(db, now: Date): { applied: boolean }`（marker `fsrs`）；`replayFsrsStates(tx: DbTx, now: Date): void`（restore 复用，不查 marker）。

- [ ] **Step 1: 写失败测试**

`fsrs-cutover.test.ts` 覆盖：混合种子（understanding/production/cloze 题各若干 attempts、read_check 与 library_practice 各 1、未激活词、已 mastered 词、时间乱序插入）→ 断言 U/P 行获得 D/S/reps（reps=对应 attempts 数）、cloze/read_check/practice 不影响任何行、无 attempts 行保持 NULL、item.status 按 S≥120 重算（mastered 种子若回放 S<120 会降回 active——种子按此设计断言）、二次运行 no-op（applied=false 且数据字节不变）、旧格式备份恢复（level/stable-only）后行被回放重建。backup-restore.test.ts 加"2.0 含 FSRS 字段 round-trip 保留 D/S"用例。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @el/api exec vitest run tests/unit/fsrs-cutover.test.ts tests/integration/backup-restore.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
export function replayFsrsStates(tx: DbTx, now: Date): void {
  // 1) 取 attempts join questions，过滤 mode='today' 且 kind IN ('understanding','production')，
  //    按 (learning_item_id, dimension) 分组、created_at 升序；
  //    rating：result fail→Again / basic_pass→Hard / pass(+outcomeSource='easy'→Easy)/Good
  // 2) 每组 card = replayRatings(entries)；写 review_states 行：
  //    difficulty/stability/reps/lapses=card 值，next_review_at=card.due ISO，
  //    last_review_at=末条 at；行不存在则插入（randomUUID）。
  // 3) 无 attempts 的行不动（保持未激活）。
  // 4) 全部 active/mastered 候选项跑 reconcileItemStatus（复用现有实现）。
}

export function applyFsrsCutover(db: AppDatabase, now: Date): { applied: boolean } {
  // app_metadata 标记 'fsrs'（事务内：查标记→无则 replayFsrsStates+写标记→有则直接 false）
  // 与 v2-cutover.ts 相同的事务模式。
}
```

dimension 判定：`kind==='understanding'→'understanding'`，`kind==='production'→'production'`。`outcomeSource='easy'` 的 pass 映射 Easy（回放含三档历史）。restore 接线：`commitRestore` 事务末尾检测恢复行 `difficulty IS NULL AND reps=0 AND last_review_at IS NOT NULL`（旧格式激活行）→ 事务内调 `replayFsrsStates`（幂等，仅重建可回放行）。`index.ts`：在 `applyV2Cutover(...)` 之后加 `applyFsrsCutover(db, new Date())`（注释 boot 顺序）。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `pnpm --filter @el/api exec vitest run && pnpm typecheck && pnpm lint`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/modules/review/fsrs-cutover.ts apps/api/src/index.ts apps/api/src/modules/import-export/service.ts apps/api/tests/unit/fsrs-cutover.test.ts apps/api/tests/integration/backup-restore.test.ts
git commit -m "feat(api): fsrs 一次性回放迁移（幂等标记）——today 正式作答重建 D/S，旧备份恢复后重建"
```

### Task 4: 文档、全门禁与部署

**Files:**
- Modify: `docs/PRODUCT_DESIGN.md`（§6.2 排期、V2 生效规则行）、`docs/DATABASE.md`（review_states 列/快照）、`docs/TECHNICAL_DESIGN.md`（如提及阶梯）、`docs/PHASES.md` + `docs/phases/phase-10-fsrs.md`（新，简短留档）

- [ ] **Step 1: 文档**：PRODUCT §6.2 改为 FSRS 描述（0.90 记忆率、D/S、间隔 1..365、mastered=S≥120、评分映射、2026-10-03 起生效）；V2 规则行"按 1/3/7/…阶梯调度"同步；DATABASE 列变更与快照字段；开 Phase 10 留档（目标/决策/结果一句话级别）。

- [ ] **Step 2: 全门禁**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm exec prettier --check <changed files> && git diff --check && E2E_API_PORT=5175 NODE_OPTIONS=--max-old-space-size=1024 pnpm --filter @el/web exec playwright test --workers=1`
Expected: 全部 exit 0（e2e 全量）。

- [ ] **Step 3: 部署与冒烟（生产库首次 boot 自动回放）**

```bash
git push
NODE_OPTIONS=--max-old-space-size=1024 ./deploy/deploy.sh
sleep 3 && systemctl is-active english-learning-api && curl -fsS http://127.0.0.1:5174/api/health && curl -fsS -o /dev/null -w "web %{http_code}\n" http://127.0.0.1:8080/
```

- [ ] **Step 4: 生产验证**：readonly 查生产库 `app_metadata` 出现 `fsrs` 标记；`review_states` 行 `difficulty/stability` 非空数量 ≈ 已激活词条数；`next_review_at` 分布合理（1..365 天内）；`learning_items.status` 分布与迁移前 mastered 数量级一致。记录进 phase-10 留档后提交收尾。

## Self-Review

- Spec 覆盖：参数/映射/clamp（T1）、列与快照与备份字段（T2）、mastered 与标签与序列化（T2）、回放规则与幂等与 boot 顺序（T3）、restore 重建（T3）、测试矩阵（T1–3）、文档与部署验证（T4）。spec §2 注记的 reps/lapses 已入 Global Constraints。
- 占位符：无 TBD；T2 Step 6/7 为精确 file:line 级指令而非代码全文（机械替换，签名已给定）；T3 replay 伪码步骤给出算法与映射全量。
- 类型一致性：`ReviewStateSnapshot`/`FsrStateFields`/函数签名在 T1/T2/T3 一致；`initialUnderstandingAfterLearn(outcome, now)` 变更在 T2 Step 1 测试与 Step 5/6 同步。
