import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { INTERVALS_DAYS } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import { learningItems, questions, reviewStates } from '../../src/db/schema.js';
import type { DbExecutor, DbTx } from '../../src/modules/questions/service.js';
import type {
  DimSnapshot,
  EvaluateOutcome,
  QuestionKind,
  QuestionRow,
  ReviewOutcomeInput,
  TodayDeps,
} from '../../src/modules/today/service.js';

const MS_PER_DAY = 86_400_000;
const DAY_MS = MS_PER_DAY;

function isoPlusDays(now: Date, days: number): string {
  return new Date(now.getTime() + Math.round(days * MS_PER_DAY)).toISOString();
}

/** 与 review.computeNextReviewState 相同的阶梯公式（镜像真实模块，保证 fake 语义一致） */
const INACTIVE: DimSnapshot = {
  level: 0,
  stable: false,
  nextReviewAt: null,
  lastReviewAt: null,
  correctStreak: 0,
  wrongStreak: 0,
};

function intervalAt(level: number): number {
  return INTERVALS_DAYS[Math.min(Math.max(level, 1), 7) - 1]!;
}

function computeNext(current: DimSnapshot, outcome: ReviewOutcomeInput, now: Date): DimSnapshot {
  let level = current.level;
  let stable = current.stable;
  let intervalDays: number;
  if (outcome.kind === 'pass') {
    if (current.stable) {
      intervalDays = INTERVALS_DAYS[6]!;
    } else {
      const extra = outcome.tooEasy === true ? 1 : 0;
      level = Math.min(current.level + 1 + extra, 7);
      stable = current.level >= 7;
      intervalDays = INTERVALS_DAYS[level - 1]!;
    }
  } else if (outcome.kind === 'basic_pass') {
    intervalDays = Math.max(intervalAt(current.level) * 0.5, 1);
  } else {
    level = Math.max(current.level - 1, 1);
    intervalDays = Math.max(INTERVALS_DAYS[level - 1]! * 0.5, 1);
  }
  return {
    level,
    stable,
    nextReviewAt: stable ? null : isoPlusDays(now, intervalDays),
    lastReviewAt: now.toISOString(),
    correctStreak: outcome.kind === 'pass' ? current.correctStreak + 1 : 0,
    wrongStreak: outcome.kind === 'fail' ? current.wrongStreak + 1 : 0,
  };
}

function upsertDimState(
  tx: DbTx,
  itemId: string,
  dimension: 'understanding' | 'production',
  next: DimSnapshot,
  nowIso: string,
): void {
  const values = {
    level: next.level,
    stable: next.stable ? 1 : 0,
    nextReviewAt: next.nextReviewAt,
    lastReviewAt: next.lastReviewAt,
    correctStreak: next.correctStreak,
    wrongStreak: next.wrongStreak,
    updatedAt: nowIso,
  };
  const updated = tx
    .update(reviewStates)
    .set(values)
    .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dimension)))
    .run();
  if (updated.changes === 0) {
    tx.insert(reviewStates)
      .values({ id: randomUUID(), learningItemId: itemId, dimension, ...values })
      .run();
  }
}

function rowToDim(row: typeof reviewStates.$inferSelect): DimSnapshot {
  return {
    level: row.level,
    stable: row.stable === 1,
    nextReviewAt: row.nextReviewAt,
    lastReviewAt: row.lastReviewAt,
    correctStreak: row.correctStreak,
    wrongStreak: row.wrongStreak,
  };
}

export interface FakeDepsOptions {
  /** `${itemId}:${type}` 命中时 AI 生成抛错 */
  generateFailFor?: Set<string>;
}

/**
 * 按真实模块语义实现的 review / questions fake（公式与排序镜像 src/modules/{review,questions}）：
 * - advance = advanceReviewState：读行→计算→写回→两维 stable 置 mastered
 * - acquire 按 lastUsedAt 最旧优先（支持测试用排除列表）
 * - generate 插入一道确定题（cloze 遵循 promptText 存 text_with_blank 的约定）
 */
export function createFakeDeps(opts: FakeDepsOptions = {}): TodayDeps {
  return {
    advance(tx, itemId, dimension, outcome, now) {
      const nowIso = now.toISOString();
      const existing = tx
        .select()
        .from(reviewStates)
        .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dimension)))
        .get();
      const pre = existing ? rowToDim(existing) : null;
      const post = computeNext(pre ?? INACTIVE, outcome, now);
      upsertDimState(tx, itemId, dimension, post, nowIso);

      // 两维均 stable → mastered（与真实 advanceReviewState 一致）
      const states = tx
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.learningItemId, itemId))
        .all();
      if (states.length === 2 && states.every((s) => s.stable === 1)) {
        tx.update(learningItems)
          .set({ status: 'mastered', updatedAt: nowIso })
          .where(eq(learningItems.id, itemId))
          .run();
      }
      return { pre, post };
    },
    initialUnderstandingAfterLearn(now) {
      return computeNext(INACTIVE, { kind: 'pass' }, now); // L1、next=+1d、记一次答对
    },
    initialProductionActivation(now) {
      return {
        level: 0,
        stable: false,
        nextReviewAt: isoPlusDays(now, 1),
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
      };
    },
    acquire(exec: DbExecutor, itemId, type: QuestionKind, now, excludeQuestionIds?: string[]) {
      const excluded = excludeQuestionIds ?? [];
      const candidate = exec
        .select()
        .from(questions)
        .where(
          and(
            eq(questions.learningItemId, itemId),
            eq(questions.type, type),
            inArray(questions.status, ['fresh', 'active']),
          ),
        )
        .all()
        .filter((q) => !excluded.includes(q.id))
        .sort((a, b) => {
          // 从未使用优先，其次 lastUsedAt 最旧
          if (a.lastUsedAt === null && b.lastUsedAt !== null) return -1;
          if (a.lastUsedAt !== null && b.lastUsedAt === null) return 1;
          return (a.lastUsedAt ?? '').localeCompare(b.lastUsedAt ?? '');
        })[0];
      if (!candidate) return null;
      const nowIso = now.toISOString();
      const patch = { status: 'active', useCount: candidate.useCount + 1, lastUsedAt: nowIso };
      exec.update(questions).set(patch).where(eq(questions.id, candidate.id)).run();
      return { ...candidate, ...patch } as QuestionRow;
    },
    async generate(db: AppDatabase, itemId, type) {
      if (opts.generateFailFor?.has(`${itemId}:${type}`)) {
        throw new Error('AI 生成失败（fake）');
      }
      const nowIso = new Date().toISOString();
      const id = `gen-${randomUUID()}`;
      if (type === 'cloze') {
        db.insert(questions)
          .values({
            id,
            learningItemId: itemId,
            type,
            status: 'fresh',
            meaningSnapshot: 'fake',
            promptText: 'This is a ____ blank.',
            contextText: null,
            payloadJson: JSON.stringify({ acceptedAnswers: ['fake'] }),
            correctOptionId: null,
            promptKey: 'generate_cloze',
            promptVersion: 1,
            promptHash: 'fake-hash',
            model: 'fake',
            useCount: 0,
            correctCount: 0,
            lastUsedAt: null,
            retiredAt: null,
            createdAt: nowIso,
          })
          .run();
      } else {
        db.insert(questions)
          .values({
            id,
            learningItemId: itemId,
            type,
            status: 'fresh',
            meaningSnapshot: 'fake',
            promptText: 'fake 最接近什么意思？',
            contextText: null,
            payloadJson: JSON.stringify({
              options: [
                { id: 'g1', text: '甲' },
                { id: 'g2', text: '乙' },
              ],
            }),
            correctOptionId: 'g1',
            promptKey: 'generate_understanding',
            promptVersion: 1,
            promptHash: 'fake-hash',
            model: 'fake',
            useCount: 0,
            correctCount: 0,
            lastUsedAt: null,
            retiredAt: null,
            createdAt: nowIso,
          })
          .run();
      }
      return id;
    },
    evaluateChoice(question, selectedOptionId): EvaluateOutcome {
      return { correct: question.correctOptionId === selectedOptionId };
    },
    async evaluateCloze(_db, question, answerText) {
      let accepted: string[] = [];
      try {
        const payload = JSON.parse(question.payloadJson) as { acceptedAnswers?: string[] };
        accepted = Array.isArray(payload.acceptedAnswers) ? payload.acceptedAnswers : [];
      } catch {
        accepted = [];
      }
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      return { correct: accepted.some((a) => norm(a) === norm(answerText)) };
    },
  };
}

/** 标准选择题（4 选项，o1 正确） */
export function choicePayload(
  options: Array<{ id: string; text: string }>,
  explanation?: string,
): string {
  return JSON.stringify(explanation ? { options, explanation } : { options });
}

export const DEFAULT_OPTIONS = [
  { id: 'o1', text: '正确项' },
  { id: 'o2', text: '干扰 1' },
  { id: 'o3', text: '干扰 2' },
  { id: 'o4', text: '干扰 3' },
];

export { DAY_MS };
