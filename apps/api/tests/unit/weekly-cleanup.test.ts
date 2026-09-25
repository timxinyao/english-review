import { beforeEach, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { createDatabase, rawSqlite, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runWeeklyCleanup } from '../../src/jobs/weekly-cleanup.js';
import {
  attempts,
  learningItems,
  questions,
  readArticleItems,
  readArticles,
  reviewSessions,
  reviewTasks,
} from '../../src/db/schema.js';

let db: AppDatabase;
const NOW = new Date('2026-09-25T08:00:00.000Z');
const DAY = 86_400_000;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}

// ---------- 种子（本文件专用，独立于 helpers/seed 以免并行开发冲突） ----------

function seedItem(id: string): void {
  db.insert(learningItems)
    .values({
      id,
      type: 'word',
      target: `target-${id}`,
      meaning: '测试释义',
      createdAt: daysAgo(400),
      updatedAt: daysAgo(400),
    })
    .run();
}

function seedQuestion(
  id: string,
  itemId: string,
  overrides: Partial<typeof questions.$inferInsert> = {},
): void {
  db.insert(questions)
    .values({
      id,
      learningItemId: itemId,
      type: 'understanding',
      status: 'fresh',
      meaningSnapshot: '测试释义',
      promptKey: 'generate_understanding',
      promptVersion: 1,
      promptHash: 'test-hash',
      model: 'mock',
      createdAt: daysAgo(50),
      ...overrides,
    })
    .run();
}

function seedAttempt(
  id: string,
  itemId: string,
  overrides: Partial<typeof attempts.$inferInsert> = {},
): void {
  db.insert(attempts)
    .values({
      id,
      learningItemId: itemId,
      mode: 'today',
      result: 'pass',
      createdAt: daysAgo(10),
      ...overrides,
    })
    .run();
}

function seedSession(id: string, createdAt: string): void {
  db.insert(reviewSessions)
    .values({ id, sessionDate: createdAt.slice(0, 10), startedAt: createdAt, createdAt })
    .run();
}

function seedTask(id: string, sessionId: string, itemId: string, createdAt: string): void {
  db.insert(reviewTasks)
    .values({
      id,
      sessionId,
      learningItemId: itemId,
      dimension: 'understanding',
      taskType: 'understanding',
      origin: 'base',
      sortKey: 0,
      createdAt,
    })
    .run();
}

function seedArticle(
  id: string,
  itemId: string,
  overrides: Partial<typeof readArticles.$inferInsert> = {},
): void {
  db.insert(readArticles)
    .values({
      id,
      title: `Article ${id}`,
      body: 'Body text.',
      promptKey: 'generate_read',
      promptVersion: 1,
      promptHash: 'test-hash',
      model: 'mock',
      createdAt: daysAgo(40),
      ...overrides,
    })
    .run();
  db.insert(readArticleItems)
    .values({ readArticleId: id, learningItemId: itemId, role: 'focus' })
    .run();
}

const questionExists = (id: string) =>
  db.select({ id: questions.id }).from(questions).where(eq(questions.id, id)).get() !== undefined;
const attemptExists = (id: string) =>
  db.select({ id: attempts.id }).from(attempts).where(eq(attempts.id, id)).get() !== undefined;
const sessionExists = (id: string) =>
  db
    .select({ id: reviewSessions.id })
    .from(reviewSessions)
    .where(eq(reviewSessions.id, id))
    .get() !== undefined;
const taskExists = (id: string) =>
  db.select({ id: reviewTasks.id }).from(reviewTasks).where(eq(reviewTasks.id, id)).get() !==
  undefined;
const articleExists = (id: string) =>
  db.select({ id: readArticles.id }).from(readArticles).where(eq(readArticles.id, id)).get() !==
  undefined;
const attemptCountFor = (itemId: string) =>
  db.select({ id: attempts.id }).from(attempts).where(eq(attempts.learningItemId, itemId)).all()
    .length;

// ---------- retired 题目：45 天 + 库存充足 ----------

describe('runWeeklyCleanup：retired 题目删除（45 天 + 库存充足）', () => {
  it('retired 45 天且 fresh+active 库存 >= 目标库存 → 物理删除', () => {
    seedItem('i1');
    for (let i = 0; i < 3; i++) seedQuestion(`f${i}`, 'i1'); // 库存 3 = understanding 目标
    seedQuestion('qr1', 'i1', { status: 'retired', retiredAt: daysAgo(45) });

    const s = runWeeklyCleanup(db, NOW);
    expect(s.retiredQuestionsDeleted).toBe(1);
    expect(questionExists('qr1')).toBe(false);
  });

  it('库存不足（2 < 3）→ 不删，保证可复习', () => {
    seedItem('i2');
    for (let i = 0; i < 2; i++) seedQuestion(`g${i}`, 'i2');
    seedQuestion('qr2', 'i2', { status: 'retired', retiredAt: daysAgo(60) });

    const s = runWeeklyCleanup(db, NOW);
    expect(s.retiredQuestionsDeleted).toBe(0);
    expect(questionExists('qr2')).toBe(true);
  });

  it('边界：retired_at 恰好 45 天 → 删除；44 天 → 保留', () => {
    seedItem('i3a');
    seedItem('i3b');
    for (let i = 0; i < 3; i++) seedQuestion(`ha${i}`, 'i3a');
    for (let i = 0; i < 3; i++) seedQuestion(`hb${i}`, 'i3b');
    seedQuestion('q-edge', 'i3a', { status: 'retired', retiredAt: daysAgo(45) });
    seedQuestion('q-young', 'i3b', { status: 'retired', retiredAt: daysAgo(44) });

    const s = runWeeklyCleanup(db, NOW);
    expect(s.retiredQuestionsDeleted).toBe(1);
    expect(questionExists('q-edge')).toBe(false);
    expect(questionExists('q-young')).toBe(true);
  });

  it('按题型独立判定库存：production 目标 2，库存 2 即可删', () => {
    seedItem('i4');
    for (let i = 0; i < 2; i++)
      seedQuestion(`p${i}`, 'i4', { type: 'production', status: 'fresh' });
    seedQuestion('qr4', 'i4', {
      type: 'production',
      status: 'retired',
      retiredAt: daysAgo(50),
    });

    const s = runWeeklyCleanup(db, NOW);
    expect(s.retiredQuestionsDeleted).toBe(1);
    expect(questionExists('qr4')).toBe(false);
  });
});

// ---------- bad_question：30 天 ----------

describe('runWeeklyCleanup：bad_question 删除（30 天）', () => {
  it('created_at 恰好 30 天 → 删除；29 天 → 保留', () => {
    seedItem('b1');
    seedQuestion('qb-old', 'b1', { status: 'bad_question', createdAt: daysAgo(30) });
    seedQuestion('qb-new', 'b1', { status: 'bad_question', createdAt: daysAgo(29) });

    const s = runWeeklyCleanup(db, NOW);
    expect(s.badQuestionsDeleted).toBe(1);
    expect(questionExists('qb-old')).toBe(false);
    expect(questionExists('qb-new')).toBe(true);
  });
});

// ---------- read_articles：过期级联 ----------

describe('runWeeklyCleanup：过期 Read 删除（级联 read_article_items）', () => {
  it('expires_at 非空且 <= now → 删除并级联 items；收藏（expires null）与未过期保留', () => {
    seedItem('r1');
    seedItem('r2');
    seedItem('r3');
    seedArticle('ra-old', 'r1', { expiresAt: daysAgo(1) });
    seedArticle('ra-fav', 'r2', { favorite: 1, expiresAt: null });
    seedArticle('ra-future', 'r3', { expiresAt: daysAgo(-5) });

    const s = runWeeklyCleanup(db, NOW);
    expect(s.readArticlesDeleted).toBe(1);
    expect(articleExists('ra-old')).toBe(false);
    expect(articleExists('ra-fav')).toBe(true);
    expect(articleExists('ra-future')).toBe(true);
    const linkGone =
      db
        .select({ id: readArticleItems.readArticleId })
        .from(readArticleItems)
        .where(eq(readArticleItems.readArticleId, 'ra-old'))
        .get() === undefined;
    expect(linkGone).toBe(true);
  });
});

// ---------- attempts：60 天 + 例外 ----------

describe('runWeeklyCleanup：attempts 明细删除（60 天 + 例外）', () => {
  it('普通旧明细删除；voided 保留；近期保留；read_check 带答案也删除', () => {
    seedItem('ia');
    seedAttempt('a-plain', 'ia', {
      createdAt: daysAgo(70),
      selectedOptionId: 'o1',
    });
    seedAttempt('a-voided', 'ia', { createdAt: daysAgo(70), voidedAt: daysAgo(69) });
    seedAttempt('a-recent', 'ia', { createdAt: daysAgo(10), selectedOptionId: 'o2' });
    seedAttempt('a-readcheck', 'ia', {
      createdAt: daysAgo(70),
      mode: 'read_check',
      answerText: 'saw it',
    });

    const s = runWeeklyCleanup(db, NOW);
    expect(s.attemptsDeleted).toBe(2);
    expect(attemptExists('a-plain')).toBe(false);
    expect(attemptExists('a-readcheck')).toBe(false);
    expect(attemptExists('a-voided')).toBe(true);
    expect(attemptExists('a-recent')).toBe(true);
  });

  it('表达类旧明细每 item 保留最新 10 条：correction_json 或（answer_text 且非 read_check）', () => {
    seedItem('ib');
    // 12 条表达明细，全部超过 60 天（76 天前 ~ 65 天前），仅最新 10 条保留
    for (let i = 0; i < 12; i++) {
      seedAttempt(`e-${i}`, 'ib', {
        createdAt: daysAgo(65 + (11 - i)),
        mode: 'today',
        answerText: `sentence ${i}`,
        correctionJson: '{"segments":[]}',
      });
    }

    const s = runWeeklyCleanup(db, NOW);
    expect(s.attemptsDeleted).toBe(2);
    expect(attemptCountFor('ib')).toBe(10);
    expect(attemptExists('e-0')).toBe(false); // 最旧（76 天前）
    expect(attemptExists('e-1')).toBe(false);
    expect(attemptExists('e-2')).toBe(true);
    expect(attemptExists('e-11')).toBe(true); // 最新（65 天前）
  });

  it('answer_text 非空且 mode != read_check 即算表达类（library_practice）', () => {
    seedItem('ic');
    for (let i = 0; i < 12; i++) {
      seedAttempt(`lp-${i}`, 'ic', {
        createdAt: daysAgo(65 + (11 - i)),
        mode: 'library_practice',
        answerText: `practice ${i}`,
      });
    }
    const s = runWeeklyCleanup(db, NOW);
    expect(s.attemptsDeleted).toBe(2);
    expect(attemptCountFor('ic')).toBe(10);
  });
});

// ---------- review_tasks / review_sessions：12 个月 ----------

describe('runWeeklyCleanup：review_tasks / review_sessions 删除（365 天）', () => {
  it('恰好 365 天 → 删除；366 天 → 删除；近期保留', () => {
    seedItem('sa');
    seedSession('s-edge', daysAgo(365));
    seedTask('t-edge', 's-edge', 'sa', daysAgo(365));
    seedSession('s-old', daysAgo(366));
    seedTask('t-old', 's-old', 'sa', daysAgo(366));
    seedSession('s-new', daysAgo(10));
    seedTask('t-new', 's-new', 'sa', daysAgo(10));

    const s = runWeeklyCleanup(db, NOW);
    expect(s.reviewTasksDeleted).toBe(2);
    expect(s.reviewSessionsDeleted).toBe(2);
    expect(taskExists('t-edge')).toBe(false);
    expect(taskExists('t-old')).toBe(false);
    expect(sessionExists('s-edge')).toBe(false);
    expect(sessionExists('s-old')).toBe(false);
    expect(taskExists('t-new')).toBe(true);
    expect(sessionExists('s-new')).toBe(true);
  });
});

// ---------- 幂等 ----------

describe('runWeeklyCleanup：幂等', () => {
  it('重复执行第二遍所有删除计数为 0', () => {
    seedItem('idem');
    seedQuestion('q-r', 'idem', { status: 'retired', retiredAt: daysAgo(50) });
    for (let i = 0; i < 3; i++) seedQuestion(`qf${i}`, 'idem');
    seedQuestion('q-b', 'idem', { status: 'bad_question', createdAt: daysAgo(40) });
    seedArticle('ra-i', 'idem', { expiresAt: daysAgo(2) });
    seedAttempt('a-i', 'idem', { createdAt: daysAgo(90) });
    seedSession('s-i', daysAgo(400));
    seedTask('t-i', 's-i', 'idem', daysAgo(400));

    const first = runWeeklyCleanup(db, NOW);
    expect(first).toEqual({
      retiredQuestionsDeleted: 1,
      badQuestionsDeleted: 1,
      readArticlesDeleted: 1,
      attemptsDeleted: 1,
      reviewTasksDeleted: 1,
      reviewSessionsDeleted: 1,
    });

    const second = runWeeklyCleanup(db, NOW);
    expect(second).toEqual({
      retiredQuestionsDeleted: 0,
      badQuestionsDeleted: 0,
      readArticlesDeleted: 0,
      attemptsDeleted: 0,
      reviewTasksDeleted: 0,
      reviewSessionsDeleted: 0,
    });
  });
});

// ---------- 事务内 close 不需要：确认 rawSqlite 可用（入口模式对齐） ----------

describe('runWeeklyCleanup：数据库健康', () => {
  it('清理后外键完整性检查通过', () => {
    seedItem('fk1');
    seedSession('s-fk', daysAgo(400));
    seedTask('t-fk', 's-fk', 'fk1', daysAgo(400));
    seedAttempt('a-fk', 'fk1', { createdAt: daysAgo(400) });
    runWeeklyCleanup(db, NOW);
    const check = rawSqlite(db).pragma('foreign_key_check') as unknown[];
    expect(check).toHaveLength(0);
    expect(
      db.select({ n: attempts.id }).from(attempts).where(like(attempts.id, 'a-fk')).get(),
    ).toBeUndefined();
  });
});
