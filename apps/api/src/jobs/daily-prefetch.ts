import { pathToFileURL } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { QUESTION_TARGET_STOCK } from '@el/shared';
import { loadConfig } from '../config.js';
import { initAiRuntime } from '../ai/runtime.js';
import { createDatabase, rawSqlite, type AppDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { reviewStates } from '../db/schema.js';
import type { AiRuntime } from '../ai/runtime.js';
import {
  countQuestionStock,
  generateQuestionsForItem,
  questionTypesForDue,
} from '../modules/questions/service.js';
import { listUpcomingDue } from '../modules/review/service.js';

/** 预生成窗口：未来 48 小时（PHASES phase-3） */
export const PREFETCH_HORIZON_DAYS = 2;

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
}

/**
 * 题目预生成核心（TECHNICAL_DESIGN / phase-3 + phase-4）：
 * 扫未来 horizon 天内将到期的（item active + started）item×维度 → 对应题型
 * （U→understanding；P-L1/2→cloze；P-L3+→cloze + production，表达题目标 2）
 * 库存 < QUESTION_TARGET_STOCK 时补足。
 * 单条目失败不中断，最后汇总；退出码处理由入口 main 负责。
 */
export async function runPrefetch(
  deps: { db: AppDatabase; runtime: AiRuntime },
  now: Date,
  horizonDays: number = PREFETCH_HORIZON_DAYS,
): Promise<PrefetchSummary> {
  const due = listUpcomingDue(deps.db, now, horizonDays);
  const summary: PrefetchSummary = {
    due: due.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    generated: 0,
  };

  for (const entry of due) {
    // P 维度题型组合依赖 level；listUpcomingDue 不带 level，这里只读 review_states
    // （AGENTS §4 约束针对写路径；写库仍全部经 service）
    let level = 0;
    if (entry.dimension === 'production') {
      const state = deps.db
        .select()
        .from(reviewStates)
        .where(
          and(
            eq(reviewStates.learningItemId, entry.itemId),
            eq(reviewStates.dimension, 'production'),
          ),
        )
        .get();
      level = state?.level ?? 0;
    }
    const types = questionTypesForDue(entry.dimension, level);

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
  return summary;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  try {
    runMigrations(db);
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
        `跳过 ${summary.skipped}，失败 ${summary.failed}，生成 ${summary.generated} 题`,
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
