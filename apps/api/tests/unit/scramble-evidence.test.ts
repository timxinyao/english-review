import { describe, expect, it } from 'vitest';
import { judgeScramble } from '../../src/modules/questions/scramble-judge.js';

const referenceTokens = ['Long', 'meetings', 'really', 'wear', 'me', 'down'];
const targets = [
  { learningItemId: 'meetings', tokens: ['meetings'] },
  { learningItemId: 'wear-down', tokens: ['wear', 'down'] },
];
function judge(selectedTokens: string[], acceptableMorphology: string[] = []) {
  return judgeScramble({ selectedTokens, referenceTokens, targets, acceptableMorphology });
}

describe('scramble evidence is not free-form production mastery', () => {
  it('bare target fragments cannot earn Good on any item', () => {
    expect(judge(['meetings', 'wear', 'down']).itemResults).toEqual([
      { learningItemId: 'meetings', result: 'fail' },
      { learningItemId: 'wear-down', result: 'fail' },
    ]);
  });
  it('complete imperfect assembly gives Hard only to correctly located target evidence', () => {
    expect(judge(['Long', 'meetings', 'really', 'down', 'me', 'wear'])).toEqual({
      taskResult: 'fail',
      itemResults: [
        { learningItemId: 'meetings', result: 'basic_pass' },
        { learningItemId: 'wear-down', result: 'fail' },
      ],
    });
  });
  it('a flat morphology list cannot make different words interchangeable', () => {
    const result = judge(
      ['Long', 'wear', 'really', 'meetings', 'me', 'down'],
      ['wear', 'wears', 'meetings', 'meeting'],
    );
    expect(result.taskResult).toBe('fail');
    expect(result.itemResults.every((r) => r.result === 'fail')).toBe(true);
  });
  it('wrong target placement does not get credit merely for containing its tokens', () => {
    expect(
      judge(['meetings', 'Long', 'really', 'me', 'wear', 'down']).itemResults.every(
        (r) => r.result === 'fail',
      ),
    ).toBe(true);
  });
  it('punctuation and capitalization do not penalize an exact valid assembly', () => {
    expect(judge(['long', 'Meetings', 'really', 'wear', 'me', 'down.']).taskResult).toBe('pass');
  });
});
