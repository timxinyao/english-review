import { join } from 'node:path';
import { FALLBACK_MODELS } from '../../src/ai/models.js';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadPromptRegistry } from '../../src/ai/promptRegistry.js';
import { createMockProvider } from '../../src/ai/provider/index.js';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { questions, settings } from '../../src/db/schema.js';
import {
  countQuestionStock,
  generateQuestionsForItem,
  type QuestionRow,
} from '../../src/modules/questions/service.js';
import { buildMockRuntime, recordingProvider, throwingProvider } from '../helpers/ai';
import { seedExample, seedItem, seedQuestion } from '../helpers/seed.js';

let db: AppDatabase;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

async function seededItem(): Promise<{ id: string; target: string; meaning: string }> {
  const id = await seedItem(db, { type: 'chunk', target: 'wear down', meaning: '逐渐消耗' });
  await seedExample(db, id, 'source', 'Long-term stress wears you down.');
  await seedExample(db, id, 'extra', 'The noise wore him down.', { sortOrder: 0 });
  await seedExample(db, id, 'extra', 'Slowly it wears you down.', { sortOrder: 1 });
  return { id, target: 'wear down', meaning: '逐渐消耗' };
}

function rowsFor(itemId: string): QuestionRow[] {
  return db.select().from(questions).where(eq(questions.learningItemId, itemId)).all();
}

/** 记录渲染后 Prompt 的 mock runtime */
function recordingMockRuntime(): {
  runtime: ReturnType<typeof buildMockRuntime>;
  prompts: string[];
} {
  const rec = recordingProvider(createMockProvider());
  return { runtime: buildMockRuntime(rec.provider), prompts: rec.prompts };
}

describe('generateQuestionsForItem：understanding', () => {
  it('mock runtime 生成并入库，字段完整且 prompt 元数据来自 Registry', async () => {
    const item = await seededItem();
    const runtime = buildMockRuntime();
    const rows = await generateQuestionsForItem({ db, runtime }, item.id, 'understanding', 2);

    expect(rows).toHaveLength(2);
    const registry = loadPromptRegistry(join(process.cwd(), 'prompts'));
    const prompt = registry.get('generate_understanding')!;

    for (const row of rows) {
      expect(row.type).toBe('understanding');
      expect(row.status).toBe('fresh');
      expect(row.meaningSnapshot).toBe(item.meaning);
      expect(row.promptKey).toBe('generate_understanding');
      expect(row.promptVersion).toBe(prompt.version);
      expect(row.promptHash).toBe(prompt.hash);
      expect(row.model).toBe(FALLBACK_MODELS.flash); // 无 key 环境 → fallback 常量（自动发现不可用）
      expect(row.useCount).toBe(0);
      expect(row.correctCount).toBe(0);
      expect(row.lastUsedAt).toBeNull();
      expect(row.retiredAt).toBeNull();
      // 选择题 payload：4 选项 + 正确选项 id
      const payload = JSON.parse(row.payloadJson) as { options: { id: string }[] };
      expect(payload.options).toHaveLength(4);
      expect(row.correctOptionId).toBe('o2');
      expect(row.contextText).toBeTruthy();
      expect(row.promptText).toBeTruthy();
    }

    // 已持久化
    expect(rowsFor(item.id)).toHaveLength(2);
    expect(countQuestionStock(db, item.id, 'understanding')).toBe(2);
  });
});

describe('generateQuestionsForItem：cloze', () => {
  it('生成填空题：payload 含 acceptedAnswers、correctOptionId 为空、promptText 含空格占位', async () => {
    const item = await seededItem();
    const rows = await generateQuestionsForItem(
      { db, runtime: buildMockRuntime() },
      item.id,
      'cloze',
      2,
    );

    expect(rows).toHaveLength(2);
    const registry = loadPromptRegistry(join(process.cwd(), 'prompts'));
    const prompt = registry.get('generate_cloze')!;
    for (const row of rows) {
      expect(row.type).toBe('cloze');
      expect(row.promptKey).toBe('generate_cloze');
      expect(row.promptVersion).toBe(prompt.version);
      expect(row.promptHash).toBe(prompt.hash);
      expect(row.correctOptionId).toBeNull();
      expect(row.promptText).toContain('____');
      expect(row.meaningSnapshot).toBe(item.meaning);
      const payload = JSON.parse(row.payloadJson) as { acceptedAnswers: string[] };
      expect(payload.acceptedAnswers.length).toBeGreaterThanOrEqual(1);
      expect(payload.acceptedAnswers).toContain(item.target); // mock 以 target 为答案
    }
    expect(rowsFor(item.id)).toHaveLength(2);
  });
});

describe('generateQuestionsForItem：变量组装', () => {
  it('content_level 读 settings 表（缺省 B1）', async () => {
    const item = await seededItem();
    const { runtime, prompts } = recordingMockRuntime();
    await generateQuestionsForItem({ db, runtime }, item.id, 'understanding', 1);
    expect(prompts[0]).toContain('content_level: B1');
  });

  it('content_level 透传 settings 覆盖值', async () => {
    const item = await seededItem();
    db.insert(settings)
      .values({ id: 1, contentLevel: 'B2', updatedAt: new Date().toISOString() })
      .run();
    const { runtime, prompts } = recordingMockRuntime();
    await generateQuestionsForItem({ db, runtime }, item.id, 'understanding', 1);
    expect(prompts[0]).toContain('content_level: B2');
  });

  it('recent_question_summaries 携带该 item 该 type 最近题目的摘要', async () => {
    const item = await seededItem();
    await seedQuestion(db, item.id, {
      type: 'understanding',
      contextText: 'Old context sentence.',
      promptText: 'Old question line.',
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    const { runtime, prompts } = recordingMockRuntime();
    await generateQuestionsForItem({ db, runtime }, item.id, 'understanding', 1);
    expect(prompts[0]).toContain('Old context sentence. | Old question line.');
  });

  it('source_example 与 extra_examples 传入 Prompt', async () => {
    const item = await seededItem();
    const { runtime, prompts } = recordingMockRuntime();
    await generateQuestionsForItem({ db, runtime }, item.id, 'understanding', 1);
    const prompt = prompts[0]!;
    expect(prompt).toContain('Long-term stress wears you down.');
    expect(prompt).toContain('The noise wore him down.');
    expect(prompt).toContain('逐渐消耗');
    expect(prompt).toContain('item_type: chunk');
  });
});

describe('generateQuestionsForItem：失败路径', () => {
  it('provider 失败抛错且不入库', async () => {
    const item = await seededItem();
    await expect(
      generateQuestionsForItem(
        { db, runtime: buildMockRuntime(throwingProvider()) },
        item.id,
        'understanding',
        2,
      ),
    ).rejects.toThrow(/AI 结构化调用失败/);
    expect(countQuestionStock(db, item.id, 'understanding')).toBe(0);
  });

  it('学习项不存在 → NOT_FOUND', async () => {
    await expect(
      generateQuestionsForItem(
        { db, runtime: buildMockRuntime() },
        'no-such-item',
        'understanding',
        1,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('runtime 为 null → AI_PROVIDER_ERROR', async () => {
    const item = await seededItem();
    await expect(
      generateQuestionsForItem({ db, runtime: null }, item.id, 'understanding', 1),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' });
  });

  it('count <= 0 直接返回空数组，不调用 AI', async () => {
    const item = await seededItem();
    const { runtime, prompts } = recordingMockRuntime();
    const rows = await generateQuestionsForItem({ db, runtime }, item.id, 'understanding', 0);
    expect(rows).toEqual([]);
    expect(prompts).toEqual([]);
    expect(countQuestionStock(db, item.id, 'understanding')).toBe(0);
  });
});
