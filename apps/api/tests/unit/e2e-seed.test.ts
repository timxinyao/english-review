import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { learningItems, questions, reviewStates, reviewTasks } from '../../src/db/schema.js';
import type { QuestionRow } from '../../src/modules/questions/service.js';
import {
  fakeEvaluateProduction,
  seedE2eData,
  seedLargeDueQueue,
  seedV2Journeys,
} from '../../scripts/e2e-server.js';
import { startTodaySession } from '../../src/modules/today/service.js';
import { createFakeDeps } from '../helpers/today-fakes.js';

let db: AppDatabase;
const NOW = new Date('2026-09-24T02:00:00.000Z');

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

describe('E2E 播种（seedE2eData）', () => {
  it('V2 种子仍提供 Production 键盘流程，但旧 cloze 不进入任务', async () => {
    seedE2eData(db, NOW);
    const session = await startTodaySession(db, createFakeDeps(), 'Asia/Shanghai', NOW);
    expect(session.status).toBe('active');
    if (session.status !== 'active') throw new Error('expected active');
    expect(session.progress.total).toBe(5);
    expect(session.currentTask).toMatchObject({
      taskType: 'production',
      item: { target: 'give up' },
    });
  });
  it('播种确定性数据：6 个 item、9 道题（含撤销替换题、V2 练习 Recall 题库与 make sense 表达库存）、7 行 review_states、文案符合规格', () => {
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
    expect(qs).toHaveLength(9);
    for (const q of qs) {
      expect([q.promptKey, String(q.promptVersion), q.promptHash, q.model]).toEqual([
        'seed',
        '1',
        'seed',
        'seed',
      ]);
    }
    // 除撤销替换题（active、lastUsedAt 置旧）外均为 fresh
    expect(qs.filter((q) => q.status === 'fresh')).toHaveLength(8);

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

    // Phase 9（Task 10）：make sense（chunk 默认开）的表达题库存（练一下第 2 题）
    const makeSenseP = qs.find((q) => q.id === 'e2e-q-make-sense-p')!;
    expect(makeSenseP.type).toBe('production');
    expect(makeSenseP.learningItemId).toBe('e2e-item-make-sense');
    expect(makeSenseP.status).toBe('fresh');
    expect(makeSenseP.meaningSnapshot).toBe('讲得通');
    expect(JSON.parse(makeSenseP.payloadJson)).toEqual({
      mustUse: 'make sense',
      referenceAnswer: 'His explanation makes complete sense to me.',
      acceptanceNotes: '允许正常时态和人称变化。',
    });
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

    // 撤销重练替换题（Phase 8）：active + lastUsedAt 置旧 → 主流程仍先取原题，撤销排除原题后才轮到它
    const q2 = db
      .select()
      .from(questions)
      .all()
      .find((x) => x.id === 'e2e-q-give-up-2')!;
    expect(q2.type).toBe('production');
    expect(q2.learningItemId).toBe(giveUp.id);
    expect(q2.status).toBe('active');
    expect(q2.promptText).toBe('他去年决定放弃吸烟。');
    expect(q2.lastUsedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(JSON.parse(q2.payloadJson)).toEqual({
      mustUse: 'give up',
      referenceAnswer: 'He decided to give up smoking last year.',
      acceptanceNotes: '允许正常时态和人称变化。',
    });
  });

  it('播种幂等：重复执行跳过，不产生重复行（含 give up 及替换题）', () => {
    expect(seedE2eData(db, NOW)).toBe(true);
    expect(seedE2eData(db, new Date('2026-09-25T00:00:00.000Z'))).toBe(false);
    expect(db.select().from(learningItems).all()).toHaveLength(6);
    expect(db.select().from(questions).all()).toHaveLength(9);
    expect(db.select().from(reviewStates).all()).toHaveLength(7);
  });
});

describe('E2E V2 journey 播种（Phase 9 Task 10）', () => {
  it('seedV2Journeys：set off 次日表达到期进队列、carry on 为 Learn、显式关闭的 put off 被排除', async () => {
    seedE2eData(db, NOW);
    expect(seedV2Journeys(db, NOW)).toBe(true);

    const session = await startTodaySession(db, createFakeDeps(), 'Asia/Shanghai', NOW);
    expect(session.status).toBe('active');
    if (session.status !== 'active') throw new Error('expected active');
    // 5 基础任务 + set off 的 P 任务 + carry on 的 Learn；put off（显式关闭）不进队列
    expect(session.progress.total).toBe(7);
    const putOffTasks = db
      .select()
      .from(reviewTasks)
      .all()
      .filter((t) => t.learningItemId === 'e2e-item-put-off');
    expect(putOffTasks).toHaveLength(0);
    const dimensions = db
      .select()
      .from(reviewTasks)
      .all()
      .map((t) => `${t.learningItemId}:${t.taskType}`)
      .sort();
    expect(dimensions).toContain('e2e-item-set-off:production');
    expect(dimensions).toContain('e2e-item-carry-on:learn');
    // put off 的 P 状态保持 L2 未被动过（排除≠清除）
    const putOffP = db
      .select()
      .from(reviewStates)
      .all()
      .find((s) => s.learningItemId === 'e2e-item-put-off' && s.dimension === 'production')!;
    expect(putOffP.level).toBe(2);
    expect(putOffP.nextReviewAt).toBe('2026-09-23T02:00:00.000Z');
  });

  it('seedV2Journeys 幂等：重复播种不产生重复行', () => {
    seedE2eData(db, NOW);
    expect(seedV2Journeys(db, NOW)).toBe(true);
    expect(seedV2Journeys(db, NOW)).toBe(false);
    expect(db.select().from(learningItems).all()).toHaveLength(9);
    expect(
      db
        .select()
        .from(questions)
        .all()
        .filter((q) => q.learningItemId === 'e2e-item-set-off'),
    ).toHaveLength(1);
  });

  it('seedLargeDueQueue：40 项全部进入 pending 队列，start 即时返回全量任务', async () => {
    seedE2eData(db, NOW);
    expect(seedLargeDueQueue(db, 40, NOW)).toBe(true);

    const session = await startTodaySession(db, createFakeDeps(), 'Asia/Shanghai', NOW);
    expect(session.status).toBe('active');
    if (session.status !== 'active') throw new Error('expected active');
    // 5 基础（4 到期 + gravity Learn）+ 40 大队列；全部以 pending 落库（无题目也不丢）
    expect(session.progress.total).toBe(45);
    expect(
      db
        .select()
        .from(reviewTasks)
        .all()
        .filter((t) => t.questionId === null),
    ).toHaveLength(45);

    expect(seedLargeDueQueue(db, 40, NOW)).toBe(false); // 幂等
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

  it('按 payload.mustUse 泛化：make sense / set off 种子题同规则判定', async () => {
    const makeSenseQuestion = {
      payloadJson: JSON.stringify({
        mustUse: 'make sense',
        referenceAnswer: 'His explanation makes complete sense to me.',
      }),
    } as unknown as QuestionRow;
    const pass = await fakeEvaluateProduction(
      null as never,
      makeSenseQuestion,
      'It does make sense to me.',
    );
    expect(pass.result).toBe('pass');
    const fail = await fakeEvaluateProduction(null as never, makeSenseQuestion, 'I understand it.');
    expect(fail.result).toBe('fail');
    expect(fail.correctedSentence).toBe('His explanation makes complete sense to me.');
  });
});
