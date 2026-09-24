import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  parseTags,
  reviewStageLabel,
  serializeTags,
  type LibraryItemDetail,
  type LibraryListItemDto,
  type LibraryListQuery,
  type LibraryListResponse,
  type ReviewStateDto,
  type UpdateLearningItemRequest,
  type UpdateLearningItemResponse,
} from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { learningExamples, learningItems, reviewStates } from '../../db/schema.js';
import { appError } from '../../lib/errors.js';
import { invalidateQuestions, type DbExecutor, type DbTx } from '../questions/service.js';

type ItemRow = typeof learningItems.$inferSelect;
type ExampleRow = typeof learningExamples.$inferSelect;
type ReviewStateRow = typeof reviewStates.$inferSelect;
type ItemStatusDto = LibraryListItemDto['status'];

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * better-sqlite3 的原生事务要求同步回调，因此事务内一律使用
 * 同步执行方法（.get()/.all()/.run()），禁止 await（见 drizzle BetterSQLite3Session）。
 */
function requireItem(exec: DbExecutor, id: string): ItemRow {
  const row = exec.select().from(learningItems).where(eq(learningItems.id, id)).get();
  if (!row) throw appError('NOT_FOUND', '学习项不存在');
  return row;
}

// ---------- 列表 ----------

/** LIKE 模式：转义 % _ \ 后包裹 %%（SQLite ESCAPE '\'） */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function searchCondition(q: string) {
  const pattern = likePattern(q.toLowerCase());
  const like = (column: unknown) => sql`lower(coalesce(${column}, '')) LIKE ${pattern} ESCAPE '\\'`;
  const fields = or(
    like(learningItems.target),
    like(learningItems.meaning),
    like(learningItems.source),
    like(learningItems.notes),
    like(learningItems.tagsJson),
    // 任意 kind 的例句文本命中即返回该 Item
    sql`EXISTS (SELECT 1 FROM learning_examples le WHERE le.learning_item_id = ${learningItems.id} AND lower(le.text) LIKE ${pattern} ESCAPE '\\')`,
  );
  return sql`(${fields})`;
}

export async function listLearningItems(
  db: AppDatabase,
  query: LibraryListQuery,
): Promise<LibraryListResponse> {
  const conditions = [];
  // archived 默认隐藏（PRODUCT_DESIGN §3.3），显式筛选时可只看 archived
  if (query.status) {
    conditions.push(eq(learningItems.status, query.status));
  } else {
    conditions.push(ne(learningItems.status, 'archived'));
  }
  if (query.type) conditions.push(eq(learningItems.type, query.type));
  const q = query.query?.trim();
  if (q) conditions.push(searchCondition(q));
  const where = and(...conditions);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(learningItems)
    .where(where);

  const rows = await db
    .select()
    .from(learningItems)
    .where(where)
    .orderBy(desc(learningItems.createdAt), desc(learningItems.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const ids = rows.map((r) => r.id);
  const stateMap = new Map<string, Map<string, ReviewStateRow>>();
  if (ids.length > 0) {
    const states = await db
      .select()
      .from(reviewStates)
      .where(inArray(reviewStates.learningItemId, ids));
    for (const s of states) {
      let byDim = stateMap.get(s.learningItemId);
      if (!byDim) {
        byDim = new Map();
        stateMap.set(s.learningItemId, byDim);
      }
      byDim.set(s.dimension, s);
    }
  }

  const items = rows.map((row) => {
    const byDim = stateMap.get(row.id);
    const u = byDim?.get('understanding');
    const p = byDim?.get('production');
    const nexts = [u?.nextReviewAt, p?.nextReviewAt].filter(
      (x): x is string => typeof x === 'string',
    );
    const dto: LibraryListItemDto = {
      id: row.id,
      type: row.type as 'word' | 'chunk',
      target: row.target,
      meaning: row.meaning,
      status: row.status as ItemStatusDto,
      queueState: row.queueState as 'new' | 'started',
      tags: parseTags(row.tagsJson),
      source: row.source,
      understandingStage: reviewStageLabel(u?.level ?? 0, (u?.stable ?? 0) === 1),
      productionStage: reviewStageLabel(p?.level ?? 0, (p?.stable ?? 0) === 1),
      nextReviewAt: nexts.length > 0 ? nexts.reduce((a, b) => (a < b ? a : b)) : null,
      createdAt: row.createdAt,
    };
    return dto;
  });

  return { items, total, page: query.page, pageSize: query.pageSize };
}

// ---------- 详情 ----------

function zeroState(dimension: 'understanding' | 'production'): ReviewStateDto {
  return { dimension, level: 0, stable: false, nextReviewAt: null, lastReviewAt: null };
}

function toStateDto(row: ReviewStateRow): ReviewStateDto {
  return {
    dimension: row.dimension as 'understanding' | 'production',
    level: row.level,
    stable: row.stable === 1,
    nextReviewAt: row.nextReviewAt,
    lastReviewAt: row.lastReviewAt,
  };
}

function loadStates(exec: DbExecutor, id: string) {
  const states = exec.select().from(reviewStates).where(eq(reviewStates.learningItemId, id)).all();
  const byDim = new Map(states.map((s) => [s.dimension as 'understanding' | 'production', s]));
  return {
    understanding: byDim.get('understanding'),
    production: byDim.get('production'),
  };
}

function buildDetail(
  row: ItemRow,
  examples: ExampleRow[],
  states: { understanding?: ReviewStateRow; production?: ReviewStateRow },
): LibraryItemDetail {
  const source = examples.find((e) => e.kind === 'source');
  if (!source) throw appError('INTERNAL', '学习项缺少 source 例句');
  const bySort = (a: ExampleRow, b: ExampleRow) => a.sortOrder - b.sortOrder;
  return {
    item: {
      id: row.id,
      type: row.type as 'word' | 'chunk',
      target: row.target,
      meaning: row.meaning,
      ipa: row.type === 'chunk' ? null : row.ipa,
      source: row.source,
      sourceUrl: row.sourceUrl,
      tags: parseTags(row.tagsJson),
      notes: row.notes,
      status: row.status as ItemStatusDto,
      queueState: row.queueState as 'new' | 'started',
      needsReinforcement: row.needsReinforcement === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    },
    sourceExample: source.text,
    extraExamples: examples
      .filter((e) => e.kind === 'extra')
      .sort(bySort)
      .map((e) => e.text),
    personalExamples: examples
      .filter((e) => e.kind === 'personal')
      .sort(bySort)
      .map((e) => ({
        id: e.id,
        text: e.text,
        originalText: e.originalText,
        betterText: e.betterText,
        pinned: e.pinned === 1,
      })),
    reviewStates: [
      states.understanding ? toStateDto(states.understanding) : zeroState('understanding'),
      states.production ? toStateDto(states.production) : zeroState('production'),
    ],
  };
}

export async function getLearningItemDetail(
  db: AppDatabase,
  id: string,
): Promise<LibraryItemDetail> {
  const row = requireItem(db, id);
  const examples = db
    .select()
    .from(learningExamples)
    .where(eq(learningExamples.learningItemId, id))
    .all();
  return buildDetail(row, examples, loadStates(db, id));
}

// ---------- 编辑 ----------

export async function updateLearningItem(
  db: AppDatabase,
  id: string,
  patch: UpdateLearningItemRequest,
): Promise<UpdateLearningItemResponse> {
  const now = nowIso();
  let meaningChanged = false;

  db.transaction((tx) => {
    const row = requireItem(tx, id);
    const targetChanged = patch.target !== undefined && patch.target !== row.target;
    meaningChanged = patch.meaning !== undefined && patch.meaning !== row.meaning;

    const update: Partial<typeof learningItems.$inferInsert> = { updatedAt: now };
    if (patch.type !== undefined) update.type = patch.type;
    if (patch.target !== undefined) update.target = patch.target;
    if (patch.meaning !== undefined) update.meaning = patch.meaning;
    const effectiveType = (update.type ?? row.type) as 'word' | 'chunk';
    // chunk 不展示 IPA（PRODUCT_DESIGN §10 / AGENTS.md §10）
    update.ipa = effectiveType === 'chunk' ? null : patch.ipa !== undefined ? patch.ipa : row.ipa;
    if (patch.source !== undefined) update.source = patch.source;
    if (patch.sourceUrl !== undefined) update.sourceUrl = patch.sourceUrl;
    if (patch.tags !== undefined) update.tagsJson = serializeTags(patch.tags);
    if (patch.notes !== undefined) update.notes = patch.notes;
    tx.update(learningItems).set(update).where(eq(learningItems.id, id)).run();

    if (patch.sourceExample !== undefined) {
      const result = tx
        .update(learningExamples)
        .set({ text: patch.sourceExample, updatedAt: now })
        .where(and(eq(learningExamples.learningItemId, id), eq(learningExamples.kind, 'source')))
        .run();
      if (result.changes === 0) throw appError('INTERNAL', '学习项缺少 source 例句');
    }

    if (patch.extraExamples !== undefined) {
      tx.delete(learningExamples)
        .where(and(eq(learningExamples.learningItemId, id), eq(learningExamples.kind, 'extra')))
        .run();
      if (patch.extraExamples.length > 0) {
        tx.insert(learningExamples)
          .values(
            patch.extraExamples.map((text, sortOrder) => ({
              id: randomUUID(),
              learningItemId: id,
              kind: 'extra',
              text,
              originalText: null,
              betterText: null,
              pinned: 0,
              qualityScore: null,
              sortOrder,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .run();
      }
    }

    if (patch.personalExamples !== undefined) {
      for (const personal of patch.personalExamples) {
        const set: Partial<typeof learningExamples.$inferInsert> = { updatedAt: now };
        if (personal.pinned !== undefined) set.pinned = personal.pinned ? 1 : 0;
        if (personal.text !== undefined) set.text = personal.text;
        const result = tx
          .update(learningExamples)
          .set(set)
          .where(
            and(
              eq(learningExamples.id, personal.id),
              eq(learningExamples.learningItemId, id),
              eq(learningExamples.kind, 'personal'),
            ),
          )
          .run();
        if (result.changes === 0) throw appError('NOT_FOUND', `个人例句不存在：${personal.id}`);
      }
    }

    // target / meaning 变化 → 清题（PRODUCT_DESIGN §6.6）
    if (targetChanged || meaningChanged) {
      invalidateQuestions(tx, id, now);
    }
  });

  const detail = await getLearningItemDetail(db, id);
  // meaning 变化时提示可重置进度；是否重置由前端另行调用 reset（PRODUCT_DESIGN §6.6）
  return { ...detail, progressResetSuggested: meaningChanged };
}

// ---------- 状态操作 ----------

type SimpleTransition = 'pause' | 'resume' | 'archive' | 'restore';

const TRANSITIONS: Record<
  SimpleTransition,
  (now: string) => Partial<typeof learningItems.$inferInsert>
> = {
  pause: () => ({ status: 'paused' }),
  resume: () => ({ status: 'active' }),
  archive: (now) => ({ status: 'archived', archivedAt: now }),
  restore: () => ({ status: 'active', archivedAt: null }),
};

async function applyTransition(
  db: AppDatabase,
  id: string,
  action: SimpleTransition,
): Promise<LibraryItemDetail> {
  const now = nowIso();
  db.transaction((tx) => {
    requireItem(tx, id);
    tx.update(learningItems)
      .set({ ...TRANSITIONS[action](now), updatedAt: now })
      .where(eq(learningItems.id, id))
      .run();
  });
  return getLearningItemDetail(db, id);
}

export const pauseLearningItem = (db: AppDatabase, id: string) => applyTransition(db, id, 'pause');
export const resumeLearningItem = (db: AppDatabase, id: string) =>
  applyTransition(db, id, 'resume');
export const archiveLearningItem = (db: AppDatabase, id: string) =>
  applyTransition(db, id, 'archive');
export const restoreLearningItem = (db: AppDatabase, id: string) =>
  applyTransition(db, id, 'restore');

/** reset：两维进度归零 + status=active + queue_state=new + needs_reinforcement=0 */
export async function resetLearningItem(db: AppDatabase, id: string): Promise<LibraryItemDetail> {
  const now = nowIso();
  db.transaction((tx: DbTx) => {
    requireItem(tx, id);
    for (const dimension of ['understanding', 'production'] as const) {
      upsertState(tx, id, dimension, {
        level: 0,
        stable: 0,
        nextReviewAt: null,
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
        updatedAt: now,
      });
    }
    tx.update(learningItems)
      .set({ status: 'active', queueState: 'new', needsReinforcement: 0, updatedAt: now })
      .where(eq(learningItems.id, id))
      .run();
  });
  return getLearningItemDetail(db, id);
}

/** master：两维 stable + L7，status=mastered（TECHNICAL_DESIGN §6.2 补充说明） */
export async function masterLearningItem(db: AppDatabase, id: string): Promise<LibraryItemDetail> {
  const now = nowIso();
  db.transaction((tx: DbTx) => {
    requireItem(tx, id);
    for (const dimension of ['understanding', 'production'] as const) {
      upsertState(tx, id, dimension, { level: 7, stable: 1, updatedAt: now });
    }
    tx.update(learningItems)
      .set({ status: 'mastered', updatedAt: now })
      .where(eq(learningItems.id, id))
      .run();
  });
  return getLearningItemDetail(db, id);
}

function upsertState(
  tx: DbTx,
  id: string,
  dimension: 'understanding' | 'production',
  values: Partial<typeof reviewStates.$inferInsert> & { updatedAt: string },
): void {
  const result = tx
    .update(reviewStates)
    .set(values)
    .where(and(eq(reviewStates.learningItemId, id), eq(reviewStates.dimension, dimension)))
    .run();
  if (result.changes === 0) {
    tx.insert(reviewStates)
      .values({
        id: randomUUID(),
        learningItemId: id,
        dimension,
        level: 0,
        stable: 0,
        nextReviewAt: null,
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
        ...values,
      })
      .run();
  }
}
