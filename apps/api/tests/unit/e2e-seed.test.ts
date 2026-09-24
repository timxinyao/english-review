import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { learningItems, questions, reviewStates } from '../../src/db/schema.js';
import type { QuestionRow } from '../../src/modules/questions/service.js';
import { fakeEvaluateProduction, seedE2eData } from '../../scripts/e2e-server.js';

let db: AppDatabase;
const NOW = new Date('2026-09-24T02:00:00.000Z');

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

describe('E2E 播种（seedE2eData）', () => {
  it('播种确定性数据：6 个 item、6 道题、7 行 review_states、文案符合规格', () => {
    const seeded = seedE2eData(db, NOW);
    expect(seeded).toBe(true);

    const items = db.select().from(learningItems).all();
    expect(items.map((i) => i.target).sort()).toEqual([
      'give up',
      'gravity',
      'make sense',
      'raw',
      'stable',
      'wear down',
    ]);
    expect(items.every((i) => i.status === 'active')).toBe(true);
    expect(items.find((i) => i.target === 'gravity')?.queueState).toBe('new');
    expect(items.filter((i) => i.queueState === 'started')).toHaveLength(5);

    const qs = db.select().from(questions).all();
    expect(qs).toHaveLength(6);
    for (const q of qs) {
      expect(q.status).toBe('fresh');
      expect([q.promptKey, String(q.promptVersion), q.promptHash, q.model]).toEqual([
        'seed',
        '1',
        'seed',
        'seed',
      ]);
    }

    const stable = qs.find((q) => q.id === 'e2e-q-stable')!;
    expect(stable.contextText).toBe('The connection is finally ____.');
    expect(stable.promptText).toBe('stable 在这里最接近什么意思？');
    expect(stable.correctOptionId).toBe('o1');
    expect(JSON.parse(stable.payloadJson)).toEqual({
      options: [
        { id: 'o1', text: '稳定的' },
        { id: 'o2', text: '快速的' },
        { id: 'o3', text: '昂贵的' },
        { id: 'o4', text: '危险的' },
      ],
      explanation: 'stable 表示稳定。',
    });

    const raw = qs.find((q) => q.id === 'e2e-q-raw')!;
    expect(raw.type).toBe('cloze');
    expect(raw.promptText).toBe('We need the ____ data before processing.');
    expect(raw.contextText).toBeNull();
    expect(JSON.parse(raw.payloadJson)).toEqual({
      acceptedAnswers: ['raw'],
      explanation: 'raw 表示未经处理的。',
    });

    const gravity = qs.find((q) => q.id === 'e2e-q-gravity')!;
    expect(JSON.parse(gravity.payloadJson)).toEqual({
      options: [
        { id: 'o1', text: '重力' },
        { id: 'o2', text: '声音' },
        { id: 'o3', text: '光线' },
        { id: 'o4', text: '时间' },
      ],
      explanation: 'gravity 是重力。',
    });

    // 到期设置：昨日到期（相对 NOW）
    const states = db.select().from(reviewStates).all();
    expect(states).toHaveLength(7);
    const dueYesterday = states.filter((s) => s.nextReviewAt === '2026-09-23T02:00:00.000Z');
    expect(dueYesterday.map((s) => s.learningItemId).sort()).toEqual([
      'e2e-item-give-up',
      'e2e-item-make-sense',
      'e2e-item-raw',
      'e2e-item-stable',
      'e2e-item-wear-down',
    ]);
    // raw 的 U 维度未到期
    expect(
      states.find((s) => s.learningItemId === 'e2e-item-raw' && s.dimension === 'understanding')
        ?.nextReviewAt,
    ).toBe('2026-10-01T02:00:00.000Z');
    // stable U L3
    expect(states.find((s) => s.learningItemId === 'e2e-item-stable')?.level).toBe(3);
  });

  it('give up 种子：U=L7 stable（不到期）、P=L4 昨日到期、production 题内容与元数据', () => {
    seedE2eData(db, NOW);
    const giveUp = db
      .select()
      .from(learningItems)
      .all()
      .find((i) => i.target === 'give up')!;
    expect(giveUp.type).toBe('word');
    expect(giveUp.meaning).toBe('放弃');
    expect(giveUp.queueState).toBe('started');

    const u = db
      .select()
      .from(reviewStates)
      .all()
      .find((s) => s.learningItemId === giveUp.id && s.dimension === 'understanding')!;
    const p = db
      .select()
      .from(reviewStates)
      .all()
      .find((s) => s.learningItemId === giveUp.id && s.dimension === 'production')!;
    expect(u.level).toBe(7);
    expect(u.stable).toBe(1);
    expect(u.nextReviewAt).toBeNull();
    expect(p.level).toBe(4);
    expect(p.stable).toBe(0);
    expect(p.nextReviewAt).toBe('2026-09-23T02:00:00.000Z'); // due yesterday

    const q = db
      .select()
      .from(questions)
      .all()
      .find((x) => x.id === 'e2e-q-give-up')!;
    expect(q.type).toBe('production');
    expect(q.learningItemId).toBe(giveUp.id);
    expect(q.promptText).toBe('长期的压力让我想放弃。');
    expect(q.contextText).toBeNull();
    expect(q.correctOptionId).toBeNull();
    expect(q.meaningSnapshot).toBe('放弃');
    expect(JSON.parse(q.payloadJson)).toEqual({
      mustUse: 'give up',
      referenceAnswer: 'The constant stress makes me want to give up.',
      acceptanceNotes: '允许正常时态和人称变化。',
    });
  });

  it('播种幂等：重复执行跳过，不产生重复行（含 give up）', () => {
    expect(seedE2eData(db, NOW)).toBe(true);
    expect(seedE2eData(db, new Date('2026-09-25T00:00:00.000Z'))).toBe(false);
    expect(db.select().from(learningItems).all()).toHaveLength(6);
    expect(db.select().from(questions).all()).toHaveLength(6);
    expect(db.select().from(reviewStates).all()).toHaveLength(7);
  });
});

describe('E2E fake 批改（fakeEvaluateProduction）', () => {
  const question = {
    payloadJson: JSON.stringify({
      mustUse: 'give up',
      referenceAnswer: 'The constant stress makes me want to give up.',
      acceptanceNotes: '允许正常时态和人称变化。',
    }),
  } as unknown as QuestionRow;

  it('答案包含 give up → pass，corrected=原句，eligible 候选', async () => {
    const answer = 'The pressure made me  Want To GIVE UP .';
    const r = await fakeEvaluateProduction(null as never, question, answer);
    expect(r.result).toBe('pass');
    expect(r.correctedSentence).toBe(answer);
    expect(r.segments).toEqual([{ text: answer, type: 'same' }]);
    expect(r.explanation).toBe('目标表达使用正确。');
    expect(r.betterVersion).toBeNull();
    expect(r.candidate).toEqual({ eligible: true, qualityScore: 0.9, reason: 'seed' });
    expect(r.promptMeta).toEqual({ key: 'seed', version: 1, hash: 'seed', model: 'seed' });
  });

  it('未使用 give up → fail，corrected=reference， ineligible', async () => {
    const answer = 'I quit the job.';
    const r = await fakeEvaluateProduction(null as never, question, answer);
    expect(r.result).toBe('fail');
    expect(r.correctedSentence).toBe('The constant stress makes me want to give up.');
    expect(r.segments).toEqual([
      { text: answer, type: 'delete' },
      { text: 'The constant stress makes me want to give up.', type: 'insert' },
    ]);
    expect(r.explanation).toBe('未使用目标表达。');
    expect(r.candidate).toEqual({ eligible: false, qualityScore: 0, reason: 'seed' });
  });
});
