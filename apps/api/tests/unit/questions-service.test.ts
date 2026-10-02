import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { questions } from '../../src/db/schema.js';
import type { QuestionRow } from '../../src/modules/questions/service.js';
import {
  acquireQuestion,
  countQuestionStock,
  evaluateChoice,
  evaluateCloze,
} from '../../src/modules/questions/service.js';
import { buildMockRuntime } from '../helpers/ai';
import { seedExample, seedItem, seedQuestion } from '../helpers/seed.js';

let db: AppDatabase;
const NOW = new Date('2026-09-24T10:00:00.000Z');

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

async function seededItem(): Promise<string> {
  const itemId = await seedItem(db, { type: 'chunk', target: 'wear down', meaning: '逐渐消耗' });
  await seedExample(db, itemId, 'source', 'Long-term stress wears you down.');
  return itemId;
}

function choiceQuestion(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q-choice',
    learningItemId: 'item-1',
    type: 'understanding',
    status: 'active',
    meaningSnapshot: '逐渐消耗',
    promptText: '这里的 wear down 最接近什么意思？',
    contextText: 'A natural context.',
    payloadJson: JSON.stringify({
      options: [
        { id: 'o1', text: '干扰' },
        { id: 'o2', text: '逐渐消耗' },
        { id: 'o3', text: '干扰' },
        { id: 'o4', text: '干扰' },
      ],
    }),
    correctOptionId: 'o2',
    promptKey: 'generate_understanding',
    promptVersion: 1,
    promptHash: 'hash',
    model: 'mock',
    useCount: 1,
    correctCount: 0,
    lastUsedAt: null,
    retiredAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function clozeQuestion(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q-cloze',
    learningItemId: 'item-1',
    type: 'cloze',
    status: 'active',
    meaningSnapshot: '逐渐消耗',
    promptText: 'Long-term stress can ____ you down.',
    contextText: null,
    payloadJson: JSON.stringify({ acceptedAnswers: ['wear down', 'wears down'] }),
    correctOptionId: null,
    promptKey: 'generate_cloze',
    promptVersion: 1,
    promptHash: 'hash',
    model: 'mock',
    useCount: 1,
    correctCount: 0,
    lastUsedAt: null,
    retiredAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('acquireQuestion', () => {
  it('无库存返回 null', async () => {
    const itemId = await seededItem();
    expect(acquireQuestion(db, itemId, 'understanding', NOW)).toBeNull();
  });

  it('按 last_used_at 最旧优先（null 最先），取出即置 active、use_count+1、last_used_at=now', async () => {
    const itemId = await seededItem();
    await seedQuestion(db, itemId, { id: 'q-null', type: 'understanding', lastUsedAt: null });
    await seedQuestion(db, itemId, {
      id: 'q-old',
      type: 'understanding',
      status: 'active',
      useCount: 2,
      lastUsedAt: '2026-09-20T00:00:00.000Z',
    });
    await seedQuestion(db, itemId, {
      id: 'q-new',
      type: 'understanding',
      lastUsedAt: '2026-09-23T00:00:00.000Z',
    });

    const first = acquireQuestion(db, itemId, 'understanding', NOW);
    expect(first?.id).toBe('q-null');
    expect(first?.status).toBe('active');
    expect(first?.useCount).toBe(1);
    expect(first?.lastUsedAt).toBe(NOW.toISOString());

    const second = acquireQuestion(db, itemId, 'understanding', NOW);
    expect(second?.id).toBe('q-old');
    expect(second?.useCount).toBe(3);

    const third = acquireQuestion(db, itemId, 'understanding', NOW);
    expect(third?.id).toBe('q-new');

    // 取出的题留在练习池（active），库存耗尽后按 last_used_at 轮转复用，而非 null
    const rotated = acquireQuestion(db, itemId, 'understanding', NOW);
    expect(rotated).not.toBeNull();
    expect(['q-null', 'q-old', 'q-new']).toContain(rotated!.id);
  });

  it('retired / bad_question 不进入练习池', async () => {
    const itemId = await seededItem();
    await seedQuestion(db, itemId, { id: 'q-retired', type: 'understanding', status: 'retired' });
    await seedQuestion(db, itemId, { id: 'q-bad', type: 'understanding', status: 'bad_question' });
    expect(acquireQuestion(db, itemId, 'understanding', NOW)).toBeNull();
  });

  it('V2 新取题不接收旧 cloze，即使库存充足', async () => {
    const itemId = await seededItem();
    await seedQuestion(db, itemId, { id: 'q-cloze', type: 'cloze' });
    expect(acquireQuestion(db, itemId, 'understanding', NOW)).toBeNull();
    expect(() => acquireQuestion(db, itemId, 'cloze', NOW)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(countQuestionStock(db, itemId, 'cloze')).toBe(1);
  });
});

describe('countQuestionStock', () => {
  it('只计 fresh + active', async () => {
    const itemId = await seededItem();
    await seedQuestion(db, itemId, { id: 'q1', type: 'understanding', status: 'fresh' });
    await seedQuestion(db, itemId, { id: 'q2', type: 'understanding', status: 'active' });
    await seedQuestion(db, itemId, { id: 'q3', type: 'understanding', status: 'retired' });
    await seedQuestion(db, itemId, { id: 'q4', type: 'understanding', status: 'bad_question' });
    await seedQuestion(db, itemId, { id: 'q5', type: 'cloze', status: 'fresh' });
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(2);
    expect(countQuestionStock(db, itemId, 'cloze')).toBe(1);
  });
});

describe('evaluateChoice', () => {
  it('答对', () => {
    const q = choiceQuestion();
    expect(evaluateChoice(q, 'o2')).toEqual({ correct: true, correctOptionId: 'o2' });
  });

  it('答错并揭示正确选项', () => {
    const q = choiceQuestion();
    expect(evaluateChoice(q, 'o1')).toEqual({ correct: false, correctOptionId: 'o2' });
  });
});

describe('evaluateCloze：本地判定', () => {
  it('完全一致', async () => {
    const out = await evaluateCloze({ db, runtime: null }, clozeQuestion(), 'wear down');
    expect(out).toEqual({ correct: true, canonicalAnswer: 'wear down', usedAi: false });
  });

  it('大小写不敏感', async () => {
    const out = await evaluateCloze({ db, runtime: null }, clozeQuestion(), 'WEAR DOWN');
    expect(out.correct).toBe(true);
    expect(out.usedAi).toBe(false);
  });

  it('压缩空白', async () => {
    const out = await evaluateCloze({ db, runtime: null }, clozeQuestion(), '  wear   down  ');
    expect(out.correct).toBe(true);
  });

  it('去首尾标点', async () => {
    const a = await evaluateCloze({ db, runtime: null }, clozeQuestion(), 'wear down!');
    expect(a.correct).toBe(true);
    const b = await evaluateCloze({ db, runtime: null }, clozeQuestion(), '"wear down"');
    expect(b.correct).toBe(true);
  });

  it('accepted_answers 中的变形可接受并返回其规范形式', async () => {
    const out = await evaluateCloze({ db, runtime: null }, clozeQuestion(), 'Wears Down.');
    expect(out).toEqual({ correct: true, canonicalAnswer: 'wears down', usedAi: false });
  });

  it('拼写错误拒绝（本地不匹配且无 AI）', async () => {
    const out = await evaluateCloze({ db, runtime: null }, clozeQuestion(), 'wera down');
    expect(out).toEqual({ correct: false, canonicalAnswer: 'wear down', usedAi: false });
  });

  it('同义词拒绝（本地不匹配且无 AI）', async () => {
    const out = await evaluateCloze({ db, runtime: null }, clozeQuestion(), 'exhaust');
    expect(out).toEqual({ correct: false, canonicalAnswer: 'wear down', usedAi: false });
  });

  it('mock runtime（非 glm）不走 AI 兜底', async () => {
    const out = await evaluateCloze(
      { db, runtime: buildMockRuntime() },
      clozeQuestion(),
      'exhaust',
    );
    expect(out).toEqual({ correct: false, canonicalAnswer: 'wear down', usedAi: false });
  });
});

describe('evaluateCloze：AI 兜底', () => {
  it('注入 aiCheck：接受变形 → correct=true、usedAi=true', async () => {
    const calls: Array<{ questionId: string; userAnswer: string }> = [];
    // 'wears' 本地不匹配（不是完整 chunk），触发 AI 兜底
    const out = await evaluateCloze(
      {
        db,
        runtime: null,
        aiCheck: async (question, userAnswer) => {
          calls.push({ questionId: question.id, userAnswer });
          return { accepted: true, canonical_answer: 'wears down', reason: '第三人称单数' };
        },
      },
      clozeQuestion(),
      'wears',
    );
    expect(out).toEqual({ correct: true, canonicalAnswer: 'wears down', usedAi: true });
    expect(calls).toEqual([{ questionId: 'q-cloze', userAnswer: 'wears' }]);
  });

  it('注入 aiCheck：拒绝 → correct=false、usedAi=true', async () => {
    const out = await evaluateCloze(
      {
        db,
        runtime: null,
        aiCheck: async () => ({ accepted: false, canonical_answer: 'wear down', reason: '同义词' }),
      },
      clozeQuestion(),
      'exhaust',
    );
    expect(out).toEqual({ correct: false, canonicalAnswer: 'wear down', usedAi: true });
  });

  it('注入 aiCheck：抛错 → 拒绝且不向上传播', async () => {
    const out = await evaluateCloze(
      {
        db,
        runtime: null,
        aiCheck: async () => {
          throw new Error('AI 故障');
        },
      },
      clozeQuestion(),
      'anything',
    );
    expect(out).toEqual({ correct: false, canonicalAnswer: 'wear down', usedAi: true });
  });

  it('默认路径：glm provider 走 checkCloze（真实 Registry 渲染）', async () => {
    const itemId = await seededItem();
    await seedQuestion(db, itemId, {
      id: 'q-cloze-live',
      type: 'cloze',
      meaningSnapshot: '逐渐消耗',
      promptText: 'Long-term stress can ____ you down.',
      payloadJson: JSON.stringify({ acceptedAnswers: ['wear down'] }),
    });
    const row = db.select().from(questions).where(eq(questions.id, 'q-cloze-live')).get()!;

    const prompts: string[] = [];
    const runtime = buildMockRuntime({
      name: 'glm',
      async complete(req) {
        prompts.push(req.prompt);
        return JSON.stringify({ accepted: true, canonical_answer: 'wears down', reason: 'ok' });
      },
    });

    const out = await evaluateCloze({ db, runtime }, row, 'wears');
    expect(out).toEqual({ correct: true, canonicalAnswer: 'wears down', usedAi: true });
    // Prompt 使用 item.target 与题目 meaning_snapshot
    expect(prompts[0]).toContain('wear down');
    expect(prompts[0]).toContain('逐渐消耗');
    expect(prompts[0]).toContain('wears');
  });
});
