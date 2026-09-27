import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ---------- learning_items（DATABASE.md §2）----------

export const learningItems = sqliteTable(
  'learning_items',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // word | chunk
    target: text('target').notNull(),
    meaning: text('meaning').notNull(),
    ipa: text('ipa'),
    source: text('source'),
    sourceUrl: text('source_url'),
    tagsJson: text('tags_json')
      .notNull()
      .default(sql`'[]'`),
    notes: text('notes'),
    status: text('status').notNull().default('active'), // active|mastered|paused|archived
    queueState: text('queue_state').notNull().default('new'), // new|started
    needsReinforcement: integer('needs_reinforcement').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
  },
  (t) => ({
    statusIdx: index('idx_learning_items_status').on(t.status),
    queueStateIdx: index('idx_learning_items_queue_state').on(t.queueState),
    createdAtIdx: index('idx_learning_items_created_at').on(t.createdAt),
    targetIdx: index('idx_learning_items_target').on(t.target),
  }),
);

// ---------- learning_examples（§3）----------

export const learningExamples = sqliteTable(
  'learning_examples',
  {
    id: text('id').primaryKey(),
    learningItemId: text('learning_item_id')
      .notNull()
      .references(() => learningItems.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // source | extra | personal
    text: text('text').notNull(),
    originalText: text('original_text'),
    betterText: text('better_text'),
    pinned: integer('pinned').notNull().default(0),
    qualityScore: real('quality_score'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ itemKindIdx: index('idx_examples_item_kind').on(t.learningItemId, t.kind) }),
);

// ---------- review_states（§4）----------

export const reviewStates = sqliteTable(
  'review_states',
  {
    id: text('id').primaryKey(),
    learningItemId: text('learning_item_id')
      .notNull()
      .references(() => learningItems.id, { onDelete: 'cascade' }),
    dimension: text('dimension').notNull(), // understanding | production
    level: integer('level').notNull().default(0), // 0 未激活，1..7
    stable: integer('stable').notNull().default(0),
    nextReviewAt: text('next_review_at'),
    lastReviewAt: text('last_review_at'),
    correctStreak: integer('correct_streak').notNull().default(0),
    wrongStreak: integer('wrong_streak').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    itemDimUq: uniqueIndex('uq_review_states_item_dim').on(t.learningItemId, t.dimension),
  }),
);

// ---------- questions（§7）----------

export const questions = sqliteTable(
  'questions',
  {
    id: text('id').primaryKey(),
    learningItemId: text('learning_item_id')
      .notNull()
      .references(() => learningItems.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // understanding | cloze | production
    status: text('status').notNull().default('fresh'), // fresh|active|retired|bad_question
    meaningSnapshot: text('meaning_snapshot').notNull(),
    promptText: text('prompt_text'),
    contextText: text('context_text'),
    payloadJson: text('payload_json')
      .notNull()
      .default(sql`'{}'`),
    correctOptionId: text('correct_option_id'),
    promptKey: text('prompt_key').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    promptHash: text('prompt_hash').notNull(),
    model: text('model').notNull(),
    useCount: integer('use_count').notNull().default(0),
    correctCount: integer('correct_count').notNull().default(0),
    lastUsedAt: text('last_used_at'),
    retiredAt: text('retired_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    itemTypeStatusIdx: index('idx_questions_item_type_status').on(
      t.learningItemId,
      t.type,
      t.status,
    ),
    statusRetiredIdx: index('idx_questions_status_retired').on(t.status, t.retiredAt),
  }),
);

// ---------- review_sessions（§5）----------

export const reviewSessions = sqliteTable(
  'review_sessions',
  {
    id: text('id').primaryKey(),
    sessionDate: text('session_date').notNull(), // YYYY-MM-DD（用户本地日期）
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    baseTaskCount: integer('base_task_count').notNull().default(0),
    newItemsStarted: integer('new_items_started').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ dateUq: uniqueIndex('uq_review_sessions_date').on(t.sessionDate) }),
);

// ---------- review_tasks（§6）----------

export const reviewTasks = sqliteTable(
  'review_tasks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => reviewSessions.id, { onDelete: 'cascade' }),
    learningItemId: text('learning_item_id')
      .notNull()
      .references(() => learningItems.id, { onDelete: 'cascade' }),
    dimension: text('dimension').notNull(), // understanding | production
    questionId: text('question_id').references(() => questions.id, { onDelete: 'set null' }),
    taskType: text('task_type').notNull(), // understanding|cloze|production|learn
    origin: text('origin').notNull(), // base|reinforcement|read_reinforcement
    sortKey: real('sort_key').notNull(),
    deferCount: integer('defer_count').notNull().default(0),
    completedAt: text('completed_at'),
    canceledAt: text('canceled_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    sessionSortIdx: index('idx_review_tasks_session_sort').on(t.sessionId, t.sortKey),
    itemOriginIdx: index('idx_review_tasks_item_origin').on(t.learningItemId, t.origin),
  }),
);

// ---------- attempts（§8）----------

export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    reviewTaskId: text('review_task_id').references(() => reviewTasks.id, { onDelete: 'set null' }),
    learningItemId: text('learning_item_id')
      .notNull()
      .references(() => learningItems.id, { onDelete: 'cascade' }),
    questionId: text('question_id').references(() => questions.id, { onDelete: 'set null' }),
    mode: text('mode').notNull(), // today | library_practice | read_check
    answerText: text('answer_text'),
    selectedOptionId: text('selected_option_id'),
    result: text('result').notNull(), // pass | basic_pass | fail | void
    viewedSource: integer('viewed_source').notNull().default(0),
    feedback: text('feedback'), // guessed | too_easy
    /** understanding 证据来源：recalled | assisted | forgot；其余题型与历史行为 NULL */
    outcomeSource: text('outcome_source'),
    correctionJson: text('correction_json'),
    explanation: text('explanation'),
    betterVersion: text('better_version'),
    aiPromptKey: text('ai_prompt_key'),
    aiPromptVersion: integer('ai_prompt_version'),
    aiPromptHash: text('ai_prompt_hash'),
    aiModel: text('ai_model'),
    preStateJson: text('pre_state_json'),
    postStateJson: text('post_state_json'),
    createdAt: text('created_at').notNull(),
    voidedAt: text('voided_at'),
  },
  (t) => ({
    itemCreatedIdx: index('idx_attempts_item_created').on(t.learningItemId, t.createdAt),
    taskIdx: index('idx_attempts_task').on(t.reviewTaskId),
  }),
);

// ---------- read_articles / read_article_items（§9/§10）----------

export const readArticles = sqliteTable('read_articles', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** story | daily_scene | knowledge | short_opinion（契约 ReadArticleView.type） */
  type: text('type').notNull().default('story'),
  contentLevel: text('content_level').notNull().default('B1'),
  favorite: integer('favorite').notNull().default(0),
  promptKey: text('prompt_key').notNull(),
  promptVersion: integer('prompt_version').notNull(),
  promptHash: text('prompt_hash').notNull(),
  model: text('model').notNull(),
  /** 检查题（[{id, learningItemId, question, options, correctOptionId, explanation?, answered?}]）；
   * correctOptionId 仅服务端判定用，永不下发前端 */
  checksJson: text('checks_json')
    .notNull()
    .default(sql`'[]'`),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at'),
});

export const readArticleItems = sqliteTable(
  'read_article_items',
  {
    readArticleId: text('read_article_id')
      .notNull()
      .references(() => readArticles.id, { onDelete: 'cascade' }),
    learningItemId: text('learning_item_id')
      .notNull()
      .references(() => learningItems.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // focus | old
    highlighted: integer('highlighted').notNull().default(0),
    /** focus 项在正文中的实际形式（AI coverage 持久化）；old 为 null */
    surfaceForm: text('surface_form'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.readArticleId, t.learningItemId] }) }),
);

// ---------- settings（§11）----------

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey().default(1),
  maxNewItemsPerDay: integer('max_new_items_per_day').notNull().default(10),
  contentLevel: text('content_level').notNull().default('B1'),
  preferredTtsVoice: text('preferred_tts_voice'),
  updatedAt: text('updated_at').notNull(),
});

// ---------- daily_stats（§11A，工程补齐）----------

export const dailyStats = sqliteTable('daily_stats', {
  date: text('date').primaryKey(), // YYYY-MM-DD（APP_TIMEZONE）
  formalTasksCompleted: integer('formal_tasks_completed').notNull().default(0),
  newItemsStarted: integer('new_items_started').notNull().default(0),
  productionAttempts: integer('production_attempts').notNull().default(0),
  productionPass: integer('production_pass').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

// ---------- job_locks（跨进程任务锁租约，TECHNICAL §6）----------

/** 单行租约：name 为主键；lease_until 过期视为崩溃残留可被接管 */
export const jobLocks = sqliteTable('job_locks', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  leaseUntil: text('lease_until').notNull(),
});
