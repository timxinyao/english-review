import { describe, expect, it } from 'vitest';
import type { GenerateReadResult } from '@el/shared';
import { checkAiOutput } from '../../src/ai/invariants.js';

/** 生成 n 个英文词的正文（含指定插入句） */
function bodyOf(n: number, insert = ''): string {
  const words = Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  return insert ? `${insert} ${words}` : words;
}

function readOutput(overrides: Partial<GenerateReadResult> = {}): GenerateReadResult {
  return {
    title: 'A Quiet Morning',
    type: 'story',
    body: bodyOf(200, 'The long week wore me down and the raw data made sense.'),
    coverage: [{ learning_item_id: 'item-1', surface_form: 'wore me down' }],
    checks: [
      {
        learning_item_id: 'item-1',
        question: '文中 wore me down 的意思是什么？',
        options: [
          { id: 'o1', text: '逐渐消耗' },
          { id: 'o2', text: '甲' },
          { id: 'o3', text: '乙' },
          { id: 'o4', text: '丙' },
        ],
        correct_option_id: 'o1',
      },
    ],
    ...overrides,
  };
}

const VARS = {
  content_level: 'B1',
  focus_items: [{ id: 'item-1', target: 'wear down', meaning: '逐渐消耗' }],
  old_items: [],
  recent_read_types: [],
};

describe('generateRead 机器不变式', () => {
  it('合法输出（词数/coverage/surface_form 实际出现/checks）无违规', () => {
    expect(checkAiOutput('generateRead', readOutput(), VARS)).toEqual([]);
  });

  it('surface_form 未出现在正文 → 违规', () => {
    const out = readOutput({
      coverage: [{ learning_item_id: 'item-1', surface_form: 'totally absent phrase' }],
    });
    const violations = checkAiOutput('generateRead', out, VARS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('totally absent phrase');
    expect(violations[0]).toContain('未出现在正文中');
  });

  it('surface_form 大小写不敏感匹配：正文大写、surface_form 小写 → 通过', () => {
    const out = readOutput({
      body: bodyOf(200, 'The long week WORE ME DOWN completely.'),
      coverage: [{ learning_item_id: 'item-1', surface_form: 'wore me down' }],
    });
    expect(checkAiOutput('generateRead', out, VARS)).toEqual([]);
  });

  it('focus item 缺 coverage 与词数越界各自独立报违规', () => {
    const out = readOutput({
      body: bodyOf(100),
      coverage: [],
    });
    const violations = checkAiOutput('generateRead', out, VARS);
    expect(violations.some((v) => v.includes('未出现在 coverage'))).toBe(true);
    expect(violations.some((v) => v.includes('超出 180–400'))).toBe(true);
  });
});
