import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createMockProvider } from '../../src/ai/provider/index.js';
import { generateProductionScramble } from '../../src/modules/questions/service.js';
import { buildMockRuntime, recordingProvider } from '../helpers/ai';
import { seedExample, seedItem } from '../helpers/seed';

let db: AppDatabase;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

async function seededItem(target: string, meaning: string): Promise<string> {
  const id = await seedItem(db, { type: 'chunk', target, meaning });
  await seedExample(db, id, 'source', `People often ${target} in daily life.`);
  return id;
}

/**
 * 回归（2026-10-28）：`X_json` 模板变量的契约是调用方传**未序列化**的 `X`，
 * renderPrompt 负责序列化。若调用方传预序列化的 `X_json` 字符串，真实模型会
 * 收到 `targets_json: null`（mock 直读 vars，测不出来）。这里固定渲染后的
 * Prompt 正文必须包含真实目标内容。
 */
describe('scramble generate prompt vars', () => {
  it('渲染后的 Prompt 正文携带真实 targets（而非 null）', async () => {
    const a = await seededItem('wear down', '逐渐消耗');
    const b = await seededItem('keep up', '跟上');
    const rec = recordingProvider(createMockProvider());
    const runtime = buildMockRuntime(rec.provider);

    await generateProductionScramble({ db, runtime }, [
      { id: a, type: 'chunk', target: 'wear down', meaning: '逐渐消耗' },
      { id: b, type: 'chunk', target: 'keep up', meaning: '跟上' },
    ]);

    expect(rec.prompts).toHaveLength(1);
    const text = rec.prompts[0]!;
    expect(text).toContain('wear down');
    expect(text).toContain('keep up');
    expect(text).not.toMatch(/targets_json:\s*null/);
  });
});
