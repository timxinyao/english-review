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

describe('E2E fake read 生成（fakeGenerateRead）', () => {
  it('确定性输出：标题/类型固定，正文含全部 focus 原词，3 段 ≥200 词', async () => {
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

    // checks：前 2 个 focus，o1=meaning 正确
    expect(data.checks).toHaveLength(2);
    expect(data.checks[0]).toMatchObject({
      learning_item_id: 'e2e-item-wear-down',
      question: '文中 wear down 的意思是什么？',
      correct_option_id: 'o1',
    });
    expect(data.checks[0]!.options[0]).toEqual({ id: 'o1', text: '逐渐消耗' });
    expect(data.checks[1]!.learning_item_id).toBe('e2e-item-raw');

    expect(meta).toEqual({ key: 'seed', version: 1, hash: 'seed' });
    expect(model).toBe('seed');
  });

  it('幂等：同输入重复调用返回完全一致的结果', async () => {
    const a = await fakeGenerateRead(INPUT);
    const b = await fakeGenerateRead(INPUT);
    expect(a).toEqual(b);
  });

  it('focus 数量不足 2 时 checks 取实际数量（≥1）', async () => {
    const single: ReadSelection = {
      ...INPUT,
      focusItems: [{ id: 'x', target: 'stable', meaning: '稳定的' }],
    };
    const { data } = await fakeGenerateRead(single);
    expect(data.checks).toHaveLength(1);
    expect(englishWordCount(data.body)).toBeGreaterThanOrEqual(200);
  });
});
