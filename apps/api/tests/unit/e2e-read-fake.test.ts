import { describe, expect, it } from 'vitest';
import type { ReadSelection } from '../../src/modules/read/service.js';
import { fakeGenerateRead } from '../../scripts/e2e-server.js';
import { englishWordCount } from '../../src/ai/invariants.js';

const INPUT: ReadSelection = {
  focusItems: [
    { id: 'e2e-item-wear-down', target: 'wear down', meaning: '逐渐消耗' },
    { id: 'e2e-item-raw', target: 'raw', meaning: '未经处理的' },
    { id: 'e2e-item-make-sense', target: 'make sense', meaning: '讲得通' },
  ],
  oldItems: [{ id: 'e2e-item-stable', target: 'stable', meaning: '稳定的' }],
  contentLevel: 'B1',
  recentReadTypes: ['story', 'knowledge'],
};

describe('E2E fake read 生成（fakeGenerateRead，V2 纯阅读）', () => {
  it('确定性输出：标题/类型固定，正文含全部 focus 原词，3 段 ≥200 词，无 checks', async () => {
    const { data, meta, model } = await fakeGenerateRead(INPUT);

    expect(data.title).toBe('A Quiet Morning');
    expect(data.type).toBe('story');

    const paragraphs = data.body.split('\n\n');
    expect(paragraphs).toHaveLength(3);
    expect(englishWordCount(data.body)).toBeGreaterThanOrEqual(200);

    const bodyLower = data.body.toLowerCase();
    for (const f of INPUT.focusItems) {
      expect(bodyLower.includes(f.target.toLowerCase())).toBe(true);
    }

    // coverage：每个 focus 的 surface_form = target 原词
    expect(data.coverage).toEqual(
      INPUT.focusItems.map((f) => ({
        learning_item_id: f.id,
        surface_form: f.target,
      })),
    );

    // V2 纯阅读：不带 checks 字段
    expect('checks' in data).toBe(false);

    expect(meta).toEqual({ key: 'seed', version: 2, hash: 'seed' });
    expect(model).toBe('seed');
  });

  it('幂等：同输入重复调用返回完全一致的结果', async () => {
    const a = await fakeGenerateRead(INPUT);
    const b = await fakeGenerateRead(INPUT);
    expect(a).toEqual(b);
  });

  it('focus 数量为 1 时仍生成合法纯文章（≥200 词、coverage 覆盖）', async () => {
    const single: ReadSelection = {
      ...INPUT,
      focusItems: [{ id: 'x', target: 'stable', meaning: '稳定的' }],
    };
    const { data } = await fakeGenerateRead(single);
    expect(data.coverage).toEqual([{ learning_item_id: 'x', surface_form: 'stable' }]);
    expect('checks' in data).toBe(false);
    expect(englishWordCount(data.body)).toBeGreaterThanOrEqual(200);
  });
});
