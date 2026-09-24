import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { attempts, learningExamples, questions } from '../../src/db/schema.js';
import {
  maybeSavePersonalExample,
  trimProductionHistory,
  type PersonalExampleInput,
} from '../../src/modules/learning-items/service.js';
import { seedExample, seedItem } from '../helpers/seed';

let db: AppDatabase;
const NOW = new Date('2026-09-24T02:00:00.000Z');

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

function input(overrides: Partial<PersonalExampleInput> = {}): PersonalExampleInput {
  return {
    result: 'pass',
    eligible: true,
    qualityScore: 0.8,
    correctedSentence: 'The constant stress is wearing me down.',
    originalText: 'The constant stress wear me down.',
    betterVersion: null,
    ...overrides,
  };
}

function personal(itemId: string) {
  return db
    .select()
    .from(learningExamples)
    .where(and(eq(learningExamples.learningItemId, itemId), eq(learningExamples.kind, 'personal')))
    .all();
}

async function seedPersonal(
  itemId: string,
  opts: { qualityScore: number | null; pinned?: boolean; text?: string }[],
): Promise<void> {
  for (const o of opts) {
    await seedExample(db, itemId, 'personal', o.text ?? `Example ${randomUUID()}.`, {
      pinned: o.pinned ? 1 : 0,
      qualityScore: o.qualityScore,
    });
  }
}

describe('maybeSavePersonalExample', () => {
  it('result=fail 或 eligible=false → 不处理', () => {
    return (async () => {
      const itemId = 'it-1';
      await seedItem(db, { id: itemId });
      const r1 = maybeSavePersonalExample(db, itemId, input({ result: 'fail' }), NOW);
      const r2 = maybeSavePersonalExample(db, itemId, input({ eligible: false }), NOW);
      expect(r1).toEqual({ saved: false, replacedExampleId: null, exampleId: null });
      expect(r2).toEqual({ saved: false, replacedExampleId: null, exampleId: null });
      expect(personal(itemId)).toHaveLength(0);
    })();
  });

  it('当前 <3 条 → 插入 corrected 版本（original/better/quality/pinned=0）', () => {
    return (async () => {
      const itemId = 'it-2';
      await seedItem(db, { id: itemId });
      await seedPersonal(itemId, [{ qualityScore: 0.7 }]);

      const r = maybeSavePersonalExample(
        db,
        itemId,
        input({ qualityScore: 0.9, betterVersion: 'A better one.' }),
        NOW,
      );
      expect(r.saved).toBe(true);
      expect(r.replacedExampleId).toBeNull();
      expect(r.exampleId).toBeTruthy();

      const rows = personal(itemId);
      expect(rows).toHaveLength(2);
      const saved = rows.find((e) => e.id === r.exampleId)!;
      expect(saved.text).toBe('The constant stress is wearing me down.');
      expect(saved.originalText).toBe('The constant stress wear me down.');
      expect(saved.betterText).toBe('A better one.');
      expect(saved.qualityScore).toBe(0.9);
      expect(saved.pinned).toBe(0);
    })();
  });

  it('==3 且新分未超最差 unpinned + 0.1 → 跳过', () => {
    return (async () => {
      const itemId = 'it-3';
      await seedItem(db, { id: itemId });
      await seedPersonal(itemId, [
        { qualityScore: 0.9 },
        { qualityScore: 0.5 },
        { qualityScore: 0.7 },
      ]);
      // 新 0.55，最差 unpinned 0.5，margin 0.1 → 0.55 ≤ 0.6 不替换
      const r = maybeSavePersonalExample(db, itemId, input({ qualityScore: 0.55 }), NOW);
      expect(r.saved).toBe(false);
      expect(personal(itemId)).toHaveLength(3);
    })();
  });

  it('超 margin → 删除最差 unpinned 并插入新句', () => {
    return (async () => {
      const itemId = 'it-4';
      await seedItem(db, { id: itemId });
      await seedPersonal(itemId, [
        { qualityScore: 0.9, text: 'High one.' },
        { qualityScore: 0.5, text: 'Worst one.' },
        { qualityScore: 0.7, text: 'Mid one.' },
      ]);
      const r = maybeSavePersonalExample(db, itemId, input({ qualityScore: 0.65 }), NOW);
      expect(r.saved).toBe(true);
      expect(r.replacedExampleId).toBeTruthy();

      const rows = personal(itemId);
      expect(rows).toHaveLength(3);
      expect(rows.find((e) => e.text === 'Worst one.')).toBeUndefined();
      expect(rows.find((e) => e.id === r.exampleId)!.text).toBe(
        'The constant stress is wearing me down.',
      );
    })();
  });

  it('quality_score 为 null 的 unpinned 视为 0：新分 0.2 > 0+0.1 → 替换', () => {
    return (async () => {
      const itemId = 'it-5';
      await seedItem(db, { id: itemId });
      await seedPersonal(itemId, [
        { qualityScore: 0.9 },
        { qualityScore: null },
        { qualityScore: 0.7 },
      ]);
      const r = maybeSavePersonalExample(db, itemId, input({ qualityScore: 0.2 }), NOW);
      expect(r.saved).toBe(true);
      // null（视为 0）被替换
      expect(rows060(itemId, r.replacedExampleId!)).toBe(true);
    })();
  });

  it('全 pinned → 跳过（pinned 永不自动淘汰）', () => {
    return (async () => {
      const itemId = 'it-6';
      await seedItem(db, { id: itemId });
      await seedPersonal(itemId, [
        { qualityScore: 0.1, pinned: true },
        { qualityScore: 0.2, pinned: true },
        { qualityScore: 0.3, pinned: true },
      ]);
      const r = maybeSavePersonalExample(db, itemId, input({ qualityScore: 0.95 }), NOW);
      expect(r.saved).toBe(false);
      expect(personal(itemId)).toHaveLength(3);
      expect(personal(itemId).every((e) => e.pinned === 1)).toBe(true);
    })();
  });

  it('最差的是 pinned 时只在 unpinned 中选替换对象', () => {
    return (async () => {
      const itemId = 'it-7';
      await seedItem(db, { id: itemId });
      await seedPersonal(itemId, [
        { qualityScore: 0.05, pinned: true, text: 'Pinned low.' },
        { qualityScore: 0.5, text: 'Unpinned worst.' },
        { qualityScore: 0.7, text: 'Unpinned mid.' },
      ]);
      const r = maybeSavePersonalExample(db, itemId, input({ qualityScore: 0.8 }), NOW);
      expect(r.saved).toBe(true);
      const rows = personal(itemId);
      expect(rows.find((e) => e.text === 'Pinned low.')).toBeTruthy(); // pinned 保留
      expect(rows.find((e) => e.text === 'Unpinned worst.')).toBeUndefined();
    })();
  });
});

function rows060(itemId: string, replacedId: string): boolean {
  const replaced = personal(itemId).find((e) => e.id === replacedId);
  // 被删除后不应存在
  return replaced === undefined;
}

describe('trimProductionHistory（造句历史裁剪）', () => {
  async function seedHistoryItem(): Promise<string> {
    const itemId = await seedItem(db, {});
    const qid = 'hist-q';
    await db
      .insert(questions)
      .values({
        id: qid,
        learningItemId: itemId,
        type: 'production',
        status: 'active',
        meaningSnapshot: '测试释义',
        promptText: '请造句。',
        contextText: null,
        payloadJson: JSON.stringify({
          mustUse: 'test-target',
          referenceAnswer: 'They use test-target.',
          acceptanceNotes: '允许变化。',
        }),
        correctOptionId: null,
        promptKey: 'generate_production_prompt',
        promptVersion: 1,
        promptHash: 'hash',
        model: 'mock',
        useCount: 0,
        correctCount: 0,
        lastUsedAt: null,
        retiredAt: null,
        createdAt: '2026-09-01T00:00:00.000Z',
      })
      .run();
    return itemId;
  }

  function insertAttempt(itemId: string, qid: string, n: number, mode: 'today' | 'read_check') {
    db.insert(attempts)
      .values({
        id: `hist-a-${n}`,
        reviewTaskId: null,
        learningItemId: itemId,
        questionId: qid,
        mode,
        answerText: `Answer ${n}.`,
        selectedOptionId: null,
        result: 'pass',
        viewedSource: 0,
        feedback: null,
        correctionJson: JSON.stringify({
          segments: [{ text: `Answer ${n}.`, type: 'same' }],
          corrected: `Answer ${n}.`,
          better: null,
        }),
        explanation: 'ok',
        betterVersion: null,
        aiPromptKey: 'check_production',
        aiPromptVersion: 1,
        aiPromptHash: 'hash',
        aiModel: 'mock',
        preStateJson: null,
        postStateJson: null,
        createdAt: new Date(NOW.getTime() + n * 60_000).toISOString(),
        voidedAt: null,
      })
      .run();
  }

  it('超过 10 条时删除最旧，保留最新 10 条；read_check 模式不计入', () => {
    return (async () => {
      const itemId = await seedHistoryItem();
      for (let i = 0; i < 10; i++) insertAttempt(itemId, 'hist-q', i, 'today');
      // 第 11 条插入后触发裁剪：最旧（hist-a-0）被删
      insertAttempt(itemId, 'hist-q', 10, 'today');
      insertAttempt(itemId, 'hist-q', 99, 'read_check'); // 不参与裁剪
      trimProductionHistory(db, itemId);

      const rows = db
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.learningItemId, itemId),
            inArray(attempts.mode, ['today', 'library_practice']),
          ),
        )
        .all();
      expect(rows).toHaveLength(10);
      expect(rows.map((r) => r.id)).not.toContain('hist-a-0');
      expect(rows.map((r) => r.id)).toContain('hist-a-10');
      expect(rows.map((r) => r.id)).toContain('hist-a-1');
      // read_check 仍在
      expect(db.select().from(attempts).where(eq(attempts.id, 'hist-a-99')).get()).toBeTruthy();
    })();
  });

  it('不足 10 条时不删除', () => {
    return (async () => {
      const itemId = await seedHistoryItem();
      for (let i = 0; i < 3; i++) insertAttempt(itemId, 'hist-q', i, 'today');
      trimProductionHistory(db, itemId);
      expect(
        db.select().from(attempts).where(eq(attempts.learningItemId, itemId)).all(),
      ).toHaveLength(3);
    })();
  });
});
