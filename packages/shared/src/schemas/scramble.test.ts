import { describe, expect, it } from 'vitest';
import {
  AnswerRequest,
  AnswerResponse,
  PracticeAnswerResponse,
  GenerateProductionScrambleResult,
  ProductionQuestionView,
  ScramblePayload,
  ScrambleQuestionView,
} from '../index.js';

const fixturePayload = {
  schema: 'scramble_v1' as const,
  targets: [{ learningItemId: 'a', surface: 'wear down', tokens: ['wear', 'down'] }],
  zhPrompt: '长期开会让我很累。',
  referenceTokens: ['Long', 'meetings', 'really', 'wear', 'me', 'down'],
  distractors: ['out', 'tire'],
  acceptableMorphology: ['wear', 'wears'],
  acceptanceNotes: '',
};

describe('ScramblePayload', () => {
  it('accepts scramble_v1 fixture', () => {
    const parsed = ScramblePayload.parse(fixturePayload);
    expect(parsed.targets[0].tokens).toEqual(['wear', 'down']);
    expect(parsed.schema).toBe('scramble_v1');
  });

  it('rejects free-typing-shaped object as scramble', () => {
    expect(() =>
      ScramblePayload.parse({ schema: 'scramble_v1', mustUse: 'x', referenceAnswer: 'y' }),
    ).toThrow();
  });
});

describe('ScrambleQuestionView / ProductionQuestionView', () => {
  it('parses client-safe scramble view without referenceTokens', () => {
    const view = ScrambleQuestionView.parse({
      questionId: 'q1',
      kind: 'scramble',
      zhPrompt: fixturePayload.zhPrompt,
      targets: [{ learningItemId: 'a', surface: 'wear down' }],
      chips: ['me', 'Long', 'tire', 'wear', 'meetings', 'down', 'really', 'out'],
    });
    expect(view.kind).toBe('scramble');
    expect('referenceTokens' in view).toBe(false);
  });

  it('ProductionQuestionView accepts scramble kind', () => {
    const q = ProductionQuestionView.parse({
      questionId: 'q1',
      kind: 'scramble',
      zhPrompt: 'x',
      targets: [{ learningItemId: 'a', surface: 'wear down' }],
      chips: ['a', 'b'],
    });
    expect('kind' in q && q.kind).toBe('scramble');
  });

  it('ProductionQuestionView still accepts legacy typing shape during migration', () => {
    const q = ProductionQuestionView.parse({
      questionId: 'q1',
      zhPrompt: 'x',
      mustUse: 'wear down',
    });
    expect('mustUse' in q ? q.mustUse : null).toBe('wear down');
  });
});

describe('AnswerRequest selectedTokens', () => {
  it('accepts selectedTokens alone', () => {
    expect(
      AnswerRequest.parse({ selectedTokens: ['Long', 'meetings'] }).selectedTokens,
    ).toHaveLength(2);
  });

  it('rejects giveUp with selectedTokens', () => {
    expect(() => AnswerRequest.parse({ giveUp: true, selectedTokens: ['a'] })).toThrow();
  });
});

describe('GenerateProductionScrambleResult', () => {
  it('accepts AI generate shape', () => {
    const r = GenerateProductionScrambleResult.parse({
      zh_prompt: '长期开会让我很累。',
      reference_tokens: ['Long', 'meetings', 'really', 'wear', 'me', 'down'],
      distractors: ['out', 'tire'],
      acceptable_morphology: ['wear', 'wears'],
      acceptance_notes: '',
      target_surfaces: ['wear down'],
    });
    expect(r.reference_tokens).toHaveLength(6);
  });
});

describe('scramble payload integrity', () => {
  it('rejects duplicate target ids', () => {
    expect(
      ScramblePayload.safeParse({
        ...fixturePayload,
        targets: [fixturePayload.targets[0], fixturePayload.targets[0]],
      }).success,
    ).toBe(false);
  });
  it('rejects whitespace-only chips and surfaces', () => {
    expect(ScramblePayload.safeParse({ ...fixturePayload, referenceTokens: [' '] }).success).toBe(
      false,
    );
    expect(
      ScramblePayload.safeParse({
        ...fixturePayload,
        targets: [{ ...fixturePayload.targets[0], surface: ' ' }],
      }).success,
    ).toBe(false);
  });
});

it('accepts conservative per-target evidence in Today and Practice responses', () => {
  const evidence = [{ learningItemId: 'a', surface: 'wear down', result: 'basic_pass' }];
  expect(AnswerResponse.shape.itemResults.safeParse(evidence).success).toBe(true);
  expect(PracticeAnswerResponse.shape.itemResults.safeParse(evidence).success).toBe(true);
});
