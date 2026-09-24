import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadPromptRegistry } from '../../src/ai/promptRegistry.js';
import { createMockProvider } from '../../src/ai/provider/index.js';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { questions } from '../../src/db/schema.js';
import {
  acquireQuestion,
  countQuestionStock,
  evaluateProduction,
  generateQuestionsForItem,
  productionQuestionTypeFor,
  questionTypesForDue,
  type QuestionRow,
} from '../../src/modules/questions/service.js';
import { buildMockRuntime, recordingProvider, throwingProvider } from '../helpers/ai';
import { seedExample, seedItem } from '../helpers/seed';

let db: AppDatabase;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

async function seededItem(target = 'wear down', meaning = '逐渐消耗'): Promise<string> {
  const id = await seedItem(db, { type: 'chunk', target, meaning });
  await seedExample(db, id, 'source', 'Long-term stress wears you down.');
  await seedExample(db, id, 'extra', 'The noise wore him down.', { sortOrder: 0 });
  return id;
}

function recordingMockRuntime() {
  const rec = recordingProvider(createMockProvider());
  return { runtime: buildMockRuntime(rec.provider), prompts: rec.prompts };
}

describe('generateQuestionsForItem：production（单题结构）', () => {
  it('生成表达题入库：promptText=zh_prompt、payload 含 mustUse/referenceAnswer/acceptanceNotes、context/correct_option 为空', async () => {
    const itemId = await seededItem();
    const runtime = buildMockRuntime();
    const rows = await generateQuestionsForItem({ db, runtime }, itemId, 'production', 1);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const registry = loadPromptRegistry(join(process.cwd(), 'prompts'));
    const prompt = registry.get('generate_production_prompt')!;
    expect(row.type).toBe('production');
    expect(row.status).toBe('fresh');
    expect(row.meaningSnapshot).toBe('逐渐消耗');
    expect(row.contextText).toBeNull();
    expect(row.correctOptionId).toBeNull();
    expect(row.promptKey).toBe('generate_production_prompt');
    expect(row.promptVersion).toBe(prompt.version);
    expect(row.promptHash).toBe(prompt.hash);
    expect(row.model).toBe(runtime.config.glmModels.flash);
    expect(row.promptText).toBeTruthy(); // zh_prompt
    const payload = JSON.parse(row.payloadJson) as {
      mustUse: string;
      referenceAnswer: string;
      acceptanceNotes: string;
    };
    expect(payload.mustUse).toBe('wear down');
    expect(payload.referenceAnswer).toBeTruthy();
    expect(payload.acceptanceNotes).toBeTruthy();
    expect(JSON.stringify(payload)).not.toContain('reference_answer');
  });

  it('count=2 连续生成两题，第二批 Prompt 携带首批 zh_prompt（避免重复）', async () => {
    const itemId = await seededItem();
    const { runtime, prompts } = recordingMockRuntime();
    const rows = await generateQuestionsForItem({ db, runtime }, itemId, 'production', 2);

    expect(rows).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('recent_prompts_json');
    expect(prompts[1]).toContain(rows[0]!.promptText!); // 第一批 zh_prompt 进入第二批 recent_prompts
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  it('provider 失败抛错且不入库；runtime 为 null → AI_PROVIDER_ERROR', async () => {
    const itemId = await seededItem();
    await expect(
      generateQuestionsForItem(
        { db, runtime: buildMockRuntime(throwingProvider()) },
        itemId,
        'production',
        1,
      ),
    ).rejects.toThrow(/AI 结构化调用失败/);
    expect(countQuestionStock(db, itemId, 'production')).toBe(0);

    await expect(
      generateQuestionsForItem({ db, runtime: null }, itemId, 'production', 1),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' });
  });

  it('countQuestionStock / acquireQuestion 支持 production（含 use_count 与 active 状态）', async () => {
    const itemId = await seededItem();
    await generateQuestionsForItem({ db, runtime: buildMockRuntime() }, itemId, 'production', 2);
    expect(countQuestionStock(db, itemId, 'production')).toBe(2);

    const got = acquireQuestion(db, itemId, 'production', new Date('2026-09-24T00:00:00Z'));
    expect(got).not.toBeNull();
    expect(got!.status).toBe('active');
    expect(got!.useCount).toBe(1);
    expect(got!.lastUsedAt).toBe('2026-09-24T00:00:00.000Z');
    expect(countQuestionStock(db, itemId, 'production')).toBe(2); // active 仍在练习池
  });
});

describe('evaluateProduction（check_production 批改）', () => {
  async function seedProductionQuestion(): Promise<{ itemId: string; question: QuestionRow }> {
    const itemId = await seededItem();
    await db
      .insert(questions)
      .values({
        id: 'prod-q1',
        learningItemId: itemId,
        type: 'production',
        status: 'active',
        meaningSnapshot: '逐渐消耗',
        promptText: '长期的压力让我越来越疲惫。',
        contextText: null,
        payloadJson: JSON.stringify({
          mustUse: 'wear down',
          referenceAnswer: 'The constant stress is wearing me down.',
          acceptanceNotes: '允许正常时态和人称变化。',
        }),
        correctOptionId: null,
        promptKey: 'generate_production_prompt',
        promptVersion: 1,
        promptHash: 'gen-hash',
        model: 'mock',
        useCount: 1,
        correctCount: 0,
        lastUsedAt: new Date().toISOString(),
        retiredAt: null,
        createdAt: new Date().toISOString(),
      })
      .run();
    const question = db.select().from(questions).where(eq(questions.id, 'prod-q1')).get()!;
    return { itemId, question };
  }

  it('变量组装正确：全部 check_production 变量进入 Prompt', async () => {
    const { question } = await seedProductionQuestion();
    const { runtime, prompts } = recordingMockRuntime();
    await evaluateProduction({ db, runtime }, question, 'The stress wears me down.');

    const prompt = prompts[0]!;
    expect(prompt).toContain('item_type: chunk');
    expect(prompt).toContain('target: wear down');
    expect(prompt).toContain('locked_meaning: 逐渐消耗');
    expect(prompt).toContain('zh_prompt: 长期的压力让我越来越疲惫。');
    expect(prompt).toContain('reference_answer: The constant stress is wearing me down.');
    expect(prompt).toContain('acceptance_notes: 允许正常时态和人称变化。');
    expect(prompt).toContain('source_example: Long-term stress wears you down.');
    expect(prompt).toContain('extra_examples_json: ["The noise wore him down."]');
    expect(prompt).toContain('user_answer: The stress wears me down.');
  });

  it('结果映射与 candidate：mock 用了 target → pass + segments/corrected；promptMeta 记录 key/version/hash/model', async () => {
    const { question } = await seedProductionQuestion();
    const runtime = buildMockRuntime();
    const answer = 'The pressure can wear down your patience.';
    const evaluation = await evaluateProduction({ db, runtime }, question, answer);

    expect(evaluation.result).toBe('pass');
    expect(evaluation.correctedSentence).toBe(answer);
    expect(evaluation.segments).toEqual([{ text: answer, type: 'same' }]);
    expect(evaluation.candidate.eligible).toBe(false); // mock 固定 eligible=false
    expect(evaluation.promptMeta).toEqual({
      key: 'check_production',
      version: 1,
      hash: loadPromptRegistry(join(process.cwd(), 'prompts')).get('check_production')!.hash,
      model: runtime.config.glmModels.air,
    });
  });

  it('未使用 target → fail，corrected=reference（segments 重建由 completeStructured 不变式保证）', async () => {
    const { question } = await seedProductionQuestion();
    const evaluation = await evaluateProduction(
      { db, runtime: buildMockRuntime() },
      question,
      'I am tired today.',
    );
    expect(evaluation.result).toBe('fail');
    expect(evaluation.correctedSentence).toBe('The constant stress is wearing me down.');
    expect(evaluation.segments).toEqual([
      { text: 'I am tired today.', type: 'delete' },
      { text: 'The constant stress is wearing me down.', type: 'insert' },
    ]);
  });

  it('AI 失败抛 AiStructuredError；runtime null → AI_PROVIDER_ERROR；payload 非法 → INTERNAL', async () => {
    const { question } = await seedProductionQuestion();
    await expect(
      evaluateProduction({ db, runtime: buildMockRuntime(throwingProvider()) }, question, 'x'),
    ).rejects.toThrow(/AI 结构化调用失败/);
    await expect(evaluateProduction({ db, runtime: null }, question, 'x')).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
    });

    db.update(questions)
      .set({ payloadJson: JSON.stringify({ mustUse: 'wear down' }) })
      .where(eq(questions.id, 'prod-q1'))
      .run();
    const broken = db.select().from(questions).where(eq(questions.id, 'prod-q1')).get()!;
    await expect(
      evaluateProduction({ db, runtime: buildMockRuntime() }, broken, 'x'),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('P 维度题型映射（productionQuestionTypeFor / questionTypesForDue）', () => {
  it('early(L1-2)→cloze、late(L4+)→production、确定性（同 itemId 同结果）', () => {
    expect(productionQuestionTypeFor('item-x', 1)).toBe('cloze');
    expect(productionQuestionTypeFor('item-x', 2)).toBe('cloze');
    expect(productionQuestionTypeFor('item-x', 4)).toBe('production');
    expect(productionQuestionTypeFor('item-x', 7)).toBe('production');
    expect(productionQuestionTypeFor('item-x', 4)).toBe(productionQuestionTypeFor('item-x', 4));
  });

  it('middle(L3) 按 itemId 哈希奇偶：不同 item 可落两种题型', () => {
    const results = new Set<string>();
    for (let i = 0; i < 50 && results.size < 2; i++) {
      results.add(productionQuestionTypeFor(`item-${i}`, 3));
    }
    expect(results).toEqual(new Set(['cloze', 'production']));
  });

  it('questionTypesForDue：U→understanding；P-L1/2→cloze；P-L3+→cloze+production', () => {
    expect(questionTypesForDue('understanding', 3)).toEqual(['understanding']);
    expect(questionTypesForDue('production', 1)).toEqual(['cloze']);
    expect(questionTypesForDue('production', 2)).toEqual(['cloze']);
    expect(questionTypesForDue('production', 3)).toEqual(['cloze', 'production']);
    expect(questionTypesForDue('production', 5)).toEqual(['cloze', 'production']);
  });
});
