import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  attemptItemResults,
  attempts,
  learningItems,
  questionItems,
  questions,
  reviewSessions,
  reviewTaskItems,
  reviewTasks,
} from '../../src/db/schema.js';
import { seedItem, seedQuestion } from '../helpers/seed.js';

const NOW = new Date('2026-10-28T00:00:00.000Z').toISOString();

describe('scramble multi-item link tables', () => {
  it('creates review_task_items / question_items / attempt_item_results with constraints', () => {
    const db = createDatabase(':memory:');
    runMigrations(db);

    db.insert(reviewSessions)
      .values({
        id: 'sess-1',
        sessionDate: '2026-10-28',
        startedAt: NOW,
        baseTaskCount: 1,
        newItemsStarted: 0,
        createdAt: NOW,
        abandonedAt: null,
      })
      .run();
    const primary = 'item-primary';
    const participant = 'item-participant';
    for (const [id, type] of [
      [primary, 'chunk'],
      [participant, 'word'],
    ] as const) {
      db.insert(learningItems)
        .values({
          id,
          type,
          target: `${id}-target`,
          meaning: '测试释义',
          status: 'active',
          queueState: 'started',
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    }
    db.insert(reviewTasks)
      .values({
        id: 'task-1',
        sessionId: 'sess-1',
        learningItemId: primary,
        dimension: 'production',
        questionId: null,
        taskType: 'production',
        origin: 'base',
        sortKey: 1,
        createdAt: NOW,
      })
      .run();
    db.insert(reviewTaskItems)
      .values([
        {
          id: 'rti-1',
          reviewTaskId: 'task-1',
          learningItemId: primary,
          role: 'primary',
          result: null,
          sortIndex: 0,
          createdAt: NOW,
        },
        {
          id: 'rti-2',
          reviewTaskId: 'task-1',
          learningItemId: participant,
          role: 'participant',
          result: null,
          sortIndex: 1,
          createdAt: NOW,
        },
      ])
      .run();

    // 唯一约束：(review_task_id, learning_item_id)
    expect(() =>
      db.insert(reviewTaskItems)
        .values({
          id: 'rti-dup',
          reviewTaskId: 'task-1',
          learningItemId: primary,
          role: 'participant',
          result: null,
          sortIndex: 2,
          createdAt: NOW,
        })
        .run(),
    ).toThrow();

    const questionId = 'q-scramble';
    db.insert(questions)
      .values({
        id: questionId,
        learningItemId: primary,
        type: 'production',
        status: 'fresh',
        meaningSnapshot: '测试释义',
        promptText: '长期开会让我很累。',
        payloadJson: '{}',
        promptKey: 'generate_production_scramble',
        promptVersion: 1,
        promptHash: 'hash',
        model: 'mock',
        createdAt: NOW,
      })
      .run();
    db.insert(questionItems)
      .values([
        {
          id: 'qi-1',
          questionId,
          learningItemId: primary,
          sortIndex: 0,
          createdAt: NOW,
        },
        {
          id: 'qi-2',
          questionId,
          learningItemId: participant,
          sortIndex: 1,
          createdAt: NOW,
        },
      ])
      .run();
    expect(db.select().from(questionItems).all()).toHaveLength(2);

    db.insert(attempts)
      .values({
        id: 'attempt-1',
        reviewTaskId: 'task-1',
        learningItemId: primary,
        questionId: questionId,
        mode: 'today',
        result: 'pass',
        createdAt: NOW,
      })
      .run();
    db.insert(attemptItemResults)
      .values([
        {
          id: 'air-1',
          attemptId: 'attempt-1',
          learningItemId: primary,
          result: 'pass',
          detailJson: null,
          createdAt: NOW,
        },
        {
          id: 'air-2',
          attemptId: 'attempt-1',
          learningItemId: participant,
          result: 'fail',
          detailJson: null,
          createdAt: NOW,
        },
      ])
      .run();
    expect(db.select().from(attemptItemResults).all()).toHaveLength(2);
  });

  it('cascades review_task_items when the task is deleted', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    db.insert(reviewSessions)
      .values({
        id: 'sess-1',
        sessionDate: '2026-10-28',
        startedAt: NOW,
        baseTaskCount: 1,
        newItemsStarted: 0,
        createdAt: NOW,
        abandonedAt: null,
      })
      .run();
    const itemId = await seedItem(db);
    db.insert(reviewTasks)
      .values({
        id: 'task-1',
        sessionId: 'sess-1',
        learningItemId: itemId,
        dimension: 'production',
        questionId: null,
        taskType: 'production',
        origin: 'base',
        sortKey: 1,
        createdAt: NOW,
      })
      .run();
    db.insert(reviewTaskItems)
      .values({
        id: 'rti-1',
        reviewTaskId: 'task-1',
        learningItemId: itemId,
        role: 'primary',
        result: null,
        sortIndex: 0,
        createdAt: NOW,
      })
      .run();

    db.delete(reviewTasks).where(eq(reviewTasks.id, 'task-1')).run();

    expect(db.select().from(reviewTaskItems).all()).toHaveLength(0);
  });

  it('question_items cascades with the question row', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const itemId = await seedItem(db);
    const questionId = await seedQuestion(db, itemId, {
      type: 'production',
      promptKey: 'generate_production_scramble',
    });
    db.insert(questionItems)
      .values({
        id: 'qi-1',
        questionId,
        learningItemId: itemId,
        sortIndex: 0,
        createdAt: NOW,
      })
      .run();

    db.delete(questions).where(eq(questions.id, questionId)).run();

    expect(db.select().from(questionItems).all()).toHaveLength(0);
  });
});
