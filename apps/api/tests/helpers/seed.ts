import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../src/db/client.js';
import { learningExamples, learningItems, questions, reviewStates } from '../../src/db/schema.js';

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
    level: 0,
    stable: 0,
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
