import { describe, expect, it } from 'vitest';
import { CheckProductionResult } from '@el/shared';

function output(overrides: Record<string, unknown> = {}) {
  return {
    result: 'pass',
    corrected_sentence: 'We are glad to welcome our honored guests.',
    segments: [{ text: 'We are glad to welcome our honored guests.', type: 'same' }],
    explanation: '表达正确。',
    better_version: 'We are delighted to welcome our honored guests.',
    better_version_kind: 'polish',
    personal_example_candidate: {
      eligible: true,
      source: 'better',
      quality_score: 0.9,
      reason: '目标使用自然，句子具体且可复用。',
    },
    ...overrides,
  };
}

describe('CheckProductionResult source/kind contract', () => {
  it('接受以 polish 作为 better 候选的组合', () => {
    expect(CheckProductionResult.safeParse(output()).success).toBe(true);
  });

  it('better_version 与 better_version_kind 必须同时存在或同时为空', () => {
    expect(CheckProductionResult.safeParse(output({ better_version_kind: null })).success).toBe(
      false,
    );
    expect(
      CheckProductionResult.safeParse(
        output({
          better_version: null,
          better_version_kind: null,
          personal_example_candidate: {
            ...output().personal_example_candidate,
            source: 'corrected',
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      CheckProductionResult.safeParse({
        ...output({ better_version: null, better_version_kind: null }),
        personal_example_candidate: {
          ...output().personal_example_candidate,
          source: 'better',
        },
      }).success,
    ).toBe(false);
  });

  it('eligible 必须与 corrected/better source 选择一致', () => {
    expect(
      CheckProductionResult.safeParse(
        output({
          personal_example_candidate: { ...output().personal_example_candidate, source: null },
        }),
      ).success,
    ).toBe(false);
    expect(
      CheckProductionResult.safeParse(
        output({
          personal_example_candidate: {
            ...output().personal_example_candidate,
            eligible: false,
            source: null,
          },
        }),
      ).success,
    ).toBe(true);
  });

  it('rewrite 参考表达只能留在历史展示，不能被选作 personal example', () => {
    const rewrite = output({
      better_version_kind: 'rewrite',
      personal_example_candidate: {
        ...output().personal_example_candidate,
        source: 'corrected',
      },
    });
    expect(CheckProductionResult.safeParse(rewrite).success).toBe(true);
    expect(
      CheckProductionResult.safeParse({
        ...rewrite,
        personal_example_candidate: {
          ...rewrite.personal_example_candidate,
          source: 'better',
        },
      }).success,
    ).toBe(false);
  });

  it('fail 批改不能输出 eligible 候选', () => {
    expect(CheckProductionResult.safeParse(output({ result: 'fail' })).success).toBe(false);
  });

  it('不允许把空白句子作为 better 或 corrected 个人例句候选', () => {
    expect(CheckProductionResult.safeParse(output({ better_version: '   ' })).success).toBe(false);
    expect(
      CheckProductionResult.safeParse(
        output({
          corrected_sentence: '  ',
          better_version: null,
          better_version_kind: null,
          personal_example_candidate: {
            ...output().personal_example_candidate,
            source: 'corrected',
          },
        }),
      ).success,
    ).toBe(false);
  });
});
