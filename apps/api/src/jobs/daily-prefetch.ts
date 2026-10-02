import { pathToFileURL } from 'node:url';
import { and, asc, eq } from 'drizzle-orm';
import { QUESTION_TARGET_STOCK } from '@el/shared';
import { loadConfig } from '../config.js';
import { initAiRuntime } from '../ai/runtime.js';
import { createDatabase, rawSqlite, type AppDatabase } from '../db/client.js';
import { withJobLock } from '../db/job-lock.js';
import { runMigrations } from '../db/migrate.js';
import { learningItems } from '../db/schema.js';
import type { AiRuntime } from '../ai/runtime.js';
import {
  countQuestionStock,
  generateQuestionsForItem,
  questionTypesForDue,
} from '../modules/questions/service.js';
import { listUpcomingDue } from '../modules/review/service.js';
import { applyV2Cutover } from '../modules/review/v2-cutover.js';

/** 预生成窗口：未来 48 小时（PHASES phase-3） */
export const PREFETCH_HORIZON_DAYS = 2;

/** 新词预取病态上界：防单次导入巨量导致单晚跑不完（超出部分随后续夜晚追平）。
 *  额度（maxNewItemsPerDay）与备货解耦：额度只决定当天学多少。 */
export const PREFETCH_NEW_ITEMS_CAP = 100;

export interface PrefetchSummary {
  /** 窗口内到期的 item×维度数 */
  due: number;
  /** 实际执行了生成的条目数 */
  processed: number;
  /** 库存已达标而跳过的条目数 */
  skipped: number;
  /** 生成失败的条目数 */
  failed: number;
  /** 生成题目总数 */
  generated: number;
  /** 新词队列补库存条目数 */
  newItems: number;
  /** 新词队列生成题目总数 */
  newGenerated: number;
}

/**
 * 题目预生成核心（TECHNICAL_DESIGN / phase-3 + phase-4）：
 * 扫未来 horizon 天内将到期的（item active + started）item×维度 → 对应题型
 * （U→understanding；有效 P→production，表达题目标 2）
 * 库存 < QUESTION_TARGET_STOCK 时补足；再对整个新队列（active+new，createdAt,id 序）
 * 补 understanding 库存（Today Learn 题盲区，start 不再在线生成；额度与备货解耦，
 * 病态上界 PREFETCH_NEW_ITEMS_CAP）。
 * 整体持 question-generation 全局锁（与 today/start、library/practice 互斥）；
 * 单条目失败不中断，最后汇总；退出码处理由入口 main 负责。
 */
export async function runPrefetch(
  deps: { db: AppDatabase; runtime: AiRuntime },
  now: Date,
  horizonDays: number = PREFETCH_HORIZON_DAYS,
): Promise<PrefetchSummary> {
  // 30 分钟租约：全量队列最多约 100 词 × 3 题串行生成
  return withJobLock(
    deps.db,
    'question-generation',
    async () => {
      const due = listUpcomingDue(deps.db, now, horizonDays);
      const summary: PrefetchSummary = {
        due: due.length,
        processed: 0,
        skipped: 0,
        failed: 0,
        generated: 0,
        newItems: 0,
        newGenerated: 0,
      };

      for (const entry of due) {
        const types = questionTypesForDue(entry.dimension);

        let needed = false;
        for (const type of types) {
          const target = QUESTION_TARGET_STOCK[type];
          const stock = countQuestionStock(deps.db, entry.itemId, type);
          if (stock >= target) continue;
          needed = true;
          try {
            const rows = await generateQuestionsForItem(
              { db: deps.db, runtime: deps.runtime },
              entry.itemId,
              type,
              target - stock,
            );
            summary.generated += rows.length;
            summary.processed++;
          } catch (err) {
            summary.failed++;
            console.error(
              `[daily-prefetch] item ${entry.itemId}（${entry.dimension}→${type}）生成失败：${(err as Error).message}`,
            );
          }
        }
        if (!needed) summary.skipped++;
      }

      // ---- 新词队列全量备货（额度解耦）：按 createdAt,id 补 understanding 库存至目标 ----
      const newItems = deps.db
        .select()
        .from(learningItems)
        .where(and(eq(learningItems.status, 'active'), eq(learningItems.queueState, 'new')))
        .orderBy(asc(learningItems.createdAt), asc(learningItems.id))
        .limit(PREFETCH_NEW_ITEMS_CAP)
        .all();
      const target = QUESTION_TARGET_STOCK.understanding;
      for (const item of newItems) {
        const stock = countQuestionStock(deps.db, item.id, 'understanding');
        if (stock >= target) continue;
        try {
          const rows = await generateQuestionsForItem(
            { db: deps.db, runtime: deps.runtime },
            item.id,
            'understanding',
            target - stock,
          );
          summary.newGenerated += rows.length;
          summary.newItems++;
        } catch (err) {
          summary.failed++;
          console.error(
            `[daily-prefetch] 新词 ${item.id}（understanding）生成失败：${(err as Error).message}`,
          );
        }
      }
      return summary;
    },
    { ttlMs: 30 * 60_000 },
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  try {
    runMigrations(db);
    applyV2Cutover(db, new Date(), config.appTimezone);
    const runtime = initAiRuntime(config);

    // 生产守卫：无 GLM key 时 provider 是 mock，绝不允许 mock 输出进入生产题库
    if (runtime.provider.name !== 'glm') {
      console.error('[daily-prefetch] AI provider 不是 glm（缺 GLM_API_KEY？），拒绝预生成');
      process.exitCode = 1;
      return;
    }

    const summary = await runPrefetch({ db, runtime }, new Date());
    console.info(
      `[daily-prefetch] 到期 ${summary.due}，处理 ${summary.processed}，` +
        `跳过 ${summary.skipped}，失败 ${summary.failed}，生成 ${summary.generated} 题；` +
        `新词 ${summary.newItems}，生成 ${summary.newGenerated} 题`,
    );
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    rawSqlite(db).close();
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedUrl && import.meta.url === invokedUrl) {
  main().catch((err) => {
    console.error('[daily-prefetch] 执行失败：', err);
    process.exitCode = 1;
  });
}
