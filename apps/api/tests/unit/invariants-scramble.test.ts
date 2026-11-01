import { describe, expect, it } from 'vitest';
import type { GenerateProductionScrambleResult } from '@el/shared';
import { checkAiOutput } from '../../src/ai/invariants.js';

function scrambleOutput(
  overrides: Partial<GenerateProductionScrambleResult> = {},
): GenerateProductionScrambleResult {
  return {
    zh_prompt: '长期开会让我很累。',
    reference_tokens: ['Long', 'meetings', 'really', 'wear', 'me', 'down'],
    distractors: ['out', 'tire'],
    acceptable_morphology: ['wear', 'wears'],
    acceptance_notes: '',
    target_surfaces: ['wear down'],
    ...overrides,
  };
}

const VARS = {
  targets: [{ id: 'item-1', type: 'chunk', target: 'wear down', meaning: '逐渐消耗' }],
  content_level: 'B1',
};

describe('generateProductionScramble 机器不变式', () => {
  it('合法输出（字典形按序覆盖 + echo 一致）无违规', () => {
    expect(checkAiOutput('generateProductionScramble', scrambleOutput(), VARS)).toEqual([]);
  });

  it('reference 屈折变形（wears）替代字典形（wear）→ 违规', () => {
    const out = scrambleOutput({
      reference_tokens: ['Long', 'meetings', 'really', 'wears', 'me', 'down'],
    });
    const violations = checkAiOutput('generateProductionScramble', out, VARS);
    expect(violations.some((v) => v.includes('未按序覆盖'))).toBe(true);
  });

  it('模型改写 echo surface（got our butts kicked）→ 违规：即使 reference 与改写形自洽', () => {
    // 2026-10-29 生产事故：模型把 target_surfaces 改写成句子里的屈折形，
    // 旧校验只对比模型自己的 echo 与 reference（自指），改写形照样通过并入库。
    const vars = {
      targets: [{ id: 'item-1', type: 'chunk', target: "get one's butt kicked", meaning: '被狠狠打败' }],
      content_level: 'A2',
    };
    const out = scrambleOutput({
      reference_tokens: ['We', 'got', 'our', 'butts', 'kicked', 'in', 'the', 'game'],
      target_surfaces: ['got our butts kicked'],
      distractors: ['beaten', 'badly'],
    });
    const violations = checkAiOutput('generateProductionScramble', out, vars);
    expect(violations.some((v) => v.includes('原样回显字典形'))).toBe(true);
    expect(violations.some((v) => v.includes("get one's butt kicked"))).toBe(true);
  });

  it('代词替换（his 替代 one\'s）→ 违规：字典形必须逐词字面覆盖', () => {
    const vars = {
      targets: [{ id: 'item-1', type: 'chunk', target: "get one's butt kicked", meaning: '被狠狠打败' }],
      content_level: 'A2',
    };
    const out = scrambleOutput({
      reference_tokens: ['He', 'will', 'get', 'his', 'butt', 'kicked', 'in', 'the', 'game'],
      target_surfaces: ["get one's butt kicked"],
      distractors: ['beat'],
    });
    const violations = checkAiOutput('generateProductionScramble', out, vars);
    expect(violations.some((v) => v.includes('未按序覆盖'))).toBe(true);
  });

  it('大小写不敏感：reference 句首大写 Doze 仍算覆盖字典形 doze', () => {
    const vars = {
      targets: [{ id: 'item-1', type: 'chunk', target: 'doze off', meaning: '打瞌睡' }],
      content_level: 'A2',
    };
    const out = scrambleOutput({
      reference_tokens: ['Doze', 'off', 'happens', 'in', 'boring', 'meetings'],
      target_surfaces: ['doze off'],
      distractors: ['sleep', 'nap'],
    });
    expect(checkAiOutput('generateProductionScramble', out, vars)).toEqual([]);
  });

  it('vars.targets 缺失 → fail-closed 违规（不允许跳过字典形校验）', () => {
    const violations = checkAiOutput('generateProductionScramble', scrambleOutput(), {});
    expect(violations.some((v) => v.includes('targets'))).toBe(true);
  });

  it('句式 target（Is it just me, or...?）：echo 丢省略号/标点 → 逐词归一化后仍通过', () => {
    const vars = {
      targets: [{ id: 'item-1', type: 'chunk', target: 'Is it just me, or...?', meaning: '是只有我，还是……' }],
      content_level: 'B1',
    };
    const out = scrambleOutput({
      reference_tokens: ['Is', 'it', 'just', 'me', 'or', 'does', 'everyone', 'feel', 'tired'],
      target_surfaces: ['Is it just me or'],
      distractors: ['are', 'we'],
    });
    expect(checkAiOutput('generateProductionScramble', out, vars)).toEqual([]);
  });

  it('句式 target 扩词（I\'m good on coffee ≠ I\'m good on...）→ 违规', () => {
    const vars = {
      targets: [{ id: 'item-1', type: 'chunk', target: "I'm good on...", meaning: '……我够了/不用了' }],
      content_level: 'B1',
    };
    const out = scrambleOutput({
      reference_tokens: ["I'm", 'good', 'on', 'coffee', 'thanks'],
      target_surfaces: ["I'm good on coffee"],
      distractors: ['tea', 'bad'],
    });
    const violations = checkAiOutput('generateProductionScramble', out, vars);
    expect(violations.some((v) => v.includes('原样回显字典形'))).toBe(true);
  });
});
