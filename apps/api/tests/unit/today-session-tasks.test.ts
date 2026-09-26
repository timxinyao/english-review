import { beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { reviewTasks } from '../../src/db/schema.js';
import {
  answerTodayTask,
  deferTodayTask,
  getSessionTasks,
  reportBadQuestion,
  startTodaySession,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-24T02:00:00.000Z');

let db: AppDatabase;
let deps: TodayDeps;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
  deps = createFakeDeps();
});

async function seedDueChoiceItem(itemId: string): Promise<string> {
  await seedItem(db, { id: itemId, target: itemId, queueState: 'started' });
  await seedReviewState(db, itemId, 'understanding', {
    level: 3,
    nextReviewAt: '2026-09-23T00:00:00.000Z',
  });
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS, '解释文本'),
    correctOptionId: 'o1',
    contextText: 'A ____ sentence.',
    promptText: `${itemId} 在这里最接近什么意思？`,
  });
  return itemId;
}

async function startSession(): Promise<string> {
  const res = await startTodaySession(db, deps, TZ, NOW);
  if (res.status !== 'active') throw new Error(`start 失败：${res.status}`);
  return res.session.id;
}

function orderedTasks(): Array<typeof reviewTasks.$inferSelect> {
  return db.select().from(reviewTasks).orderBy(asc(reviewTasks.sortKey)).all();
}

describe('getSessionTasks（GET /api/today/tasks）', () => {
  it('无当日会话 → CONFLICT', async () => {
    await expect(getSessionTasks(db, TZ, NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('活跃会话：按 sortKey 顺序；未完成 result 为 null 且 canceled=false；已完成带首次结果摘要', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const first = orderedTasks()[0]!;
    await answerTodayTask(db, deps, TZ, NOW, first.id, { selectedOptionId: 'o1' });

    const res = await getSessionTasks(db, TZ, NOW);
    expect(res.tasks.map((e) => e.task.taskId)).toEqual(orderedTasks().map((t) => t.id));

    const answered = res.tasks.find((e) => e.task.taskId === first.id)!;
    expect(answered.canceled).toBe(false);
    expect(answered.result?.alreadyCompleted).toBe(true);
    expect(answered.result?.correct).toBe(true);

    const pending = res.tasks.find((e) => e.task.taskId !== first.id)!;
    expect(pending.result).toBeNull();
    expect(pending.canceled).toBe(false);
    expect(pending.task.item.target).toBeTruthy();
  });

  it('已撤销任务：条目仍在、canceled=true、result 为 null', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const first = orderedTasks()[0]!;
    await answerTodayTask(db, deps, TZ, NOW, first.id, { selectedOptionId: 'o2' }); // 答错
    reportBadQuestion(db, first.id, NOW); // 撤销

    const res = await getSessionTasks(db, TZ, NOW);
    const canceled = res.tasks.find((e) => e.task.taskId === first.id)!;
    expect(canceled.canceled).toBe(true);
    expect(canceled.result).toBeNull();
  });

  it('稍后再做改变顺序：defer 后该任务移到列表末尾', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await seedDueChoiceItem('item-c');
    await startSession();
    const first = orderedTasks()[0]!;
    deferTodayTask(db, first.id);

    const res = await getSessionTasks(db, TZ, NOW);
    expect(res.tasks[res.tasks.length - 1]!.task.taskId).toBe(first.id);
  });

  it('当日会话已完成：仍返回任务列表（最后一题反馈期间可回看）', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const only = orderedTasks()[0]!;
    await answerTodayTask(db, deps, TZ, NOW, only.id, { selectedOptionId: 'o1' });

    const res = await getSessionTasks(db, TZ, NOW);
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0]!.result?.correct).toBe(true);
  });

  it('重复调用幂等（相同返回）', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = await getSessionTasks(db, TZ, NOW);
    const b = await getSessionTasks(db, TZ, NOW);
    expect(a).toEqual(b);
  });
});
