/** Playwright E2E 专用 API 服务：独立临时数据库（每次运行前清空）；E2E_SEED=1 时播种确定性数据 */
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDatabase, type AppDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import {
  learningExamples,
  learningItems,
  questions,
  readArticleItems,
  readArticles,
  reviewStates,
} from '../src/db/schema.js';
import { setTodayDepsForTests, loadRealTodayDeps } from '../src/modules/today/service.js';
import { loadRealPracticeDeps, setPracticeDepsForTests } from '../src/modules/practice/service.js';
import {
  setReadDepsForTests,
  type ReadGeneration,
  type ReadSelection,
} from '../src/modules/read/service.js';
import type { ProductionEvaluation, QuestionRow } from '../src/modules/questions/service.js';

// ---------------------------------------------------------------------------
// E2E 确定性播种（前端 Playwright 依赖这些内容，勿随意改动文案）
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;

interface SeedQuestionSpec {
  id: string;
  itemId: string;
  type: 'understanding' | 'cloze';
  contextText: string | null;
  promptText: string | null;
  payload: Record<string, unknown>;
  correctOptionId: string | null;
}

const SEED_QUESTIONS: SeedQuestionSpec[] = [
  {
    id: 'e2e-q-stable',
    itemId: 'e2e-item-stable',
    type: 'understanding',
    contextText: 'The connection is finally ____.',
    promptText: 'stable 在这里最接近什么意思？',
    payload: {
      options: [
        { id: 'o1', text: '稳定的' },
        { id: 'o2', text: '快速的' },
        { id: 'o3', text: '昂贵的' },
        { id: 'o4', text: '危险的' },
      ],
      explanation: 'stable 表示稳定。',
    },
    correctOptionId: 'o1',
  },
  {
    id: 'e2e-q-wear-down',
    itemId: 'e2e-item-wear-down',
    type: 'understanding',
    contextText: 'Long-term stress can ____ you down.',
    promptText: 'wear down 在这里最接近什么意思？',
    payload: {
      options: [
        { id: 'o1', text: '逐渐消耗' },
        { id: 'o2', text: '支持' },
        { id: 'o3', text: '加速' },
        { id: 'o4', text: '打断' },
      ],
      explanation: 'wear down 表示逐渐消耗。',
    },
    correctOptionId: 'o1',
  },
  {
    id: 'e2e-q-raw',
    itemId: 'e2e-item-raw',
    type: 'cloze',
    // questions 模块约定：cloze 的 text_with_blank 存 promptText
    contextText: null,
    promptText: 'We need the ____ data before processing.',
    payload: { acceptedAnswers: ['raw'], explanation: 'raw 表示未经处理的。' },
    correctOptionId: null,
  },
  {
    id: 'e2e-q-make-sense',
    itemId: 'e2e-item-make-sense',
    type: 'understanding',
    contextText: 'His explanation ____ to me.',
    promptText: 'make sense 在这里最接近什么意思？',
    payload: {
      options: [
        { id: 'o1', text: '讲得通' },
        { id: 'o2', text: '失败' },
        { id: 'o3', text: '离开' },
        { id: 'o4', text: '开始' },
      ],
      explanation: 'make sense 表示讲得通。',
    },
    correctOptionId: 'o1',
  },
  {
    id: 'e2e-q-gravity',
    itemId: 'e2e-item-gravity',
    type: 'understanding',
    contextText: '____ keeps us on the ground.',
    promptText: 'gravity 最接近什么意思？',
    payload: {
      options: [
        { id: 'o1', text: '重力' },
        { id: 'o2', text: '声音' },
        { id: 'o3', text: '光线' },
        { id: 'o4', text: '时间' },
      ],
      explanation: 'gravity 是重力。',
    },
    correctOptionId: 'o1',
  },
];

/**
 * Phase 4 表达题种子（前端 Playwright 依赖以下文案，勿随意改动）：
 * word "give up"（放弃）——U=S130 掌握线（七天后到期，今天不出题）、P=S25 昨日到期（today 会出表达题），
 * 附 1 道 production 种子题。幂等：已存在 target='give up' 即跳过。
 */
function seedGiveUp(db: AppDatabase, now: Date): boolean {
  const existing = db
    .select()
    .from(learningItems)
    .all()
    .some((i) => i.target === 'give up');
  if (existing) return false;

  const nowIso = now.toISOString();
  const yesterday = new Date(now.getTime() - DAY_MS).toISOString();
  const fourDaysAgo = new Date(now.getTime() - 4 * DAY_MS).toISOString();
  const createdAt = '2026-09-10T00:00:00.000Z';

  db.insert(learningItems)
    .values({
      id: 'e2e-item-give-up',
      type: 'word',
      productionEnabledOverride: 1,
      target: 'give up',
      meaning: '放弃',
      ipa: null,
      source: null,
      sourceUrl: null,
      tagsJson: '[]',
      notes: null,
      status: 'active',
      queueState: 'started',
      needsReinforcement: 0,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
    })
    .run();
  db.insert(learningExamples)
    .values({
      id: 'e2e-ex-e2e-item-give-up',
      learningItemId: 'e2e-item-give-up',
      kind: 'source',
      text: 'After months of failure, he refused to give up.',
      originalText: null,
      betterText: null,
      pinned: 0,
      qualityScore: null,
      sortOrder: 0,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
  // U=S130（掌握线、七天后才到期，今天不出题）；P=S25 due yesterday
  db.insert(reviewStates)
    .values({
      id: 'e2e-state-e2e-item-give-up-understanding',
      learningItemId: 'e2e-item-give-up',
      dimension: 'understanding',
      difficulty: 5,
      stability: 130,
      reps: 7,
      lapses: 0,
      nextReviewAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
      lastReviewAt: fourDaysAgo,
      correctStreak: 7,
      wrongStreak: 0,
      updatedAt: nowIso,
    })
    .run();
  db.insert(reviewStates)
    .values({
      id: 'e2e-state-e2e-item-give-up-production',
      learningItemId: 'e2e-item-give-up',
      dimension: 'production',
      difficulty: 5,
      stability: 25,
      reps: 4,
      lapses: 0,
      nextReviewAt: yesterday,
      lastReviewAt: fourDaysAgo,
      correctStreak: 4,
      wrongStreak: 0,
      updatedAt: nowIso,
    })
    .run();
  db.insert(questions)
    .values({
      id: 'e2e-q-give-up',
      learningItemId: 'e2e-item-give-up',
      type: 'production',
      status: 'fresh',
      meaningSnapshot: '放弃',
      promptText: '长期的压力让我想放弃。',
      contextText: null,
      payloadJson: JSON.stringify({
        mustUse: 'give up',
        referenceAnswer: 'The constant stress makes me want to give up.',
        acceptanceNotes: '允许正常时态和人称变化。',
      }),
      correctOptionId: null,
      promptKey: 'seed',
      promptVersion: 1,
      promptHash: 'seed',
      model: 'seed',
      useCount: 0,
      correctCount: 0,
      lastUsedAt: null,
      retiredAt: null,
      createdAt,
    })
    .run();
  // 撤销重练的替换题（Phase 8 Task 5 E2E）：同 item 另一道 production。
  // lastUsedAt 置旧值（acquireQuestion 优先 lastUsedAt IS NULL），主流程会话仍先取原题，
  // 撤销排除原题后才轮到它——避免改动既有用例依赖的首卡题面。
  db.insert(questions)
    .values({
      id: 'e2e-q-give-up-2',
      learningItemId: 'e2e-item-give-up',
      type: 'production',
      status: 'active',
      meaningSnapshot: '放弃',
      promptText: '他去年决定放弃吸烟。',
      contextText: null,
      payloadJson: JSON.stringify({
        mustUse: 'give up',
        referenceAnswer: 'He decided to give up smoking last year.',
        acceptanceNotes: '允许正常时态和人称变化。',
      }),
      correctOptionId: null,
      promptKey: 'seed',
      promptVersion: 1,
      promptHash: 'seed',
      model: 'seed',
      useCount: 1,
      correctCount: 1,
      lastUsedAt: '2026-09-01T00:00:00.000Z',
      retiredAt: null,
      createdAt,
    })
    .run();
  // Phase 9（Task 8）V2 练一下种子：practice start 必取一道 understanding 作 Recall
  // （Hint 选项来源）；AI 在 e2e 不可用，无库存会直接 502。
  db.insert(questions)
    .values({
      id: 'e2e-q-give-up-u',
      learningItemId: 'e2e-item-give-up',
      type: 'understanding',
      status: 'fresh',
      meaningSnapshot: '放弃',
      promptText: 'give up 最接近什么意思？',
      contextText: null,
      payloadJson: JSON.stringify({
        options: [
          { id: 'o1', text: '放弃' },
          { id: 'o2', text: '坚持' },
          { id: 'o3', text: '举起' },
          { id: 'o4', text: '抱怨' },
        ],
        explanation: 'give up 表示放弃。',
      }),
      correctOptionId: 'o1',
      promptKey: 'seed',
      promptVersion: 1,
      promptHash: 'seed',
      model: 'seed',
      useCount: 0,
      correctCount: 0,
      lastUsedAt: null,
      retiredAt: null,
      createdAt,
    })
    .run();
  return true;
}

/**
 * 播种幂等：已存在 seed 标记（target='stable' 且 queue started 的项）则跳过。
 * 返回是否实际播种。
 */
export function seedE2eData(db: AppDatabase, now = new Date()): boolean {
  const marker = db
    .select()
    .from(learningItems)
    .all()
    .find((i) => i.target === 'stable' && i.queueState === 'started');
  if (marker) {
    seedGiveUp(db, now); // Phase 4 种子独立幂等
    seedLegacyReadArticle(db); // Phase 9 遗留 Read 文章独立幂等
    return false;
  }

  const nowIso = now.toISOString();
  const yesterday = new Date(now.getTime() - DAY_MS).toISOString();
  const fourDaysAgo = new Date(now.getTime() - 4 * DAY_MS).toISOString();
  const createdAt = '2026-09-10T00:00:00.000Z';

  const items: Array<Partial<typeof learningItems.$inferInsert> & { id: string }> = [
    {
      id: 'e2e-item-stable',
      type: 'word',
      target: 'stable',
      meaning: '稳定的',
      ipa: null,
      status: 'active',
      queueState: 'started',
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: 'e2e-item-wear-down',
      type: 'chunk',
      target: 'wear down',
      meaning: '逐渐消耗',
      ipa: null,
      status: 'active',
      queueState: 'started',
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: 'e2e-item-raw',
      type: 'word',
      target: 'raw',
      meaning: '未经处理的',
      ipa: null,
      status: 'active',
      queueState: 'started',
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: 'e2e-item-make-sense',
      type: 'chunk',
      target: 'make sense',
      meaning: '讲得通',
      ipa: null,
      status: 'active',
      queueState: 'started',
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: 'e2e-item-gravity',
      type: 'word',
      target: 'gravity',
      meaning: '重力',
      ipa: null,
      status: 'active',
      queueState: 'new',
      createdAt,
      updatedAt: createdAt,
    },
  ];
  for (const item of items) {
    db.insert(learningItems)
      .values({
        type: 'word',
        target: item.id,
        meaning: '',
        ipa: null,
        source: null,
        sourceUrl: null,
        tagsJson: '[]',
        notes: null,
        status: 'active',
        queueState: 'new',
        needsReinforcement: 0,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        ...item,
      })
      .run();
  }

  const examples: Array<{ itemId: string; text: string }> = [
    { itemId: 'e2e-item-stable', text: 'The connection has been stable all week.' },
    { itemId: 'e2e-item-wear-down', text: 'The long hike wore me down.' },
    { itemId: 'e2e-item-raw', text: 'We only had raw data at first.' },
    { itemId: 'e2e-item-make-sense', text: 'His explanation makes sense to me.' },
    { itemId: 'e2e-item-gravity', text: 'I laugh at gravity all the time.' },
  ];
  for (const ex of examples) {
    db.insert(learningExamples)
      .values({
        id: `e2e-ex-${ex.itemId}`,
        learningItemId: ex.itemId,
        kind: 'source',
        text: ex.text,
        originalText: null,
        betterText: null,
        pinned: 0,
        qualityScore: null,
        sortOrder: 0,
        createdAt,
        updatedAt: createdAt,
      })
      .run();
  }

  const states: Array<{
    itemId: string;
    dimension: 'understanding' | 'production';
    /** 旧 level 档位的 FSRS stability 换算（1→2、2→5、3→15、5→45） */
    stability: number;
    reps: number;
    nextReviewAt: string | null;
    lastReviewAt: string | null;
  }> = [
    {
      itemId: 'e2e-item-stable',
      dimension: 'understanding',
      stability: 15,
      reps: 3,
      nextReviewAt: yesterday,
      lastReviewAt: fourDaysAgo,
    },
    {
      itemId: 'e2e-item-wear-down',
      dimension: 'understanding',
      stability: 5,
      reps: 2,
      nextReviewAt: yesterday,
      lastReviewAt: fourDaysAgo,
    },
    {
      itemId: 'e2e-item-raw',
      dimension: 'understanding',
      stability: 5,
      reps: 2,
      nextReviewAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
      lastReviewAt: fourDaysAgo,
    },
    {
      itemId: 'e2e-item-raw',
      dimension: 'production',
      stability: 2,
      reps: 1,
      nextReviewAt: yesterday,
      lastReviewAt: fourDaysAgo,
    },
    {
      itemId: 'e2e-item-make-sense',
      dimension: 'understanding',
      stability: 45,
      reps: 5,
      nextReviewAt: yesterday,
      lastReviewAt: fourDaysAgo,
    },
  ];
  for (const st of states) {
    db.insert(reviewStates)
      .values({
        id: `e2e-state-${st.itemId}-${st.dimension}`,
        learningItemId: st.itemId,
        dimension: st.dimension,
        difficulty: 5,
        stability: st.stability,
        reps: st.reps,
        lapses: 0,
        nextReviewAt: st.nextReviewAt,
        lastReviewAt: st.lastReviewAt,
        correctStreak: st.reps,
        wrongStreak: 0,
        updatedAt: nowIso,
      })
      .run();
  }

  for (const q of SEED_QUESTIONS) {
    db.insert(questions)
      .values({
        id: q.id,
        learningItemId: q.itemId,
        type: q.type,
        status: 'fresh',
        meaningSnapshot: items.find((i) => i.id === q.itemId)?.meaning ?? '',
        promptText: q.promptText,
        contextText: q.contextText,
        payloadJson: JSON.stringify(q.payload),
        correctOptionId: q.correctOptionId,
        promptKey: 'seed',
        promptVersion: 1,
        promptHash: 'seed',
        model: 'seed',
        useCount: 0,
        correctCount: 0,
        lastUsedAt: null,
        retiredAt: null,
        createdAt,
      })
      .run();
  }
  // Phase 9（Task 10）：chunk 默认造句开的练一下表达题库存（make sense 无 P 状态，
  // 不进 Today，仅 Library Practice 取用；不加会因 e2e 无 AI 而降级为只出 recall）
  db.insert(questions)
    .values({
      id: 'e2e-q-make-sense-p',
      learningItemId: 'e2e-item-make-sense',
      type: 'production',
      status: 'fresh',
      meaningSnapshot: '讲得通',
      promptText: '他的解释完全讲得通。',
      contextText: null,
      payloadJson: JSON.stringify({
        mustUse: 'make sense',
        referenceAnswer: 'His explanation makes complete sense to me.',
        acceptanceNotes: '允许正常时态和人称变化。',
      }),
      correctOptionId: null,
      promptKey: 'seed',
      promptVersion: 1,
      promptHash: 'seed',
      model: 'seed',
      useCount: 0,
      correctCount: 0,
      lastUsedAt: null,
      retiredAt: null,
      createdAt,
    })
    .run();
  seedGiveUp(db, now);
  // Phase 9（Task 9）：V1 遗留只读 Read 文章（幂等）
  seedLegacyReadArticle(db);
  return true;
}

// ---------------------------------------------------------------------------
// E2E 确定性批改 fake（与 "give up" 种子配套；前端 Playwright 依赖判定文案，勿随意改动）
// ---------------------------------------------------------------------------

/** normalize：小写 + 压缩空白 */
function e2eNorm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

const SEED_PROMPT_META = { key: 'seed', version: 1, hash: 'seed', model: 'seed' } as const;

/**
 * E2E_SEED=1 时注入 today / practice 的 evaluateProduction：
 * normalize(userAnswer) 包含题目 payload 的 mustUse（缺省 "give up"）→ pass（eligible 0.9）；
 * 否则 fail（corrected=reference）。Phase 9（Task 10）起按 mustUse 泛化，
 * 支撑 set off / make sense 等 V2 journey 种子题。
 */
export async function fakeEvaluateProduction(
  _db: AppDatabase,
  question: QuestionRow,
  userAnswer: string,
): Promise<ProductionEvaluation> {
  let referenceAnswer = 'The constant stress makes me want to give up.';
  let mustUse = 'give up';
  try {
    const payload = JSON.parse(question.payloadJson) as {
      referenceAnswer?: string;
      mustUse?: string;
    };
    if (typeof payload.referenceAnswer === 'string' && payload.referenceAnswer) {
      referenceAnswer = payload.referenceAnswer;
    }
    if (typeof payload.mustUse === 'string' && payload.mustUse) {
      mustUse = payload.mustUse;
    }
  } catch {
    // 种子题 payload 固定合法；保底用默认 reference/mustUse
  }
  if (e2eNorm(userAnswer).includes(e2eNorm(mustUse))) {
    return {
      result: 'pass',
      correctedSentence: userAnswer,
      segments: [{ text: userAnswer, type: 'same' }],
      explanation: '目标表达使用正确。',
      betterVersion: null,
      candidate: { eligible: true, qualityScore: 0.9, reason: 'seed' },
      promptMeta: SEED_PROMPT_META,
    };
  }
  return {
    result: 'fail',
    correctedSentence: referenceAnswer,
    segments: [
      { text: userAnswer, type: 'delete' },
      { text: referenceAnswer, type: 'insert' },
    ],
    explanation: '未使用目标表达。',
    betterVersion: null,
    candidate: { eligible: false, qualityScore: 0, reason: 'seed' },
    promptMeta: SEED_PROMPT_META,
  };
}

// ---------------------------------------------------------------------------
// E2E 确定性 Read 生成 fake（Phase 5；前端 Playwright 依赖文案，勿随意改动）
// ---------------------------------------------------------------------------

/** 固定段落（合计约 199 词；正文总词数随 focus 句递增，保持 180–400 区间） */
const READ_FAKE_PARA_1 =
  'The morning began quietly, the way it always does in this small town. ' +
  'Maya woke up before her alarm, made a cup of tea, and sat by the kitchen window. ' +
  'The street outside was almost empty. A delivery truck passed slowly, and a neighbor waved ' +
  'on his way to work. She opened her notebook and wrote a few lines about the weekend, ' +
  'then read them again and smiled. The light came in slowly, warming the table, the chair, ' +
  'and the old wooden floor. Nothing needed to hurry. The whole day was still ahead, ' +
  'patient and unhurried, waiting for her to begin.';
const READ_FAKE_PARA_3 =
  'In the evening, she walked home along the river. The water moved quietly under the bridge, ' +
  'and the sky turned soft orange behind the buildings. She thought about the words she had ' +
  'met during the day, how each one had a small history of its own. Some were heavy, some ' +
  'were light, and a few still felt like strangers. Tomorrow she would meet them again, ' +
  'in another sentence, in another quiet hour. Learning a language, she decided, was less ' +
  'about memory and more about meeting: the same words, returning like old friends, ' +
  'patient until you finally knew them.';

/**
 * E2E_SEED=1 时注入 read 模块的 generate：不用 AI，直接构造确定性文章。
 * title/type 固定；正文 3 段且包含所有 focus 的 surface_form=target 原词；
 * V2 纯阅读：不生成 checks（promptMeta 用 'seed' 占位）。
 */
export async function fakeGenerateRead(input: ReadSelection): Promise<ReadGeneration> {
  const sentences = input.focusItems
    .map(
      (f) =>
        `The phrase ${f.target} came back to her more than once that day, and each time it felt a little more natural.`,
    )
    .join(' ');
  const body = [READ_FAKE_PARA_1, sentences, READ_FAKE_PARA_3].join('\n\n');
  return {
    data: {
      title: 'A Quiet Morning',
      type: 'story',
      body,
      coverage: input.focusItems.map((f) => ({
        learning_item_id: f.id,
        surface_form: f.target,
      })),
    },
    meta: { key: 'seed', version: 2, hash: 'seed' },
    model: 'seed',
  };
}

/**
 * Phase 9（Task 9）V1 遗留 Read 文章种子：checks_json 含一答错 + 一未答检查题，
 * 详情页只读回放、无提交入口（前端 Playwright 依赖标题与文案，勿随意改动）。幂等。
 */
export function seedLegacyReadArticle(db: AppDatabase): void {
  const existing = db
    .select()
    .from(readArticles)
    .all()
    .find((a) => a.id === 'e2e-read-legacy');
  if (existing) return;

  const createdAt = '2026-09-20T00:00:00.000Z';
  db.insert(readArticles)
    .values({
      id: 'e2e-read-legacy',
      title: 'An Old Lesson',
      body:
        'The old plan stayed stable for months.\n\n' +
        'Weeks of raw data slowly wore her down, but the work still made sense.',
      type: 'knowledge',
      contentLevel: 'B1',
      favorite: 0,
      promptKey: 'generate_read',
      promptVersion: 1,
      promptHash: 'seed',
      model: 'seed',
      checksJson: JSON.stringify([
        {
          id: 'e2e-read-check-1',
          learningItemId: 'e2e-item-stable',
          question: '文中 stable 的意思是什么？',
          options: [
            { id: 'o1', text: '稳定的' },
            { id: 'o2', text: '干扰甲' },
          ],
          correctOptionId: 'o1',
          answered: {
            selectedOptionId: 'o2',
            correct: false,
            needsReinforcementMarked: true,
          },
        },
        {
          id: 'e2e-read-check-2',
          learningItemId: 'e2e-item-wear-down',
          question: '文中 wear down 的意思是什么？',
          options: [
            { id: 'o1', text: '逐渐消耗' },
            { id: 'o2', text: '干扰乙' },
          ],
          correctOptionId: 'o1',
        },
      ]),
      createdAt,
      expiresAt: null, // 收藏语义：永久可见
    })
    .run();
  for (const [itemId, surfaceForm] of [
    ['e2e-item-stable', 'stable'],
    ['e2e-item-wear-down', 'wore her down'],
  ] as const) {
    db.insert(readArticleItems)
      .values({
        readArticleId: 'e2e-read-legacy',
        learningItemId: itemId,
        role: 'focus',
        highlighted: 1,
        surfaceForm,
      })
      .run();
  }
}

// ---------------------------------------------------------------------------
// E2E 重置（测试专用端点，见 main()：多个"完整会话"spec 共享同一 e2e.db，
// 而一天只允许一个正式 session，因此每个会话型 spec 开始时重置回种子状态）
// ---------------------------------------------------------------------------

const RESET_TABLES = [
  'attempts',
  'review_tasks',
  'review_sessions',
  'questions',
  'read_article_items',
  'read_articles',
  'learning_examples',
  'review_states',
  'learning_items',
  'daily_stats',
  'settings',
];

/** 清空业务数据并重新播种（含 settings 归默认：ensureRow 按需重建，消灭跨轮污染） */
export function resetE2eData(db: AppDatabase): void {
  for (const table of RESET_TABLES) {
    db.run(sql.raw(`DELETE FROM ${table}`));
  }
  seedE2eData(db);
}

/**
 * E2E 专用：为「同日追加学习（extend）」播种一个待学新词 delta（含一道 fresh 理解题库存）。
 * 独立于 reset 种子（避免进入主流程会话改变任务数）；extend 复用题库库存
 * （AI 生成在 e2e 不可用，故必须预置题目）。幂等：已存在 target='delta' 即跳过。
 */
export function seedExtendCandidate(db: AppDatabase): void {
  const exists = db
    .select()
    .from(learningItems)
    .all()
    .some((i) => i.target === 'delta');
  if (exists) return;

  const createdAt = '2026-09-11T00:00:00.000Z';
  db.insert(learningItems)
    .values({
      id: 'e2e-item-delta',
      type: 'word',
      target: 'delta',
      meaning: '三角洲',
      ipa: null,
      source: null,
      sourceUrl: null,
      tagsJson: '[]',
      notes: null,
      status: 'active',
      queueState: 'new',
      needsReinforcement: 0,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
    })
    .run();
  db.insert(learningExamples)
    .values({
      id: 'e2e-ex-e2e-item-delta',
      learningItemId: 'e2e-item-delta',
      kind: 'source',
      text: 'The river delta splits into many channels.',
      originalText: null,
      betterText: null,
      pinned: 0,
      qualityScore: null,
      sortOrder: 0,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
  db.insert(questions)
    .values({
      id: 'e2e-q-delta',
      learningItemId: 'e2e-item-delta',
      type: 'understanding',
      status: 'fresh',
      meaningSnapshot: '三角洲',
      promptText: 'delta 最接近什么意思？',
      contextText: null,
      payloadJson: JSON.stringify({
        options: [
          { id: 'o1', text: '三角洲' },
          { id: 'o2', text: '第四' },
          { id: 'o3', text: '数据' },
          { id: 'o4', text: '增量' },
        ],
        explanation: 'delta 表示三角洲。',
      }),
      correctOptionId: 'o1',
      promptKey: 'seed',
      promptVersion: 1,
      promptHash: 'seed',
      model: 'seed',
      useCount: 0,
      correctCount: 0,
      lastUsedAt: null,
      retiredAt: null,
      createdAt,
    })
    .run();
}

// ---------------------------------------------------------------------------
// Phase 9（Task 10）V2 全流程 journey 种子（独立端点播种，不进基础种子：
// 基础种子的到期/总数被既有 spec 钉死，扩展项按用例显式播种）
// ---------------------------------------------------------------------------

/**
 * Learn→次日 Production 与显式关闭 chunk 的 journey 种子（幂等）：
 * - set off（chunk，started）：U 不到期、P L0 昨日到期 → 模拟"昨日 Learn 完成初始化、
 *   次日（今天）造句到期"，今日会话应出现其表达题（真实 Learn→次日到期由 API 单测钉死，
 *   e2e 用时钟不可跨日，以该状态近似"次日"）。
 * - carry on（chunk，New Queue）：今日 Learn 完成后应初始化 P L0 次日到期（今日无表达题）。
 * - put off（chunk，override=0，started）：P L2 昨日到期但显式关闭 → 不进今日队列、状态不动。
 */
export function seedV2Journeys(db: AppDatabase, now = new Date()): boolean {
  const existing = db
    .select()
    .from(learningItems)
    .all()
    .some((i) => i.id === 'e2e-item-set-off');
  if (existing) return false;

  const nowIso = now.toISOString();
  const yesterday = new Date(now.getTime() - DAY_MS).toISOString();
  const fourDaysAgo = new Date(now.getTime() - 4 * DAY_MS).toISOString();
  const createdAt = '2026-09-12T00:00:00.000Z';

  const items: Array<{
    id: string;
    type: 'word' | 'chunk';
    target: string;
    meaning: string;
    productionEnabledOverride: number | null;
    queueState: 'new' | 'started';
  }> = [
    {
      id: 'e2e-item-set-off',
      type: 'chunk',
      target: 'set off',
      meaning: '出发',
      productionEnabledOverride: null, // chunk 默认开
      queueState: 'started',
    },
    {
      id: 'e2e-item-carry-on',
      type: 'chunk',
      target: 'carry on',
      meaning: '继续',
      productionEnabledOverride: null,
      queueState: 'new', // 今日 Learn：完成后初始化 P L0 次日到期
    },
    {
      id: 'e2e-item-put-off',
      type: 'chunk',
      target: 'put off',
      meaning: '推迟',
      productionEnabledOverride: 0, // 显式关闭：即便 P 到期也不进队列
      queueState: 'started',
    },
  ];
  for (const item of items) {
    db.insert(learningItems)
      .values({
        id: item.id,
        type: item.type,
        productionEnabledOverride: item.productionEnabledOverride,
        target: item.target,
        meaning: item.meaning,
        ipa: null,
        source: null,
        sourceUrl: null,
        tagsJson: '[]',
        notes: null,
        status: 'active',
        queueState: item.queueState,
        needsReinforcement: 0,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
      })
      .run();
  }
  for (const [itemId, text] of [
    ['e2e-item-set-off', 'We set off at dawn to avoid the heat.'],
    ['e2e-item-carry-on', 'Please carry on with your work.'],
    ['e2e-item-put-off', 'We put off the meeting until Friday.'],
  ] as const) {
    db.insert(learningExamples)
      .values({
        id: `e2e-ex-${itemId}`,
        learningItemId: itemId,
        kind: 'source',
        text,
        originalText: null,
        betterText: null,
        pinned: 0,
        qualityScore: null,
        sortOrder: 0,
        createdAt,
        updatedAt: createdAt,
      })
      .run();
  }
  const states: Array<{
    itemId: string;
    dimension: 'understanding' | 'production';
    /** FSRS S；null=未激活 */
    stability: number | null;
    reps: number;
    nextReviewAt: string | null;
    lastReviewAt: string | null;
    correctStreak: number;
  }> = [
    // set off：U 不到期（S2）；P 未激活、昨日到期（Learn 完成后的次日到期态）
    {
      itemId: 'e2e-item-set-off',
      dimension: 'understanding',
      stability: 2,
      reps: 1,
      nextReviewAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
      lastReviewAt: fourDaysAgo,
      correctStreak: 1,
    },
    {
      itemId: 'e2e-item-set-off',
      dimension: 'production',
      stability: null,
      reps: 0,
      nextReviewAt: yesterday,
      lastReviewAt: null,
      correctStreak: 0,
    },
    // put off：U 不到期（S45）；P S5 昨日到期（显式关闭 → 被排除、保持原状）
    {
      itemId: 'e2e-item-put-off',
      dimension: 'understanding',
      stability: 45,
      reps: 5,
      nextReviewAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
      lastReviewAt: fourDaysAgo,
      correctStreak: 5,
    },
    {
      itemId: 'e2e-item-put-off',
      dimension: 'production',
      stability: 5,
      reps: 2,
      nextReviewAt: yesterday,
      lastReviewAt: fourDaysAgo,
      correctStreak: 2,
    },
  ];
  for (const st of states) {
    db.insert(reviewStates)
      .values({
        id: `e2e-state-${st.itemId}-${st.dimension}`,
        learningItemId: st.itemId,
        dimension: st.dimension,
        difficulty: st.stability === null ? null : 5,
        stability: st.stability,
        reps: st.reps,
        lapses: 0,
        nextReviewAt: st.nextReviewAt,
        lastReviewAt: st.lastReviewAt,
        correctStreak: st.correctStreak,
        wrongStreak: 0,
        updatedAt: nowIso,
      })
      .run();
  }
  const journeyQuestions: Array<{
    id: string;
    itemId: string;
    type: 'understanding' | 'production';
    meaning: string;
    promptText: string;
    payload: Record<string, unknown>;
    correctOptionId: string | null;
  }> = [
    {
      id: 'e2e-q-set-off',
      itemId: 'e2e-item-set-off',
      type: 'production',
      meaning: '出发',
      promptText: '我们天一亮就出发。',
      payload: {
        mustUse: 'set off',
        referenceAnswer: 'We set off at dawn.',
        acceptanceNotes: '允许正常时态和人称变化。',
      },
      correctOptionId: null,
    },
    {
      id: 'e2e-q-carry-on',
      itemId: 'e2e-item-carry-on',
      type: 'understanding',
      meaning: '继续',
      promptText: 'carry on 最接近什么意思？',
      payload: {
        options: [
          { id: 'o1', text: '继续' },
          { id: 'o2', text: '停止' },
          { id: 'o3', text: '携带' },
          { id: 'o4', text: '返回' },
        ],
        explanation: 'carry on 表示继续。',
      },
      correctOptionId: 'o1',
    },
    {
      id: 'e2e-q-put-off',
      itemId: 'e2e-item-put-off',
      type: 'understanding',
      meaning: '推迟',
      promptText: 'put off 最接近什么意思？',
      payload: {
        options: [
          { id: 'o1', text: '推迟' },
          { id: 'o2', text: '脱下' },
          { id: 'o3', text: '忍受' },
          { id: 'o4', text: '赞扬' },
        ],
        explanation: 'put off 表示推迟。',
      },
      correctOptionId: 'o1',
    },
  ];
  for (const q of journeyQuestions) {
    db.insert(questions)
      .values({
        id: q.id,
        learningItemId: q.itemId,
        type: q.type,
        status: 'fresh',
        meaningSnapshot: q.meaning,
        promptText: q.promptText,
        contextText: null,
        payloadJson: JSON.stringify(q.payload),
        correctOptionId: q.correctOptionId,
        promptKey: 'seed',
        promptVersion: 1,
        promptHash: 'seed',
        model: 'seed',
        useCount: 0,
        correctCount: 0,
        lastUsedAt: null,
        retiredAt: null,
        createdAt,
      })
      .run();
  }
  return true;
}

/**
 * 大队列种子（幂等）：count 个 word（默认造句关）U 维度昨日到期，各带 1 道 fresh
 * understanding 库存（prepare 直接绑定，不依赖 AI）。验证 start 建全量 pending 队列
 * 不阻塞首屏、总数含未绑定任务。默认 40。
 */
export function seedLargeDueQueue(db: AppDatabase, count = 40, now = new Date()): boolean {
  const existing = db
    .select()
    .from(learningItems)
    .all()
    .some((i) => i.id === 'e2e-item-bulk-01');
  if (existing) return false;

  const nowIso = now.toISOString();
  const yesterday = new Date(now.getTime() - DAY_MS).toISOString();
  const fourDaysAgo = new Date(now.getTime() - 4 * DAY_MS).toISOString();
  const createdAt = '2026-09-13T00:00:00.000Z';

  for (let index = 1; index <= count; index++) {
    const pad = String(index).padStart(2, '0');
    const itemId = `e2e-item-bulk-${pad}`;
    const target = `bulk word ${pad}`;
    const meaning = `批量词 ${pad}`;
    db.insert(learningItems)
      .values({
        id: itemId,
        type: 'word',
        productionEnabledOverride: null, // word 默认关：即便有 P 也不进队列
        target,
        meaning,
        ipa: null,
        source: null,
        sourceUrl: null,
        tagsJson: '[]',
        notes: null,
        status: 'active',
        queueState: 'started',
        needsReinforcement: 0,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
      })
      .run();
    db.insert(learningExamples)
      .values({
        id: `e2e-ex-${itemId}`,
        learningItemId: itemId,
        kind: 'source',
        text: `The ${target} appears somewhere in today's queue.`,
        originalText: null,
        betterText: null,
        pinned: 0,
        qualityScore: null,
        sortOrder: 0,
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    db.insert(reviewStates)
      .values({
        id: `e2e-state-${itemId}-understanding`,
        learningItemId: itemId,
        dimension: 'understanding',
        difficulty: 5,
        stability: 5,
        reps: 2,
        lapses: 0,
        nextReviewAt: yesterday,
        lastReviewAt: fourDaysAgo,
        correctStreak: 2,
        wrongStreak: 0,
        updatedAt: nowIso,
      })
      .run();
    db.insert(questions)
      .values({
        id: `e2e-q-${itemId}`,
        learningItemId: itemId,
        type: 'understanding',
        status: 'fresh',
        meaningSnapshot: meaning,
        promptText: `${target} 最接近什么意思？`,
        contextText: null,
        payloadJson: JSON.stringify({
          options: [
            { id: 'o1', text: meaning },
            { id: 'o2', text: `干扰甲 ${pad}` },
            { id: 'o3', text: `干扰乙 ${pad}` },
            { id: 'o4', text: `干扰丙 ${pad}` },
          ],
          explanation: `${target} 表示${meaning}。`,
        }),
        correctOptionId: 'o1',
        promptKey: 'seed',
        promptVersion: 1,
        promptHash: 'seed',
        model: 'seed',
        useCount: 0,
        correctCount: 0,
        lastUsedAt: null,
        retiredAt: null,
        createdAt,
      })
      .run();
  }
  return true;
}

// ---------------------------------------------------------------------------
// 服务入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const dbPath = config.databasePath.endsWith('e2e.db') ? config.databasePath : './data/e2e.db'; // 防误删：仅当路径以 e2e.db 结尾才清理
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }

  const db = createDatabase(dbPath);
  runMigrations(db);
  if (process.env.E2E_SEED === '1') {
    const seeded = seedE2eData(db);
    console.info(`[e2e] seed ${seeded ? 'created' : 'skipped (already present)'}`);
    // fake 批改注入：today 与 practice 的表达题批改不依赖 GLM key（确定性输出）
    const todayDeps = await loadRealTodayDeps();
    setTodayDepsForTests({ ...todayDeps, evaluateProduction: fakeEvaluateProduction });
    const practiceDeps = await loadRealPracticeDeps();
    setPracticeDepsForTests({ ...practiceDeps, evaluateProduction: fakeEvaluateProduction });
    console.info('[e2e] fake production evaluation injected (today + practice)');
    // fake Read 生成注入：POST /api/read/generate 不依赖 GLM key（确定性输出）
    setReadDepsForTests({ generate: fakeGenerateRead });
    console.info('[e2e] fake read generation injected');
  }
  const app = buildApp({ config, db, logger: false });
  if (process.env.E2E_SEED === '1') {
    // 测试专用：需登录会话（spec 登录后 page.evaluate 调用）
    app.post('/api/__e2e/reset', async () => {
      resetE2eData(db);
      return { ok: true as const };
    });
    // 测试专用：播种 extend 待学新词（today.spec 同日追加用例）
    app.post('/api/__e2e/seed-new-item', async () => {
      seedExtendCandidate(db);
      return { ok: true as const };
    });
    // 测试专用：播种 Phase 9 V2 journey 项（Learn→次日 Production、显式关闭 chunk）
    app.post('/api/__e2e/seed-v2-journeys', async () => {
      seedV2Journeys(db);
      return { ok: true as const };
    });
    // 测试专用：播种大队列（start 全量 pending 不阻塞首屏）
    app.post('/api/__e2e/seed-large-queue', async () => {
      seedLargeDueQueue(db);
      return { ok: true as const };
    });
  }

  await app.listen({ port: config.port, host: config.host });
  console.info(`[e2e] api listening on ${config.host}:${config.port} (db: ${dbPath})`);
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('[e2e] 启动失败：', err);
    process.exitCode = 1;
  });
}
