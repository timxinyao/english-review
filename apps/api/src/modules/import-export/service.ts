import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import {
  parseTags,
  serializeTags,
  type DuplicateDecision,
  type ExportLibraryResponse,
  type ImportCommitRequest,
  type ImportCommitResponse,
  type ImportPreviewItem,
  type ImportPreviewResponse,
  type JudgeDuplicateMeaningResult,
  type LibraryImport,
  type LibraryImportItem,
} from '@el/shared';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { learningExamples, learningItems, reviewStates } from '../../db/schema.js';
import { appError } from '../../lib/errors.js';
import { getAiRuntime, type DuplicateJudgeItem } from '../../ai/runtime.js';
import type { DbTx } from '../questions/service.js';

// ---------- 归一化 ----------

/** target 归一化：小写、去首尾空白、压缩内部空白、去标点 .,!?'"；: （PRODUCT_DESIGN §9.2） */
export function normalizeTarget(target: string): string {
  return target
    .replace(/[.,!?'";:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** meaning / 例句归一化：压缩空白 + 小写（不去标点） */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------- AI judge（可注入） ----------

export type DuplicateJudge = (
  existing: DuplicateJudgeItem,
  candidate: DuplicateJudgeItem,
) => Promise<JudgeDuplicateMeaningResult | null>;

export interface ImportServiceDeps {
  db: AppDatabase;
  judge: DuplicateJudge;
}

/**
 * 生产 judge：仅在 config.glmApiKey 存在且 runtime 使用 glm provider 时调用 AI；
 * 无 key 或调用失败返回 null（service 层规则回退），绝不在生产路径用 mock 的语言判定。
 */
export function createRuntimeJudge(config: AppConfig): DuplicateJudge {
  return async (existing, candidate) => {
    if (!config.glmApiKey) return null;
    const runtime = getAiRuntime();
    if (!runtime || runtime.provider.name !== 'glm') return null;
    try {
      return await runtime.judgeDuplicateMeaning(existing, candidate);
    } catch {
      // AI 失败 → 规则回退；不在预览路径抛错（AI_RULES §14 降级原则）
      return null;
    }
  };
}

// ---------- preview payload 存储（内存，token 一次性，TTL 2h，惰性清理） ----------

export interface StoredPreviewEntry {
  candidate: LibraryImportItem;
  /** 系统建议的动作；未被用户 decision 覆盖时沿用 */
  action: DuplicateDecision;
  /** 触发比对的已有项；无匹配时 null */
  existingId: string | null;
}

export interface PreviewStore {
  put(entries: StoredPreviewEntry[]): string;
  take(token: string): StoredPreviewEntry[] | null;
}

export function createPreviewStore(
  opts: { now?: () => number; ttlMs?: number } = {},
): PreviewStore {
  const ttlMs = opts.ttlMs ?? 2 * 60 * 60 * 1000; // 2 小时
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, { payload: StoredPreviewEntry[]; expiresAt: number }>();

  function purge(): void {
    const current = now();
    for (const [token, entry] of map) {
      if (entry.expiresAt <= current) map.delete(token);
    }
  }

  return {
    put(payload) {
      purge();
      const token = randomUUID();
      map.set(token, { payload, expiresAt: now() + ttlMs });
      return token;
    },
    take(token) {
      purge();
      const entry = map.get(token);
      if (!entry) return null;
      map.delete(token); // token 一次性
      return entry.payload;
    },
  };
}

const previewStore = createPreviewStore();

// ---------- preview ----------

interface LibraryRow {
  id: string;
  type: string;
  target: string;
  meaning: string;
  sourceExample: string | null;
  createdAt: string;
}

async function loadLibraryRows(db: AppDatabase): Promise<LibraryRow[]> {
  const rows = await db
    .select({
      id: learningItems.id,
      type: learningItems.type,
      target: learningItems.target,
      meaning: learningItems.meaning,
      sourceExample: learningExamples.text,
      createdAt: learningItems.createdAt,
    })
    .from(learningItems)
    .leftJoin(
      learningExamples,
      and(
        eq(learningExamples.learningItemId, learningItems.id),
        eq(learningExamples.kind, 'source'),
      ),
    )
    .orderBy(learningItems.createdAt, learningItems.id);
  return rows;
}

function isExactDuplicate(existing: LibraryRow, candidate: LibraryImportItem): boolean {
  return (
    normalizeText(existing.meaning) === normalizeText(candidate.meaning) &&
    existing.sourceExample !== null &&
    normalizeText(existing.sourceExample) === normalizeText(candidate.source_example)
  );
}

function findMatch(rows: LibraryRow[], candidate: LibraryImportItem): LibraryRow | null {
  const normalized = normalizeTarget(candidate.target);
  const same = rows.filter((row) => normalizeTarget(row.target) === normalized);
  if (same.length === 0) return null;
  // 完全重复优先；否则取最早创建的同 target 项
  return same.find((row) => isExactDuplicate(row, candidate)) ?? same[0]!;
}

export async function previewImport(
  deps: ImportServiceDeps,
  payload: LibraryImport,
): Promise<ImportPreviewResponse> {
  const rows = await loadLibraryRows(deps.db);
  const items: ImportPreviewItem[] = [];

  for (const [index, candidate] of payload.items.entries()) {
    const match = findMatch(rows, candidate);

    if (!match) {
      items.push({
        index,
        candidate,
        suggestion: {
          action: 'new_item',
          reason: '库内没有相同 target 的学习项，建议新增。',
          confidence: 1,
          source: 'rule_fallback',
        },
        match: null,
      });
      continue;
    }

    const matchDto = {
      existingId: match.id,
      existingTarget: match.target,
      existingMeaning: match.meaning,
    };

    if (isExactDuplicate(match, candidate)) {
      items.push({
        index,
        candidate,
        suggestion: {
          action: 'skip_exact_duplicate',
          reason: '与库内现有项的 target、释义与原句完全一致，属于完全重复。',
          confidence: 1,
          source: 'rule_exact',
        },
        match: matchDto,
      });
      continue;
    }

    // AI 失败（抛错或返回 null）都走规则回退，预览不因此中断（AI_RULES §14）
    let ai: JudgeDuplicateMeaningResult | null = null;
    try {
      ai = await deps.judge(
        {
          type: match.type,
          target: match.target,
          meaning: match.meaning,
          source_example: match.sourceExample,
        },
        {
          type: candidate.type,
          target: candidate.target,
          meaning: candidate.meaning,
          source_example: candidate.source_example,
        },
      );
    } catch {
      ai = null;
    }
    if (ai) {
      items.push({
        index,
        candidate,
        suggestion: {
          action: ai.decision,
          reason: ai.reason,
          confidence: ai.confidence,
          source: 'ai',
        },
        match: matchDto,
      });
    } else {
      items.push({
        index,
        candidate,
        suggestion: {
          action: 'merge',
          reason: 'AI 判定不可用，按规则保守建议合并：保留已有进度，可在提交前逐条调整。',
          confidence: 0.5,
          source: 'rule_fallback',
        },
        match: matchDto,
      });
    }
  }

  const token = previewStore.put(
    items.map((item) => ({
      candidate: item.candidate,
      action: item.suggestion.action,
      existingId: item.match?.existingId ?? null,
    })),
  );
  return { previewToken: token, items };
}

// ---------- commit ----------

function nowIso(): string {
  return new Date().toISOString();
}

function newExampleRow(
  itemId: string,
  kind: 'source' | 'extra',
  text: string,
  sortOrder: number,
  now: string,
) {
  return {
    id: randomUUID(),
    learningItemId: itemId,
    kind,
    text,
    originalText: null,
    betterText: null,
    pinned: 0,
    qualityScore: null,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}

/** new_item：创建 Item（active + New Queue）+ source/extra 例句 + 两行零进度 review_states（同步，事务内） */
function createItemFromCandidate(tx: DbTx, candidate: LibraryImportItem): string {
  const now = nowIso();
  const id = randomUUID();
  tx.insert(learningItems)
    .values({
      id,
      type: candidate.type,
      target: candidate.target,
      meaning: candidate.meaning,
      ipa: candidate.type === 'word' ? (candidate.ipa ?? null) : null,
      source: candidate.source ?? null,
      sourceUrl: candidate.source_url ?? null,
      tagsJson: serializeTags(candidate.tags),
      notes: candidate.notes ?? null,
      status: 'active',
      queueState: 'new',
      needsReinforcement: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })
    .run();
  tx.insert(learningExamples)
    .values([
      newExampleRow(id, 'source', candidate.source_example, 0, now),
      ...candidate.extra_examples.map((text, i) => newExampleRow(id, 'extra', text, i, now)),
    ])
    .run();
  tx.insert(reviewStates)
    .values(
      (['understanding', 'production'] as const).map((dimension) => ({
        id: randomUUID(),
        learningItemId: id,
        dimension,
        level: 0,
        stable: 0,
        nextReviewAt: null,
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
        updatedAt: now,
      })),
    )
    .run();
  return id;
}

/**
 * merge：不动学习进度；保留已有 source 例句；
 * 候选例句（source_example + extra_examples）与现有例句去重后追加为 extra（软上限，超出仍追加不报错）；
 * tags 取并集；source/sourceUrl/notes 仅在原有为空时填充。（同步，事务内）
 */
function mergeCandidateIntoItem(tx: DbTx, existingId: string, candidate: LibraryImportItem): void {
  const now = nowIso();
  const existing = tx.select().from(learningItems).where(eq(learningItems.id, existingId)).get();
  if (!existing) throw appError('INTERNAL', `合并目标学习项不存在：${existingId}`);

  const examples = tx
    .select()
    .from(learningExamples)
    .where(eq(learningExamples.learningItemId, existingId))
    .all();
  const seenTexts = new Set(examples.map((e) => normalizeText(e.text)));
  const nextSortOrder =
    examples.filter((e) => e.kind === 'extra').reduce((max, e) => Math.max(max, e.sortOrder), -1) +
    1;

  const appendTexts: string[] = [];
  for (const text of [candidate.source_example, ...candidate.extra_examples]) {
    const normalized = normalizeText(text);
    if (seenTexts.has(normalized)) continue;
    seenTexts.add(normalized);
    appendTexts.push(text);
  }
  if (appendTexts.length > 0) {
    tx.insert(learningExamples)
      .values(
        appendTexts.map((text, i) =>
          newExampleRow(existingId, 'extra', text, nextSortOrder + i, now),
        ),
      )
      .run();
  }

  const mergedTags = [...parseTags(existing.tagsJson)];
  for (const tag of candidate.tags) {
    if (!mergedTags.includes(tag)) mergedTags.push(tag);
  }

  tx.update(learningItems)
    .set({
      tagsJson: serializeTags(mergedTags),
      source: existing.source ?? candidate.source ?? null,
      sourceUrl: existing.sourceUrl ?? candidate.source_url ?? null,
      notes: existing.notes ?? candidate.notes ?? null,
      updatedAt: now,
    })
    .where(eq(learningItems.id, existingId))
    .run();
}

export async function commitImport(
  db: AppDatabase,
  req: ImportCommitRequest,
): Promise<ImportCommitResponse> {
  const stored = previewStore.take(req.previewToken);
  if (!stored) throw appError('NOT_FOUND', '预览已过期，请重新预览');

  const overrides = new Map(req.decisions.map((d) => [d.index, d.action]));
  let created = 0;
  let merged = 0;
  let skipped = 0;

  db.transaction((tx: DbTx) => {
    for (const [index, entry] of stored.entries()) {
      const action = overrides.get(index) ?? entry.action;
      if (action === 'skip_exact_duplicate') {
        skipped++;
        continue;
      }
      if (action === 'merge' && entry.existingId) {
        mergeCandidateIntoItem(tx, entry.existingId, entry.candidate);
        merged++;
        continue;
      }
      // new_item；merge 但无匹配目标时防御性落为新增
      createItemFromCandidate(tx, entry.candidate);
      created++;
    }
  });

  return { created, merged, skipped, total: stored.length };
}

// ---------- export ----------

/** 导出学习库 JSON：status != archived 的全部项；personal 例句以 corrected 文本并入 extra */
export async function exportLibrary(db: AppDatabase): Promise<ExportLibraryResponse> {
  const rows = await db
    .select()
    .from(learningItems)
    .where(ne(learningItems.status, 'archived'))
    .orderBy(learningItems.createdAt, learningItems.id);
  if (rows.length === 0) return { version: '1.2', items: [] };

  const examples = await db.select().from(learningExamples);
  const byItem = new Map<string, typeof examples>();
  for (const example of examples) {
    const list = byItem.get(example.learningItemId) ?? [];
    list.push(example);
    byItem.set(example.learningItemId, list);
  }

  const items = rows.map((row) => {
    const own = byItem.get(row.id) ?? [];
    const source = own.find((e) => e.kind === 'source');
    if (!source) throw appError('INTERNAL', `学习项 ${row.id} 缺少 source 例句，无法导出`);
    const bySort = (a: (typeof examples)[number], b: (typeof examples)[number]) =>
      a.sortOrder - b.sortOrder;
    const extras = own
      .filter((e) => e.kind === 'extra')
      .sort(bySort)
      .map((e) => e.text);
    // personal.text 即 corrected 长期文本（DATABASE.md §3）
    const personals = own
      .filter((e) => e.kind === 'personal')
      .sort(bySort)
      .map((e) => e.text);
    return {
      type: row.type as 'word' | 'chunk',
      target: row.target,
      meaning: row.meaning,
      ipa: row.type === 'word' ? row.ipa : null,
      source_example: source.text,
      // LibraryImportItem 约束 extra_examples ≤ 10，超出截断
      extra_examples: [...extras, ...personals].slice(0, 10),
      source: row.source,
      source_url: row.sourceUrl,
      tags: parseTags(row.tagsJson),
      notes: row.notes,
    };
  });

  return { version: '1.2', items };
}
