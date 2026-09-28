import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { questions } from '../../src/db/schema.js';
import { acquireQuestion, generateQuestionsForItem } from '../../src/modules/questions/service.js';
import { buildMockRuntime } from '../helpers/ai';
import { seedExample, seedItem, seedQuestion } from '../helpers/seed.js';

let db: AppDatabase;
const NOW = new Date('2026-09-24T10:00:00.000Z');

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

describe('acquireQuestion excludeQuestionIds（撤销替代题取题排除）', () => {
  it('库存取题：排除指定题后取其余题；全部被排除返回 null 且不消耗库存', async () => {
    const itemId = await seedItem(db, { id: 'aq-1', target: 'wear down' });
    await seedQuestion(db, itemId, { id: 'aq-q1', type: 'understanding' });
    await seedQuestion(db, itemId, { id: 'aq-q2', type: 'understanding' });

    const got = acquireQuestion(db, itemId, 'understanding', NOW, ['aq-q1']);
    expect(got?.id).toBe('aq-q2');
    expect(got?.status).toBe('active');
    expect(got?.useCount).toBe(1);

    // 全部被排除 → 无替代题（撤销路径据此报可重试错误，不启动回滚）
    expect(acquireQuestion(db, itemId, 'understanding', NOW, ['aq-q1', 'aq-q2'])).toBeNull();
    // 排除不消耗库存：被排除的题保持原状
    expect(db.select().from(questions).where(eq(questions.id, 'aq-q1')).get()?.status).toBe(
      'fresh',
    );
    expect(db.select().from(questions).where(eq(questions.id, 'aq-q1')).get()?.useCount).toBe(0);
  });

  it('生成后取题（懒生成路径）：新生成的题同样服从排除', async () => {
    const itemId = await seedItem(db, { id: 'aq-2', target: 'raw' });
    await seedExample(db, itemId, 'source', 'This is a raw example.');

    // 无库存 → 生成后取题（today 的 acquireWithGenerate 第二跳）
    const generated = await generateQuestionsForItem(
      { db, runtime: buildMockRuntime() },
      itemId,
      'understanding',
      2,
    );
    expect(generated).toHaveLength(2);

    const first = acquireQuestion(db, itemId, 'understanding', NOW, [generated[1]!.id]);
    expect(first?.id).toBe(generated[0]!.id);
    expect(first?.id).not.toBe(generated[1]!.id);

    // 全部生成题都被排除（撤销时排除原题）→ null
    const second = acquireQuestion(
      db,
      itemId,
      'understanding',
      NOW,
      generated.map((q) => q.id),
    );
    expect(second).toBeNull();
  });
});
