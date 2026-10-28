import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import {
  appMetadata,
  attempts,
  learningItems,
  questions,
  reviewStates,
  reviewTasks,
} from '../../db/schema.js';
import type { DbTx } from '../questions/service.js';
import { effectiveProductionEnabled } from './goals.js';
import { initialProductionActivation, reconcileItemStatus } from './service.js';

const CUTOVER_KEY = 'production_scramble_v1';

export function isProductionScrambleCutoverApplied(db: AppDatabase): boolean {
  return !!db.select().from(appMetadata).where(eq(appMetadata.key, CUTOVER_KEY)).get();
}

/**
 * One-shot cutover: delete free-typing / cloze production evidence, reset P FSRS,
 * re-activate enabled started items for next-day scramble (spec §7).
 * Idempotent via app_metadata.production_scramble_v1.
 */
export function applyProductionScrambleCutover(
  db: AppDatabase,
  now: Date,
): { applied: boolean } {
  const nowIso = now.toISOString();
  return db.transaction((tx: DbTx) => {
    if (tx.select().from(appMetadata).where(eq(appMetadata.key, CUTOVER_KEY)).get()) {
      return { applied: false };
    }

    const oldQs = tx
      .select({ id: questions.id })
      .from(questions)
      .where(inArray(questions.type, ['production', 'cloze']))
      .all();
    const oldIds = oldQs.map((q) => q.id);

    if (oldIds.length > 0) {
      tx.delete(attempts).where(inArray(attempts.questionId, oldIds)).run();
      tx.delete(questions).where(inArray(questions.id, oldIds)).run();
    }

    // Incomplete production tasks cannot bind scramble questions from a half-old session.
    tx.update(reviewTasks)
      .set({ canceledAt: nowIso })
      .where(
        and(
          eq(reviewTasks.taskType, 'production'),
          isNull(reviewTasks.completedAt),
          isNull(reviewTasks.canceledAt),
        ),
      )
      .run();

    tx.update(reviewStates)
      .set({
        difficulty: null,
        stability: null,
        reps: 0,
        lapses: 0,
        nextReviewAt: null,
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
        updatedAt: nowIso,
      })
      .where(eq(reviewStates.dimension, 'production'))
      .run();

    const activation = initialProductionActivation(now);
    for (const item of tx.select().from(learningItems).all()) {
      reconcileItemStatus(tx, item.id, nowIso);
      const current = tx.select().from(learningItems).where(eq(learningItems.id, item.id)).get()!;
      if (
        current.queueState !== 'started' ||
        current.status !== 'active' ||
        !effectiveProductionEnabled(current)
      ) {
        continue;
      }
      const p = tx
        .select()
        .from(reviewStates)
        .where(
          and(eq(reviewStates.learningItemId, item.id), eq(reviewStates.dimension, 'production')),
        )
        .get();
      if (p) {
        tx.update(reviewStates)
          .set({
            difficulty: activation.difficulty,
            stability: activation.stability,
            reps: activation.reps,
            lapses: activation.lapses,
            nextReviewAt: activation.nextReviewAt,
            lastReviewAt: activation.lastReviewAt,
            correctStreak: activation.correctStreak,
            wrongStreak: activation.wrongStreak,
            updatedAt: nowIso,
          })
          .where(eq(reviewStates.id, p.id))
          .run();
      } else {
        tx.insert(reviewStates)
          .values({
            id: randomUUID(),
            learningItemId: item.id,
            dimension: 'production',
            difficulty: activation.difficulty,
            stability: activation.stability,
            reps: activation.reps,
            lapses: activation.lapses,
            nextReviewAt: activation.nextReviewAt,
            lastReviewAt: activation.lastReviewAt,
            correctStreak: activation.correctStreak,
            wrongStreak: activation.wrongStreak,
            updatedAt: nowIso,
          })
          .run();
      }
    }

    tx.insert(appMetadata)
      .values({
        key: CUTOVER_KEY,
        value: nowIso,
        updatedAt: nowIso,
      })
      .run();
    return { applied: true };
  });
}
