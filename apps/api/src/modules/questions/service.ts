import { and, eq, inArray } from 'drizzle-orm';
import { questions } from '../../db/schema.js';
import type { AppDatabase } from '../../db/client.js';

/** drizzle 事务回调的 tx 参数类型（与 AppDatabase 同源的 BaseSQLiteDatabase） */
export type DbTx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** 可在事务内外通用的执行器：db 实例或事务 tx */
export type DbExecutor = AppDatabase | DbTx;

/**
 * 题目缓存失效（PRODUCT_DESIGN §6.6 / AGENTS.md §5）：
 * target 或 meaning 变化时，将该 Item 所有 fresh/active 题置为 retired（retired_at=now）。
 * 必须在 learning-items 编辑事务内（同步回调）调用；返回失效条数。
 */
export function invalidateQuestions(
  tx: DbExecutor,
  learningItemId: string,
  nowIso: string,
): number {
  return tx
    .update(questions)
    .set({ status: 'retired', retiredAt: nowIso })
    .where(
      and(
        eq(questions.learningItemId, learningItemId),
        inArray(questions.status, ['fresh', 'active']),
      ),
    )
    .run().changes;
}
