import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Rating } from 'ts-fsrs';
import { createDatabase, rawSqlite, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  appMetadata,
  attempts,
  learningItems,
  questions,
  reviewStates,
} from '../../src/db/schema.js';
import { advanceCard, newCard, replayRatings } from '../../src/modules/review/fsrs-engine.js';
import { applyFsrsCutover, estimateFsrsFromLegacy } from '../../src/modules/review/fsrs-cutover.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const DAY_MS = 86_400_000;

function iso(t: Date): string {
  return t.toISOString();
}

function state(db: AppDatabase, itemId: string, dimension: string) {
  return (
    db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, itemId))
      .all()
      .find((row) => row.dimension === dimension) ?? null
  );
}

function itemStatus(db: AppDatabase, itemId: string): string {
  return db.select().from(learningItems).where(eq(learningItems.id, itemId)).get()!.status;
}

describe('estimateFsrsFromLegacy（旧备份等级折算）', () => {
  it('level=0 未激活：D/S NULL；1..7 映射阶梯间隔；difficulty 恒为中值 5；reps=level；lapses=0', () => {
    expect(estimateFsrsFromLegacy(0, false)).toEqual({
      difficulty: null,
      stability: null,
      reps: 0,
      lapses: 0,
    });
    expect(estimateFsrsFromLegacy(null, null)).toEqual({
      difficulty: null,
      stability: null,
      reps: 0,
      lapses: 0,
    });
    expect(estimateFsrsFromLegacy(1, false)).toMatchObject({
      difficulty: 5,
      stability: 1,
      reps: 1,
    });
    expect(estimateFsrsFromLegacy(2, false)).toMatchObject({ stability: 3, reps: 2, lapses: 0 });
    expect(estimateFsrsFromLegacy(3, false)).toMatchObject({ stability: 7 });
    expect(estimateFsrsFromLegacy(4, false)).toMatchObject({ stability: 14 });
    expect(estimateFsrsFromLegacy(5, false)).toMatchObject({ stability: 30 });
    expect(estimateFsrsFromLegacy(6, false)).toMatchObject({ stability: 60 });
    expect(estimateFsrsFromLegacy(7, false)).toMatchObject({ stability: 120 });
  });

  it('stable=true 优先：无论 level 直接过掌握线 S=120；level 越界 clamp 到 [0,7]', () => {
    expect(estimateFsrsFromLegacy(2, true)).toMatchObject({
      difficulty: 5,
      stability: 120,
      reps: 2,
    });
    expect(estimateFsrsFromLegacy(0, true)).toMatchObject({ stability: 120, reps: 0 });
    expect(estimateFsrsFromLegacy(9, false)).toMatchObject({ stability: 120, reps: 9 });
    expect(estimateFsrsFromLegacy(-3, false)).toMatchObject({ stability: null, reps: -3 });
  });
});

describe('applyFsrsCutover（一次性回放迁移）', () => {
  it('混合种子：U/P 行按时间序回放重建、跳过类不影响、无 attempts 行不动、status 按 S≥120 重算、二次运行 no-op', () => {
    const db = createDatabase(':memory:');
    runMigrations(db);

    // ---- alpha：word（production 默认关闭）。U 无既有行（覆盖插入路径），P 无既有行 ----
    const alpha = 'item-alpha';
    seedItemSync(db, alpha, { target: 'alpha' });
    const alphaUq = seedQuestionSync(db, alpha, { type: 'understanding' });
    const alphaPq = seedQuestionSync(db, alpha, { type: 'production' });
    // 乱序插入：实际顺序 T1(Good) → T2(Easy) → T3(Hard) → T4(Again)
    insertAttempt(db, alpha, alphaUq, 'today', 'basic_pass', new Date(NOW.getTime() + 3 * DAY_MS)); // T3
    insertAttempt(db, alpha, alphaUq, 'today', 'pass', NOW, null); // T1 Good
    insertAttempt(db, alpha, alphaUq, 'today', 'fail', new Date(NOW.getTime() + 5 * DAY_MS)); // T4
    insertAttempt(
      db,
      alpha,
      alphaUq,
      'today',
      'pass',
      new Date(NOW.getTime() + 1 * DAY_MS),
      'easy',
    ); // T2 Easy
    // 噪声：同题 void 跳过；read_check / library_practice 按 mode 跳过；cloze 按 kind 跳过
    insertAttempt(db, alpha, alphaUq, 'today', 'void', new Date(NOW.getTime() + 2 * DAY_MS));
    insertAttempt(db, alpha, alphaUq, 'read_check', 'pass', new Date(NOW.getTime() + 6 * DAY_MS));
    insertAttempt(
      db,
      alpha,
      alphaUq,
      'library_practice',
      'fail',
      new Date(NOW.getTime() + 7 * DAY_MS),
    );
    // P 维：一条 today + production 题（pass → Good）
    insertAttempt(db, alpha, alphaPq, 'today', 'pass', new Date(NOW.getTime() + 4 * DAY_MS));

    // ---- bravo：chunk。U 既有行（覆盖更新路径）；两条乱序：实际 T1(Again) → T2(Hard) ----
    const bravo = 'item-bravo';
    seedItemSync(db, bravo, { type: 'chunk', target: 'bravo' });
    const bravoUq = seedQuestionSync(db, bravo, { type: 'understanding' });
    seedStateSync(db, bravo, 'understanding', {
      difficulty: 5,
      stability: 15,
      reps: 9,
      correctStreak: 4,
    });
    insertAttempt(db, bravo, bravoUq, 'today', 'basic_pass', new Date(NOW.getTime() + 2 * DAY_MS)); // T2（先插）
    insertAttempt(db, bravo, bravoUq, 'today', 'fail', NOW); // T1（后插）

    // ---- clozeOnly：仅 cloze 题 attempts → 行保持未激活 ----
    const clozeOnly = 'item-cloze';
    seedItemSync(db, clozeOnly, { type: 'chunk', target: 'cloze-only' });
    const clozeQ = seedQuestionSync(db, clozeOnly, { type: 'cloze' });
    seedStateSync(db, clozeOnly, 'understanding', {});
    insertAttempt(db, clozeOnly, clozeQ, 'today', 'pass', NOW);
    insertAttempt(db, clozeOnly, clozeQ, 'today', 'fail', new Date(NOW.getTime() + DAY_MS));

    // ---- inactive：未激活词（无行无 attempts）→ 不创建任何行 ----
    const inactive = 'item-inactive';
    seedItemSync(db, inactive, { target: 'inactive', queueState: 'new' });

    // ---- masteredSeed：已 mastered（U S=130），其 3 条 Good 回放 S<120 → 降回 active；P 行无 attempts 不动 ----
    const masteredSeed = 'item-mastered';
    seedItemSync(db, masteredSeed, { target: 'mastered', status: 'mastered' });
    const masteredUq = seedQuestionSync(db, masteredSeed, { type: 'understanding' });
    seedStateSync(db, masteredSeed, 'understanding', {
      difficulty: 5,
      stability: 130,
      reps: 9,
      correctStreak: 7,
    });
    seedStateSync(db, masteredSeed, 'production', {
      difficulty: 5,
      stability: 130,
      reps: 9,
      correctStreak: 7,
    });
    insertAttempt(db, masteredSeed, masteredUq, 'today', 'pass', NOW);
    insertAttempt(
      db,
      masteredSeed,
      masteredUq,
      'today',
      'pass',
      new Date(NOW.getTime() + 5 * DAY_MS),
    );
    insertAttempt(
      db,
      masteredSeed,
      masteredUq,
      'today',
      'pass',
      new Date(NOW.getTime() + 20 * DAY_MS),
    );

    // ---- climber：6 条按到期节奏的 Good → 回放 S≥120 → 升 mastered（word：只看 U） ----
    const climber = 'item-climber';
    seedItemSync(db, climber, { target: 'climber' });
    const climberUq = seedQuestionSync(db, climber, { type: 'understanding' });
    const climbTimes: Date[] = [];
    let card = newCard(NOW);
    for (let i = 0; i < 6; i++) {
      const at = i === 0 ? NOW : card.due;
      climbTimes.push(at);
      card = advanceCard(card, at, Rating.Good);
      insertAttempt(db, climber, climberUq, 'today', 'pass', at);
    }

    // ---- 期望值（独立用引擎回放计算） ----
    const alphaUExpected = replayRatings([
      { at: NOW, rating: Rating.Good },
      { at: new Date(NOW.getTime() + 1 * DAY_MS), rating: Rating.Easy },
      { at: new Date(NOW.getTime() + 3 * DAY_MS), rating: Rating.Hard },
      { at: new Date(NOW.getTime() + 5 * DAY_MS), rating: Rating.Again },
    ]);
    const alphaPExpected = replayRatings([
      { at: new Date(NOW.getTime() + 4 * DAY_MS), rating: Rating.Good },
    ]);
    const bravoExpected = replayRatings([
      { at: NOW, rating: Rating.Again },
      { at: new Date(NOW.getTime() + 2 * DAY_MS), rating: Rating.Hard },
    ]);
    const masteredExpected = replayRatings([
      { at: NOW, rating: Rating.Good },
      { at: new Date(NOW.getTime() + 5 * DAY_MS), rating: Rating.Good },
      { at: new Date(NOW.getTime() + 20 * DAY_MS), rating: Rating.Good },
    ]);
    expect(masteredExpected.stability).toBeLessThan(120); // mastered 种子的回放确实不过线（种子设计前提）
    const climberExpected = replayRatings(climbTimes.map((at) => ({ at, rating: Rating.Good })));
    expect(climberExpected.stability).toBeGreaterThanOrEqual(120); // climber 的回放确实过线

    // ---- 执行 ----
    expect(applyFsrsCutover(db, NOW)).toEqual({ applied: true });
    expect(db.select().from(appMetadata).where(eq(appMetadata.key, 'fsrs')).get()).toMatchObject({
      key: 'fsrs',
    });

    // alpha U：D/S/reps/lapses=引擎回放；next=card.due；last=末条（T4 fail，乱序插入的中间那条）
    const alphaU = state(db, alpha, 'understanding')!;
    expect(alphaU).not.toBeNull();
    expect(alphaU.difficulty).toBeCloseTo(alphaUExpected.difficulty, 6);
    expect(alphaU.stability).toBeCloseTo(alphaUExpected.stability, 6);
    expect(alphaU.reps).toBe(4); // reps = 对应 today attempts 数（void/跳过类不计）
    expect(alphaU.lapses).toBe(alphaUExpected.lapses);
    expect(alphaU.nextReviewAt).toBe(alphaUExpected.due.toISOString());
    expect(alphaU.lastReviewAt).toBe(iso(new Date(NOW.getTime() + 5 * DAY_MS)));
    expect(alphaU.correctStreak).toBe(0); // 新插入行 streaks 从 0 起

    // alpha P：production 题的 today attempt 计入 P
    const alphaP = state(db, alpha, 'production')!;
    expect(alphaP.difficulty).toBeCloseTo(alphaPExpected.difficulty, 6);
    expect(alphaP.stability).toBeCloseTo(alphaPExpected.stability, 6);
    expect(alphaP.reps).toBe(1);
    expect(alphaP.lastReviewAt).toBe(iso(new Date(NOW.getTime() + 4 * DAY_MS)));

    // bravo：按时间序（非插入序）回放；既有行更新路径保留 streaks
    const bravoU = state(db, bravo, 'understanding')!;
    expect(bravoU.difficulty).toBeCloseTo(bravoExpected.difficulty, 6);
    expect(bravoU.stability).toBeCloseTo(bravoExpected.stability, 6);
    expect(bravoU.reps).toBe(2);
    expect(bravoU.lastReviewAt).toBe(iso(new Date(NOW.getTime() + 2 * DAY_MS))); // 末条按时间序
    expect(bravoU.correctStreak).toBe(4); // streaks 不在回放写入范围，保留原值

    // cloze / read_check / library_practice：不影响任何行
    expect(state(db, clozeOnly, 'understanding')).toMatchObject({
      difficulty: null,
      stability: null,
      reps: 0,
      nextReviewAt: null,
      lastReviewAt: null,
    });

    // 无 attempts 的行不动：inactive 不创建行
    expect(
      db.select().from(reviewStates).where(eq(reviewStates.learningItemId, inactive)).all(),
    ).toHaveLength(0);

    // status 按 S≥120 重算：mastered 种子降回 active（U 回放 S<120；P 行保留 S=130 但 word 只看 U）
    expect(itemStatus(db, masteredSeed)).toBe('active');
    const masteredU = state(db, masteredSeed, 'understanding')!;
    expect(masteredU.stability).toBeCloseTo(masteredExpected.stability, 6);
    expect(masteredU.difficulty).toBeCloseTo(masteredExpected.difficulty, 6);
    expect(masteredU.reps).toBe(3);
    expect(masteredU.lastReviewAt).toBe(iso(new Date(NOW.getTime() + 20 * DAY_MS)));
    expect(masteredU.correctStreak).toBe(7); // 既有行 streaks 保留
    expect(state(db, masteredSeed, 'production')!.stability).toBe(130); // 无 P attempts：行不动

    // climber：回放过线 → 升 mastered
    expect(itemStatus(db, climber)).toBe('mastered');
    expect(state(db, climber, 'understanding')!.stability).toBeCloseTo(
      climberExpected.stability,
      6,
    );

    // ---- 二次运行 no-op（字节不变） ----
    const afterFirstRun = rawSqlite(db).serialize();
    expect(applyFsrsCutover(db, new Date('2026-10-02T00:00:00.000Z'))).toEqual({
      applied: false,
    });
    expect(rawSqlite(db).serialize()).toEqual(afterFirstRun);
  });
});

// ---------- 测试工具（同步落库，固定/随机 id） ----------

function seedItemSync(
  db: AppDatabase,
  id: string,
  overrides: Partial<typeof learningItems.$inferInsert> = {},
): string {
  const now = NOW.toISOString();
  db.insert(learningItems)
    .values({
      id,
      type: 'word',
      target: id,
      meaning: '测试释义',
      ipa: null,
      source: null,
      sourceUrl: null,
      tagsJson: '[]',
      notes: null,
      status: 'active',
      queueState: 'started',
      needsReinforcement: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ...overrides,
    })
    .run();
  return id;
}

function seedStateSync(
  db: AppDatabase,
  itemId: string,
  dimension: 'understanding' | 'production',
  overrides: Partial<typeof reviewStates.$inferInsert> = {},
): string {
  const id = randomUUID();
  db.insert(reviewStates)
    .values({
      learningItemId: itemId,
      dimension,
      difficulty: null,
      stability: null,
      reps: 0,
      lapses: 0,
      nextReviewAt: null,
      lastReviewAt: null,
      correctStreak: 0,
      wrongStreak: 0,
      updatedAt: NOW.toISOString(),
      ...overrides,
      id,
    })
    .run();
  return id;
}

function seedQuestionSync(
  db: AppDatabase,
  itemId: string,
  overrides: Partial<typeof questions.$inferInsert> = {},
): string {
  const id = randomUUID();
  db.insert(questions)
    .values({
      id,
      learningItemId: itemId,
      type: 'understanding',
      status: 'fresh',
      meaningSnapshot: '测试释义',
      payloadJson: '{}',
      promptKey: 'generate_understanding',
      promptVersion: 1,
      promptHash: 'test-hash',
      model: 'mock',
      createdAt: NOW.toISOString(),
      ...overrides,
    })
    .run();
  return id;
}

function insertAttempt(
  db: AppDatabase,
  itemId: string,
  questionId: string,
  mode: string,
  result: string,
  createdAt: Date,
  outcomeSource: string | null = null,
): void {
  db.insert(attempts)
    .values({
      id: randomUUID(),
      learningItemId: itemId,
      questionId,
      mode,
      result,
      outcomeSource,
      viewedSource: 0,
      createdAt: createdAt.toISOString(),
    })
    .run();
}
