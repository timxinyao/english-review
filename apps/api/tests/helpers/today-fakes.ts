import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { MASTERED_STABILITY_DAYS } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import { learningItems, questions, reviewStates } from '../../src/db/schema.js';
import { advanceCard, cardFromSnapshot, ratingOf } from '../../src/modules/review/fsrs-engine.js';
import type {
  DbExecutor,
  DbTx,
  ProductionEvaluation,
  QuestionRow,
} from '../../src/modules/questions/service.js';
import type {
  DimSnapshot,
  EvaluateOutcome,
  QuestionKind,
  ReviewOutcomeInput,
  TodayDeps,
} from '../../src/modules/today/service.js';

const MS_PER_DAY = 86_400_000;
const DAY_MS = MS_PER_DAY;

function isoPlusDays(now: Date, days: number): string {
  return new Date(now.getTime() + Math.round(days * MS_PER_DAY)).toISOString();
}

/** 未激活快照（与 review.INACTIVE_SNAPSHOT 同形） */
const INACTIVE: DimSnapshot = {
  difficulty: null,
  stability: null,
  reps: 0,
  lapses: 0,
  nextReviewAt: null,
  lastReviewAt: null,
  correctStreak: 0,
  wrongStreak: 0,
};

/** 与 review.computeNextReviewState 相同的 FSRS 推进（直接复用 fsrs-engine，保证 fake 语义一致） */
function computeNext(current: DimSnapshot, outcome: ReviewOutcomeInput, now: Date): DimSnapshot {
  const card = advanceCard(cardFromSnapshot(current, now), now, ratingOf(outcome));
  return {
    difficulty: card.difficulty,
    stability: card.stability,
    reps: card.reps,
    lapses: card.lapses,
    nextReviewAt: card.due.toISOString(),
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
    difficulty: next.difficulty,
    stability: next.stability,
    reps: next.reps,
    lapses: next.lapses,
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
    difficulty: row.difficulty,
    stability: row.stability,
    reps: row.reps,
    lapses: row.lapses,
    nextReviewAt: row.nextReviewAt,
    lastReviewAt: row.lastReviewAt,
    correctStreak: row.correctStreak,
    wrongStreak: row.wrongStreak,
  };
}

export interface FakeDepsOptions {
  /** `${itemId}:${type}` 命中时 AI 生成抛错 */
  generateFailFor?: Set<string>;
  /** 表达题批改直接抛错（模拟 AI 失败路径） */
  productionFail?: boolean;
  /** 自定义批改结果（默认：mustUse 归一化包含于答案 → pass，否则 fail） */
  productionEval?: (question: QuestionRow, answerText: string) => ProductionEvaluation;
}

const FAKE_PROMPT_META = { key: 'check_production', version: 1, hash: 'fake-hash', model: 'fake' };

/** 解析表达题 payload（mustUse / referenceAnswer；失败回退 target） */
function productionPayloadOf(
  question: QuestionRow,
  fallbackTarget: string,
): { mustUse: string; referenceAnswer: string } {
  try {
    const p = JSON.parse(question.payloadJson) as { mustUse?: string; referenceAnswer?: string };
    return {
      mustUse: p.mustUse || fallbackTarget,
      referenceAnswer: p.referenceAnswer || `They ${fallbackTarget} naturally.`,
    };
  } catch {
    return { mustUse: fallbackTarget, referenceAnswer: `They ${fallbackTarget} naturally.` };
  }
}

/**
 * 按真实模块语义实现的 review / questions fake（公式与排序镜像 src/modules/{review,questions}）：
 * - advance = advanceReviewState：读行→计算（fsrs-engine）→写回→两维 S≥120 置 mastered
 * - acquire 按 lastUsedAt 最旧优先（支持测试用排除列表）
 * - generate 插入一道确定题（cloze 遵循 promptText 存 text_with_blank 的约定）
 * - evaluateProduction：mustUse 归一化包含于答案 → pass（eligible，0.9）；否则 fail
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

      // 两维均越过掌握线（S≥120）→ mastered（与真实 advanceReviewState 一致）
      const states = tx
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.learningItemId, itemId))
        .all();
      if (
        states.length === 2 &&
        states.every(
          (s) => typeof s.stability === 'number' && s.stability >= MASTERED_STABILITY_DAYS,
        )
      ) {
        tx.update(learningItems)
          .set({ status: 'mastered', updatedAt: nowIso })
          .where(eq(learningItems.id, itemId))
          .run();
      }
      return { pre, post };
    },
    initialUnderstandingAfterLearn(outcome, now) {
      return computeNext(INACTIVE, outcome, now); // 首答即首评分建 U
    },
    initialProductionActivation(now) {
      return {
        difficulty: null,
        stability: null,
        reps: 0,
        lapses: 0,
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
    async generate(db: AppDatabase, itemId, type: QuestionKind) {
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
            meaningSnapshot:
              db.select().from(learningItems).where(eq(learningItems.id, itemId)).get()?.meaning ??
              'fake',
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
      } else if (type === 'production') {
        const item = db.select().from(learningItems).where(eq(learningItems.id, itemId)).get();
        const target = item?.target ?? 'target';
        db.insert(questions)
          .values({
            id,
            learningItemId: itemId,
            type,
            status: 'fresh',
            meaningSnapshot: item?.meaning ?? 'fake',
            promptText: `请使用（${target}）完成表达。`,
            contextText: null,
            payloadJson: JSON.stringify({
              mustUse: target,
              referenceAnswer: `They ${target} naturally.`,
              acceptanceNotes: '允许变化。',
            }),
            correctOptionId: null,
            promptKey: 'generate_production_prompt',
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
            meaningSnapshot:
              db.select().from(learningItems).where(eq(learningItems.id, itemId)).get()?.meaning ??
              'fake',
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
    async evaluateProduction(db: AppDatabase, question: QuestionRow, answerText: string) {
      if (opts.productionFail) throw new Error('模拟批改失败（fake）');
      if (opts.productionEval) return opts.productionEval(question, answerText);
      const item = db
        .select()
        .from(learningItems)
        .where(eq(learningItems.id, question.learningItemId))
        .get();
      const { mustUse, referenceAnswer } = productionPayloadOf(question, item?.target ?? 'target');
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const used = norm(answerText).includes(norm(mustUse));
      if (used) {
        return {
          result: 'pass',
          correctedSentence: answerText,
          segments: [{ text: answerText, type: 'same' }],
          explanation: 'fake：目标使用正确。',
          betterVersion: null,
          betterVersionKind: null,
          candidate: { eligible: true, source: 'corrected', qualityScore: 0.9, reason: 'fake' },
          promptMeta: FAKE_PROMPT_META,
        };
      }
      return {
        result: 'fail',
        correctedSentence: referenceAnswer,
        segments: [
          { text: answerText, type: 'delete' },
          { text: referenceAnswer, type: 'insert' },
        ],
        explanation: 'fake：未使用目标表达。',
        betterVersion: null,
        betterVersionKind: null,
        candidate: { eligible: false, source: null, qualityScore: 0, reason: 'fake' },
        promptMeta: FAKE_PROMPT_META,
      };
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
