import { describe, expect, it } from 'vitest';
import { judgeScramble, normalizeToken } from '../../src/modules/questions/scramble-judge.js';

describe('normalizeToken', () => {
  it('lowercases and strips trailing punctuation', () => {
    expect(normalizeToken('Wear.')).toBe('wear');
    expect(normalizeToken('  DOWN! ')).toBe('down');
  });
});

describe('judgeScramble', () => {
  const targets = [
    { learningItemId: 'd', tokens: ['wear', 'down'] },
    { learningItemId: 'a', tokens: ['meetings'] },
  ];
  const ref = ['Long', 'meetings', 'really', 'wear', 'me', 'down'];

  it('all targets pass when full sentence matches', () => {
    const out = judgeScramble({
      selectedTokens: ref,
      referenceTokens: ref,
      targets,
      acceptableMorphology: ['wear', 'wears'],
    });
    expect(out.taskResult).toBe('pass');
    expect(out.itemResults.every((r) => r.result === 'pass')).toBe(true);
  });

  it('gives only correctly positioned targets partial evidence', () => {
    const selected = ['Long', 'meetings', 'really', 'tire', 'me', 'out'];
    const out = judgeScramble({
      selectedTokens: selected,
      referenceTokens: ref,
      targets,
      acceptableMorphology: [],
    });
    expect(out.itemResults.find((r) => r.learningItemId === 'd')?.result).toBe('fail');
    expect(out.itemResults.find((r) => r.learningItemId === 'a')?.result).toBe('basic_pass');
    expect(out.taskResult).toBe('fail');
  });

  it('does not accept unverified morphology substitutions', () => {
    const selected = ['Long', 'meetings', 'really', 'wears', 'me', 'down'];
    const out = judgeScramble({
      selectedTokens: selected,
      referenceTokens: ref,
      targets,
      acceptableMorphology: ['wear', 'wears'],
    });
    expect(out.itemResults.find((r) => r.learningItemId === 'd')?.result).toBe('fail');
    expect(out.taskResult).toBe('fail');
  });

  it('empty selected fails all', () => {
    const out = judgeScramble({
      selectedTokens: [],
      referenceTokens: ref,
      targets,
      acceptableMorphology: [],
    });
    expect(out.taskResult).toBe('fail');
    expect(out.itemResults.every((r) => r.result === 'fail')).toBe(true);
  });

  it('incomplete target fragments fail every item', () => {
    const selected = ['meetings', 'wear', 'down', 'extra'];
    const out = judgeScramble({
      selectedTokens: selected,
      referenceTokens: ref,
      targets,
      acceptableMorphology: [],
    });
    expect(out.itemResults.every((r) => r.result === 'fail')).toBe(true);
    expect(out.taskResult).toBe('fail');
  });
});
