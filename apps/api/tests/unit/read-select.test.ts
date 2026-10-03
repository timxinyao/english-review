import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiStructuredError } from '../../src/ai/complete.js';
import type { AiProvider } from '../../src/ai/provider/index.js';
import { initAiRuntime } from '../../src/ai/runtime.js';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { attempts, readArticles } from '../../src/db/schema.js';
import { AppError } from '../../src/lib/errors.js';
import {
  buildReadSelection,
  generateReadArticle,
  loadRealReadDeps,
  type ReadDeps,
} from '../../src/modules/read/service.js';
import { testAiConfig } from '../helpers/ai.js';
import { seedItem, seedReviewState } from '../helpers/seed.js';

const NOW = new Date('2026-09-24T02:00:00.000Z');
const DAY_MS = 24 * 3600 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

let db: AppDatabase;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

/** 近期正式复习失败 attempt（mode=today, result=fail） */
function seedFail(itemId: string, at: string, voided = false): void {
  db.insert(attempts)
    .values({
      id: randomUUID(),
      reviewTaskId: null,
      learningItemId: itemId,
      questionId: null,
      mode: 'today',
      answerText: null,
      selectedOptionId: 'o2',
      result: 'fail',
      viewedSource: 0,
      feedback: null,
      correctionJson: null,
      explanation: null,
      betterVersion: null,
      aiPromptKey: null,
      aiPromptVersion: null,
      aiPromptHash: null,
      aiModel: null,
      preStateJson: null,
      postStateJson: null,
      createdAt: at,
      voidedAt: voided ? at : null,
    })
    .run();
}

/** active+started 项 + U 维状态（stability/lastReviewAt 可覆盖；≥120=掌握） */
async function seedActive(
  itemId: string,
  overrides: {
    uStability?: number;
    uLast?: string | null;
    pStability?: number | null;
    pWrongStreak?: number;
    pLast?: string | null;
    needsReinforcement?: number;
    status?: string;
  } = {},
): Promise<void> {
  await seedItem(db, {
    id: itemId,
    target: itemId,
    meaning: `${itemId} 释义`,
    queueState: 'started',
    status: overrides.status ?? 'active',
    needsReinforcement: overrides.needsReinforcement ?? 0,
  });
  await seedReviewState(db, itemId, 'understanding', {
    difficulty: 5,
    stability: overrides.uStability ?? 15,
    reps: 3,
    lastReviewAt: overrides.uLast === undefined ? daysAgo(10) : overrides.uLast,
    nextReviewAt: daysAgo(1),
  });
  if (overrides.pStability !== null) {
    await seedReviewState(db, itemId, 'production', {
      difficulty: 5,
      stability: overrides.pStability ?? 5,
      reps: 1,
      wrongStreak: overrides.pWrongStreak ?? 0,
      lastReviewAt: overrides.pLast === undefined ? daysAgo(10) : overrides.pLast,
      nextReviewAt: daysAgo(1),
    });
  }
}

function seedArticle(id: string, type: string, createdAt: string): void {
  db.insert(readArticles)
    .values({
      id,
      title: `t-${id}`,
      body: 'some body text',
      type,
      contentLevel: 'B1',
      favorite: 0,
      promptKey: 'generate_read',
      promptVersion: 1,
      promptHash: 'hash',
      model: 'mock',
      checksJson: '[]',
      createdAt,
      expiresAt: daysAgo(-30),
    })
    .run();
}

describe('buildReadSelection：focus 弱项排序', () => {
  it('近 30 天 today-fail 数为首要排序（多者先选）', async () => {
    await seedActive('item-plain');
    await seedActive('item-two-fails');
    seedFail('item-two-fails', daysAgo(2));
    seedFail('item-two-fails', daysAgo(5));

    const sel = buildReadSelection(db, NOW);
    expect(sel.focusItems.map((f) => f.id)).toEqual(['item-two-fails', 'item-plain']);
    expect(sel.focusItems[0]).toMatchObject({
      id: 'item-two-fails',
      target: 'item-two-fails',
      meaning: 'item-two-fails 释义',
    });
  });

  it('30 天窗口外的 fail 不计数；窗口内优先于窗口外', async () => {
    await seedActive('item-old-fail');
    await seedActive('item-fresh-fail');
    seedFail('item-old-fail', daysAgo(40));
    seedFail('item-fresh-fail', daysAgo(3));

    const sel = buildReadSelection(db, NOW);
    expect(sel.focusItems.map((f) => f.id)).toEqual(['item-fresh-fail', 'item-old-fail']);
  });

  it('fail 数相同时按 production wrong_streak DESC，再按（激活维）stability ASC', async () => {
    await seedActive('item-p-weak', { pWrongStreak: 3 });
    await seedActive('item-p-ok', { pWrongStreak: 0 });
    await seedActive('item-level-high', { uStability: 70, pStability: null });

    const sel = buildReadSelection(db, NOW);
    // item-p-weak(wrong_streak 3) > item-p-ok(0)；item-level-high 无 P 行，wrong_streak=0、S=70（最高）排最后
    expect(sel.focusItems.map((f) => f.id)).toEqual([
      'item-p-weak',
      'item-p-ok',
      'item-level-high',
    ]);
  });

  it('全相同时 lastReviewAt DESC（最近复习的先选），id ASC 兜底', async () => {
    await seedActive('item-recent', { uLast: daysAgo(1) });
    await seedActive('item-stale', { uLast: daysAgo(20) });

    const sel = buildReadSelection(db, NOW);
    expect(sel.focusItems.map((f) => f.id)).toEqual(['item-recent', 'item-stale']);
  });

  it('focus 上限 5 个（READ_FOCUS_MAX）：种子多于 5 个弱项时只取 5', async () => {
    for (let i = 0; i < 8; i++) await seedActive(`item-${i}`);
    const sel = buildReadSelection(db, NOW);
    expect(sel.focusItems).toHaveLength(5);
    // 无 fail 等差异化信号时按 id ASC 兜底，取前 5
    expect(sel.focusItems.map((f) => f.id)).toEqual([
      'item-0',
      'item-1',
      'item-2',
      'item-3',
      'item-4',
    ]);
  });

  it('候选池只含 active+started 且至少一行 review_states 的项', async () => {
    await seedItem(db, { id: 'new-queue', target: 'new-queue', queueState: 'new' });
    await seedItem(db, { id: 'no-state', target: 'no-state', queueState: 'started' });
    await seedActive('paused-one', { status: 'paused' });
    await seedActive('valid-one');

    const sel = buildReadSelection(db, NOW);
    expect(sel.focusItems.map((f) => f.id)).toEqual(['valid-one']);
  });

  it('无任何 focus 候选 → 抛 CONFLICT', async () => {
    await seedItem(db, { id: 'new-only', target: 'x', queueState: 'new' });
    expect(() => buildReadSelection(db, NOW)).toThrowError(AppError);
    try {
      buildReadSelection(db, NOW);
    } catch (err) {
      expect((err as AppError).code).toBe('CONFLICT');
      expect((err as AppError).statusCode).toBe(409);
    }
  });
});

describe('buildReadSelection：old 稳定项', () => {
  it('mastered 或两维越过掌握线；按 lastReviewAt ASC（最久未复习优先）；两维掌握的 active 项不进 focus', async () => {
    // mastered，很久没复习
    await seedActive('old-mastered', { status: 'mastered', uLast: daysAgo(100) });
    // 只有一维越过掌握线：不是 old 候选，仍是 focus 候选
    await seedActive('half-stable', { uStability: 130 });

    const sel = buildReadSelection(db, NOW);
    expect(sel.focusItems.map((f) => f.id)).toEqual(['half-stable']);
    expect(sel.oldItems.map((o) => o.id)).toEqual(['old-mastered']);
    expect(sel.oldItems[0]).toMatchObject({ id: 'old-mastered', target: 'old-mastered' });
  });

  it('两维均越过掌握线的 active 项：mastered 语义（进 old，不进 focus）', async () => {
    // 弱项（保证 focus 非空）
    await seedActive('weak-one');
    // 两维 S≥120 的 active 项
    await seedActive('dual-stable', {
      uStability: 130,
      pStability: 130,
      uLast: daysAgo(80),
      pLast: daysAgo(80),
    });

    const sel = buildReadSelection(db, NOW);
    expect(sel.focusItems.map((f) => f.id)).toEqual(['weak-one']);
    expect(sel.oldItems.map((o) => o.id)).toEqual(['dual-stable']);
  });

  it('无 old 候选时降级为空数组（不报错）', async () => {
    await seedActive('only-focus');
    const sel = buildReadSelection(db, NOW);
    expect(sel.focusItems).toHaveLength(1);
    expect(sel.oldItems).toEqual([]);
  });

  it('old 上限 5 个，最久未复习优先', async () => {
    await seedActive('weak-one'); // 保证 focus 非空
    for (let i = 0; i < 7; i++) {
      // 仅 U 维（P 维缺失），lastReviewAt = 10+i 天前：i 越大越久未复习
      await seedActive(`m-${i}`, { status: 'mastered', uLast: daysAgo(10 + i), pStability: null });
    }
    const sel = buildReadSelection(db, NOW);
    expect(sel.oldItems).toHaveLength(5);
    expect(sel.oldItems.map((o) => o.id)).toEqual(['m-6', 'm-5', 'm-4', 'm-3', 'm-2']);
  });
});

describe('buildReadSelection：其他输入', () => {
  it('contentLevel 取 settings（默认 B1；非法值回退默认）', async () => {
    await seedActive('one');
    expect(buildReadSelection(db, NOW).contentLevel).toBe('B1');
  });

  it('recentReadTypes 取最近 3 篇的 type（时间正序）', async () => {
    seedArticle('a1', 'story', daysAgo(9));
    seedArticle('a2', 'daily_scene', daysAgo(6));
    seedArticle('a3', 'knowledge', daysAgo(3));
    seedArticle('a4', 'short_opinion', daysAgo(1));
    await seedActive('one');

    const sel = buildReadSelection(db, NOW);
    expect(sel.recentReadTypes).toEqual(['daily_scene', 'knowledge', 'short_opinion']);
  });

  it('无历史文章时 recentReadTypes 为空数组', async () => {
    await seedActive('one');
    expect(buildReadSelection(db, NOW).recentReadTypes).toEqual([]);
  });
});

describe('generateReadArticle：AI 生成失败', () => {
  it('生成失败：真实原因落 console.error，再抛通用 502', async () => {
    await seedActive('weak-one');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps: ReadDeps = {
        generate: () =>
          Promise.reject(new AiStructuredError('输出违反不变式：focus item xxx 未出现在 coverage')),
      };
      await expect(generateReadArticle(db, deps, NOW)).rejects.toThrow('文章生成失败，请稍候重试');
      // 真实原因（不变式违规详情）落服务端日志
      const last = errSpy.mock.calls.at(-1);
      expect(last?.[0]).toBe('[read/generate] 生成失败：');
      expect(String(last?.[1])).toContain('未出现在 coverage');
      // 失败零写入
      expect(db.select().from(readArticles).all()).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('loadRealReadDeps：generate 变量组装', () => {
  it('vars 携带逐行 focus_list/old_list（契约前置的回抄载体）及 focus_items/old_items 对象', async () => {
    // mock provider（无 GLM key 不走真实调用）；包装 runtime 单例 provider 记录 completeStructured 收到的 vars
    const runtime = initAiRuntime(testAiConfig());
    const inner = runtime.provider;
    const seen: Array<Record<string, unknown>> = [];
    (runtime as unknown as { provider: AiProvider }).provider = {
      name: inner.name,
      async complete(req) {
        seen.push(req.vars);
        return inner.complete(req);
      },
    };

    const deps = await loadRealReadDeps();
    const focus = [
      { id: 'focus-1', target: 'wear down', meaning: '逐渐消耗' },
      { id: 'focus-2', target: 'raw', meaning: '未经处理的' },
    ];
    const old = [{ id: 'old-1', target: 'make sense', meaning: '讲得通' }];
    await deps.generate({
      focusItems: focus,
      oldItems: old,
      contentLevel: 'B1',
      recentReadTypes: ['story'],
    });

    expect(seen).toHaveLength(1);
    const vars = seen[0]!;
    // 逐行列表变量（提示词契约前置的回抄载体）
    expect(String(vars.focus_list)).toContain(focus[0]!.id);
    expect(String(vars.focus_list)).toContain(focus[0]!.target);
    expect(String(vars.focus_list)).toContain(focus[0]!.meaning);
    // old_list 逐行词条（target（meaning）格式）
    expect(String(vars.old_list)).toContain('make sense');
    // invariants 消费的对象变量仍随 vars 传递（模板不引用）
    expect(vars.focus_items).toEqual(focus);
    expect(vars.old_items).toEqual(old);
    expect(vars.content_level).toBe('B1');
    expect(vars.recent_read_types).toEqual(['story']);
  });

  it('old 为空时 old_list 渲染占位（无）而非空串', async () => {
    const runtime = initAiRuntime(testAiConfig());
    const inner = runtime.provider;
    const seen: Array<Record<string, unknown>> = [];
    (runtime as unknown as { provider: AiProvider }).provider = {
      name: inner.name,
      async complete(req) {
        seen.push(req.vars);
        return inner.complete(req);
      },
    };

    const deps = await loadRealReadDeps();
    await deps.generate({
      focusItems: [{ id: 'focus-1', target: 'wear down', meaning: '逐渐消耗' }],
      oldItems: [],
      contentLevel: 'B1',
      recentReadTypes: [],
    });
    expect(String(seen[0]!.old_list)).toBe('（无）');
  });
});
