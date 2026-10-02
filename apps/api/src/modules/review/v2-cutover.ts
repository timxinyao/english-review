import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { localDateString, type BackupExport, type BackupReviewState } from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { appMetadata, learningItems, reviewStates } from '../../db/schema.js';
import type { DbTx } from '../questions/service.js';
import { effectiveProductionEnabled, isMastered } from './goals.js';
import { reconcileItemStatus } from './service.js';

const CUTOVER_KEY = 'foxi_v2';

/** V2 cutover 是否已生效（标记存在即生效；V2 boot 在服务请求前写入）。 */
export function isV2CutoverApplied(db: AppDatabase): boolean {
  return !!db.select().from(appMetadata).where(eq(appMetadata.key, CUTOVER_KEY)).get();
}

/**
 * First V2 boot only. The marker and every state change share one SQLite transaction:
 * a crash rolls back the entire cutover, while later boots leave V2 progress untouched.
 * The caller must deploy/start V2 at or after the agreed APP_TIMEZONE day boundary.
 */
export function applyV2Cutover(db: AppDatabase, now: Date, timezone: string): { applied: boolean } {
  const nowIso = now.toISOString();
  return db.transaction((tx: DbTx) => {
    if (tx.select().from(appMetadata).where(eq(appMetadata.key, CUTOVER_KEY)).get()) {
      return { applied: false };
    }

    // Old P evidence included cloze. It cannot be interpreted as V2 sentence-production mastery.
    tx.update(reviewStates)
      .set({
        level: 0,
        stable: 0,
        nextReviewAt: null,
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
        updatedAt: nowIso,
      })
      .where(eq(reviewStates.dimension, 'production'))
      .run();

    for (const item of tx.select().from(learningItems).all()) {
      if (item.needsReinforcement !== 0) {
        tx.update(learningItems)
          .set({ needsReinforcement: 0, updatedAt: nowIso })
          .where(eq(learningItems.id, item.id))
          .run();
      }

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
          .set({ nextReviewAt: nowIso })
          .where(eq(reviewStates.id, p.id))
          .run();
      } else {
        tx.insert(reviewStates)
          .values({
            id: randomUUID(),
            learningItemId: item.id,
            dimension: 'production',
            level: 0,
            stable: 0,
            nextReviewAt: nowIso,
            lastReviewAt: null,
            correctStreak: 0,
            wrongStreak: 0,
            updatedAt: nowIso,
          })
          .run();
      }
    }

    tx.insert(appMetadata)
      .values({
        key: CUTOVER_KEY,
        value: localDateString(now, timezone),
        updatedAt: nowIso,
      })
      .run();
    return { applied: true };
  });
}

/**
 * A 1.2 backup can be restored long after the DB-wide marker was written.
 * Normalize that payload on every restore, independently of the marker; 2.0 is untouched.
 */
export function normalizeRestoredV1_2BackupForV2(backup: BackupExport, now: Date): BackupExport {
  if (backup.version !== '1.2') return backup;
  const nowIso = now.toISOString();
  return {
    ...backup,
    items: backup.items.map((item) => {
      const enabled = effectiveProductionEnabled({
        type: item.type,
        productionEnabledOverride: null, // 1.2 has no explicit override
      });
      const u = item.reviewStates.find((state) => state.dimension === 'understanding');
      const inactive = {
        level: 0,
        stable: false,
        nextReviewAt: null,
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
      };
      const mastered = isMastered(
        u ? { ...u, stable: u.stable === 1 } : inactive,
        inactive,
        enabled,
      );
      const status =
        item.status === 'paused' || item.status === 'archived'
          ? item.status
          : mastered
            ? 'mastered'
            : 'active';
      const due = item.queueState === 'started' && status === 'active' && enabled ? nowIso : null;
      const resetProduction = (state: BackupReviewState): BackupReviewState => ({
        ...state,
        level: 0,
        stable: 0,
        nextReviewAt: due,
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
      });
      const hasProduction = item.reviewStates.some((state) => state.dimension === 'production');
      const reviewStates: BackupReviewState[] = item.reviewStates.map((state) =>
        state.dimension === 'production' ? resetProduction(state) : state,
      );
      if (!hasProduction && due !== null) {
        reviewStates.push(
          resetProduction({
            dimension: 'production',
            level: 0,
            stable: 0,
            nextReviewAt: null,
            lastReviewAt: null,
            correctStreak: 0,
            wrongStreak: 0,
          }),
        );
      }
      return { ...item, status, needsReinforcement: 0, reviewStates };
    }),
  };
}
