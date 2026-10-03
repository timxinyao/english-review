import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type Grade,
} from 'ts-fsrs';

/** 一次作答的业务判定结果；tooEasy 仅在 kind='pass' 时有意义（调用方负责折算 guessed/viewedSource）
 *  （原定义于 service.ts，移入本模块以避免循环引用；service.ts re-export，消费方 import 路径不变） */
export interface ReviewOutcome {
  kind: 'pass' | 'basic_pass' | 'fail';
  tooEasy?: boolean;
}

export const MS_PER_DAY = 86_400_000;
export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 365;

/** spec 2026-10-03：默认权重 + 目标记忆率 0.90 + 上限 365 天。
 *  enable_short_term=false（ts-fsrs 5.4.2）：产品按 ≥1 天粒度排期，分钟级 learning steps
 *  在 1 天下限 clamp 下全部塌缩为 1 天，且使 Again/Good 首答同被 clamp 而 无法区分（Again 应最短）。 */
const SCHEDULER = fsrs(
  generatorParameters({
    request_retention: 0.9,
    maximum_interval: MAX_INTERVAL_DAYS,
    enable_short_term: false,
  }),
);

export function ratingOf(outcome: ReviewOutcome): Grade {
  if (outcome.kind === 'fail') return Rating.Again;
  if (outcome.kind === 'basic_pass') return Rating.Hard;
  return outcome.tooEasy === true ? Rating.Easy : Rating.Good;
}

export function newCard(now: Date): Card {
  return createEmptyCard(now);
}

/** 单次演进；due 按 1..365 天 clamp（FSRS 输出为浮点天） */
export function advanceCard(prev: Card, now: Date, rating: Grade): Card {
  const { card } = SCHEDULER.next(prev, now, rating);
  const days = Math.min(
    Math.max((card.due.getTime() - now.getTime()) / MS_PER_DAY, MIN_INTERVAL_DAYS),
    MAX_INTERVAL_DAYS,
  );
  return { ...card, due: new Date(now.getTime() + Math.round(days * MS_PER_DAY)) };
}

/** review_states 行字段 → FSRS Card（elapsed 由 last_review 推导；NULL=未激活→New 卡） */
export interface FsrStateFields {
  difficulty: number | null;
  stability: number | null;
  reps: number;
  lapses: number;
  nextReviewAt: string | null;
  lastReviewAt: string | null;
}

export function cardFromSnapshot(s: FsrStateFields, now: Date): Card {
  if (s.difficulty === null || s.stability === null || s.lastReviewAt === null) {
    return createEmptyCard(now);
  }
  const last = new Date(s.lastReviewAt);
  const due = s.nextReviewAt !== null ? new Date(s.nextReviewAt) : now;
  // ts-fsrs 5.4.2 Card 要求 scheduled_days / learning_steps；long-term 调度下均为记录字段（不参与计算）
  return {
    due,
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: Math.max(0, Math.round((now.getTime() - last.getTime()) / MS_PER_DAY)),
    scheduled_days: Math.max(0, Math.round((due.getTime() - last.getTime()) / MS_PER_DAY)),
    learning_steps: 0,
    last_review: last,
    reps: s.reps,
    lapses: s.lapses,
    state: s.reps > 0 ? State.Review : State.New,
  } satisfies Card;
}

/** 迁移回放：按时间序逐条演进（起点 New 卡） */
export function replayRatings(entries: { at: Date; rating: Grade }[]): Card {
  let card = createEmptyCard(entries[0]?.at ?? new Date());
  for (const e of entries) card = advanceCard(card, e.at, e.rating);
  return card;
}
