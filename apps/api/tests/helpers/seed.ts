import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { localDateString } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import {
  learningExamples,
  learningItems,
  questions,
  reviewSessions,
  reviewStates,
  reviewTasks,
} from '../../src/db/schema.js';

/** 已绑定的切换前任务夹具：不调用 V2 调度/生成，不表示 V2 可分配 cloze/Read。 */
export function seedLegacyBoundTask(
  db: AppDatabase,
  itemId: string,
  questionId: string,
  now: Date,
  timezone: string,
  origin: 'base' | 'read_reinforcement' = 'base',
): string {
  const date = localDateString(now, timezone);
  let session = db.select().from(reviewSessions).where(eq(reviewSessions.sessionDate, date)).get();
  if (!session) {
    session = {
      id: randomUUID(),
      sessionDate: date,
      startedAt: now.toISOString(),
      completedAt: null,
      baseTaskCount: 0,
      newItemsStarted: 0,
      createdAt: now.toISOString(),
    };
    db.insert(reviewSessions).values(session).run();
  }
  const question = db.select().from(questions).where(eq(questions.id, questionId)).get()!;
  const id = randomUUID();
  db.insert(reviewTasks)
    .values({
      id,
      sessionId: session.id,
      learningItemId: itemId,
      dimension: question.type === 'understanding' ? 'understanding' : 'production',
      questionId,
      taskType: question.type,
      origin,
      sortKey: session.baseTaskCount + 1,
      deferCount: 0,
      completedAt: null,
      canceledAt: null,
      createdAt: now.toISOString(),
    })
    .run();
  db.update(reviewSessions)
    .set({ baseTaskCount: session.baseTaskCount + 1, completedAt: null })
    .where(eq(reviewSessions.id, session.id))
    .run();
  return id;
}

export async function seedItem(
  db: AppDatabase,
  overrides: Partial<typeof learningItems.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const now = overrides.createdAt ?? new Date().toISOString();
  await db.insert(learningItems).values({
    type: 'word',
    target: 'test-target',
    meaning: '测试释义',
    ipa: null,
    source: null,
    sourceUrl: null,
    tagsJson: '[]',
    notes: null,
    status: 'active',
    queueState: 'started',
    needsReinforcement: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides,
    id,
  });
  return id;
}

export async function seedExample(
  db: AppDatabase,
  itemId: string,
  kind: 'source' | 'extra' | 'personal',
  text: string,
  overrides: Partial<typeof learningExamples.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const now = overrides.createdAt ?? new Date().toISOString();
  await db.insert(learningExamples).values({
    learningItemId: itemId,
    kind,
    text,
    originalText: null,
    betterText: null,
    pinned: 0,
    qualityScore: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
    id,
  });
  return id;
}

export async function seedReviewState(
  db: AppDatabase,
  itemId: string,
  dimension: 'understanding' | 'production',
  overrides: Partial<typeof reviewStates.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const now = new Date().toISOString();
  await db.insert(reviewStates).values({
    learningItemId: itemId,
    dimension,
    difficulty: null,
    stability: null,
    reps: 0,
    lapses: 0,
    nextReviewAt: null,
    lastReviewAt: null,
    correctStreak: 0,
    wrongStreak: 0,
    updatedAt: now,
    ...overrides,
    id,
  });
  return id;
}

export async function seedQuestion(
  db: AppDatabase,
  itemId: string,
  overrides: Partial<typeof questions.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const now = new Date().toISOString();
  await db.insert(questions).values({
    learningItemId: itemId,
    type: 'understanding',
    status: 'fresh',
    meaningSnapshot: '测试释义',
    promptText: null,
    contextText: null,
    payloadJson: '{}',
    correctOptionId: null,
    promptKey: 'generate_understanding',
    promptVersion: 1,
    promptHash: 'test-hash',
    model: 'mock',
    useCount: 0,
    correctCount: 0,
    lastUsedAt: null,
    retiredAt: null,
    createdAt: now,
    ...overrides,
    id,
  });
  return id;
}
