import { pathToFileURL } from 'node:url';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  BAD_QUESTION_KEEP_DAYS,
  ATTEMPT_DETAIL_KEEP_DAYS,
  PRODUCTION_HISTORY_KEEP,
  QUESTION_TARGET_STOCK,
  RETIRED_DELETE_DAYS,
  REVIEW_TASKS_KEEP_DAYS,
} from '@el/shared';
import { loadConfig } from '../config.js';
import { createDatabase, rawSqlite, type AppDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { attempts, questions, readArticles, reviewSessions, reviewTasks } from '../db/schema.js';
import type { DbTx, QuestionPoolType } from '../modules/questions/service.js';

/** 周清理结果（各类删除计数；重复执行第二遍应全为 0） */
export interface CleanupSummary {
  retiredQuestionsDeleted: number;
  badQuestionsDeleted: number;
  readArticlesDeleted: number;
  attemptsDeleted: number;
  reviewTasksDeleted: number;
  reviewSessionsDeleted: number;
}

const DAY_MS = 86_400_000;

function isoBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/** 该行是否属于“表达类”明细（保留每 item 最新 N 条的范畴） */
function isExpressionAttempt(row: {
  mode: string;
  answerText: string | null;
  correctionJson: string | null;
}): boolean {
  return row.correctionJson !== null || (row.answerText !== null && row.mode !== 'read_check');
}

/**
 * 生命周期周清理（PRODUCT_DESIGN §10 / TECHNICAL_DESIGN §12）：
 * 1. retired 题：retired_at <= now-45d 且同 item 同 type 的 fresh+active 库存 >= 目标库存 → 物理删除
 *    （库存不足不删，保证仍有题可复习）。
 * 2. bad_question 题：created_at <= now-30d → 删除。
 * 3. read_articles：expires_at 非空且 <= now → 删除（read_article_items 外键级联）。
 * 4. attempts：created_at <= now-60d → 删除；例外保留 voided_at 非空的，
 *    以及每 item 表达类明细最新 PRODUCTION_HISTORY_KEEP(10) 条。
 * 5. review_tasks / review_sessions：created_at <= now-365d → 删除。
 *
 * 自包含数据生命周期逻辑（ARCHITECTURE jobs 约定允许），同步事务内完成；
 * 幂等：重复执行时候选集为空，全部计数为 0。
 */
export function runWeeklyCleanup(db: AppDatabase, now: Date): CleanupSummary {
  return db.transaction((tx) => {
    const summary: CleanupSummary = {
      retiredQuestionsDeleted: cleanupRetiredQuestions(tx, now),
      badQuestionsDeleted: cleanupBadQuestions(tx, now),
      readArticlesDeleted: cleanupExpiredReadArticles(tx, now),
      attemptsDeleted: cleanupOldAttempts(tx, now),
      reviewTasksDeleted: 0,
      reviewSessionsDeleted: 0,
    };

    // 先按龄删 tasks（attempts.review_task_id / questions 引用为 set null），再删 sessions（级联 tasks）
    summary.reviewTasksDeleted = tx
      .delete(reviewTasks)
      .where(lte(reviewTasks.createdAt, isoBefore(now, REVIEW_TASKS_KEEP_DAYS)))
      .run().changes;
    summary.reviewSessionsDeleted = tx
      .delete(reviewSessions)
      .where(lte(reviewSessions.createdAt, isoBefore(now, REVIEW_TASKS_KEEP_DAYS)))
      .run().changes;

    return summary;
  });
}

/** retired 超期且库存充足的题 → 物理删除；返回删除数 */
function cleanupRetiredQuestions(tx: DbTx, now: Date): number {
  const cutoff = isoBefore(now, RETIRED_DELETE_DAYS);
  const candidates = tx
    .select({ id: questions.id, itemId: questions.learningItemId, type: questions.type })
    .from(questions)
    .where(and(eq(questions.status, 'retired'), lte(questions.retiredAt, cutoff)))
    .all();

  if (candidates.length === 0) return 0;

  // 每个 (item, type) 的 fresh+active 库存只查一次
  const stockCache = new Map<string, number>();
  const toDelete: string[] = [];
  for (const row of candidates) {
    const groupKey = `${row.itemId}|${row.type}`;
    let stock = stockCache.get(groupKey);
    if (stock === undefined) {
      const counted = tx
        .select({ total: sql<number>`count(*)` })
        .from(questions)
        .where(
          and(
            eq(questions.learningItemId, row.itemId),
            eq(questions.type, row.type),
            inArray(questions.status, ['fresh', 'active']),
          ),
        )
        .get();
      stock = counted ? Number(counted.total) : 0;
      stockCache.set(groupKey, stock);
    }
    const target = QUESTION_TARGET_STOCK[row.type as QuestionPoolType];
    if (target !== undefined && stock >= target) toDelete.push(row.id);
  }

  if (toDelete.length === 0) return 0;
  return tx.delete(questions).where(inArray(questions.id, toDelete)).run().changes;
}

/** bad_question 超过保留期 → 删除 */
function cleanupBadQuestions(tx: DbTx, now: Date): number {
  return tx
    .delete(questions)
    .where(
      and(
        eq(questions.status, 'bad_question'),
        lte(questions.createdAt, isoBefore(now, BAD_QUESTION_KEEP_DAYS)),
      ),
    )
    .run().changes;
}

/** 过期 Read（expires_at 非空且 <= now）→ 删除，read_article_items 级联 */
function cleanupExpiredReadArticles(tx: DbTx, now: Date): number {
  return tx
    .delete(readArticles)
    .where(
      and(
        sql`${readArticles.expiresAt} is not null`,
        lte(readArticles.expiresAt, now.toISOString()),
      ),
    )
    .run().changes;
}

/** 60 天前明细 → 删除；保留 voided 与每 item 最新 10 条表达类 */
function cleanupOldAttempts(tx: DbTx, now: Date): number {
  const rows = tx
    .select({
      id: attempts.id,
      itemId: attempts.learningItemId,
      mode: attempts.mode,
      answerText: attempts.answerText,
      correctionJson: attempts.correctionJson,
    })
    .from(attempts)
    .where(
      and(
        lte(attempts.createdAt, isoBefore(now, ATTEMPT_DETAIL_KEEP_DAYS)),
        isNull(attempts.voidedAt),
      ),
    )
    .orderBy(sql`${attempts.createdAt} desc`)
    .all();

  const keptPerItem = new Map<string, number>();
  const toDelete: string[] = [];
  for (const row of rows) {
    if (isExpressionAttempt(row)) {
      const kept = keptPerItem.get(row.itemId) ?? 0;
      if (kept < PRODUCTION_HISTORY_KEEP) {
        keptPerItem.set(row.itemId, kept + 1);
        continue;
      }
    }
    toDelete.push(row.id);
  }
  if (toDelete.length === 0) return 0;
  return tx.delete(attempts).where(inArray(attempts.id, toDelete)).run().changes;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  try {
    runMigrations(db);
    const summary = runWeeklyCleanup(db, new Date());
    console.info(
      `[weekly-cleanup] retired 题 ${summary.retiredQuestionsDeleted}，bad 题 ${summary.badQuestionsDeleted}，` +
        `过期 Read ${summary.readArticlesDeleted}，明细 attempts ${summary.attemptsDeleted}，` +
        `tasks ${summary.reviewTasksDeleted}，sessions ${summary.reviewSessionsDeleted}`,
    );
  } finally {
    rawSqlite(db).close();
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedUrl && import.meta.url === invokedUrl) {
  main().catch((err) => {
    console.error('[weekly-cleanup] 执行失败：', err);
    process.exitCode = 1;
  });
}
