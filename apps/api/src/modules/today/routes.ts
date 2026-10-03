import type { FastifyInstance } from 'fastify';
import { AnswerRequest, TaskFeedbackRequest } from '@el/shared';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { parseBody } from '../../lib/http.js';
import {
  answerTodayTask,
  deferTodayTask,
  extendTodaySession,
  getSessionTasks,
  getTodayStatus,
  prepareTodayTask,
  reportBadQuestion,
  resolveTodayDeps,
  startTodaySession,
  submitTaskFeedback,
  undoTodayTask,
} from './service.js';

export function todayRoutes(app: FastifyInstance, db: AppDatabase, config: AppConfig): void {
  const tz = config.appTimezone;

  app.get('/api/today', async () => getTodayStatus(db, tz, new Date()));

  app.get('/api/today/tasks', async () => getSessionTasks(db, tz, new Date()));

  // 后台一次性备好会话内全部未绑定造句题：理解/学词卡即时渲染不依赖绑定题，
  // 只有造句题需要 prepare（V2 前端 876b288/94d7d37 起不再消费前瞻绑定题）。
  const warmPendingProduction = (): void => {
    setImmediate(() => {
      try {
        const today = getTodayStatus(db, tz, new Date());
        if (today.status !== 'active') return;
        void getSessionTasks(db, tz, new Date())
          .then((entries) => {
            const pending = entries.tasks.filter(
              (entry) =>
                !entry.canceled &&
                entry.result === null &&
                entry.task.question === null &&
                entry.task.taskType === 'production',
            );
            void (async () => {
              const deps = await resolveTodayDeps();
              for (const entry of pending) {
                try {
                  await prepareTodayTask(db, deps, tz, new Date(), entry.task.taskId);
                } catch {
                  /* best effort; client can retry */
                }
              }
            })().catch(() => undefined);
          })
          .catch(() => undefined);
      } catch {
        /* best effort, including test app shutdown */
      }
    });
  };

  app.post('/api/today/start', async () => {
    const result = await startTodaySession(db, await resolveTodayDeps(), tz, new Date());
    if (result.status === 'active') warmPendingProduction();
    return result;
  });

  // 同日追加学习：向已完成会话追加一批 Learn 任务并重新激活
  app.post('/api/today/extend', async () => {
    const result = await extendTodaySession(db, await resolveTodayDeps(), tz, new Date());
    warmPendingProduction();
    return result;
  });

  app.post('/api/today/tasks/:id/prepare', async (req) => {
    const { id } = req.params as { id: string };
    return prepareTodayTask(db, await resolveTodayDeps(), tz, new Date(), id);
  });

  app.post('/api/today/tasks/:id/answer', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AnswerRequest, req.body);
    return answerTodayTask(
      db,
      await resolveTodayDeps(),
      tz,
      new Date(),
      id,
      body,
      () => new Date(),
    );
  });

  app.post('/api/today/tasks/:id/later', async (req) => {
    const { id } = req.params as { id: string };
    return deferTodayTask(db, id, tz, new Date());
  });

  app.post('/api/today/tasks/:id/bad-question', async (req) => {
    const { id } = req.params as { id: string };
    return reportBadQuestion(db, id, new Date(), tz);
  });

  // 普通撤销：精确回滚最近一次正式作答并重排一道不同的新题（区别于坏题，PRODUCT §6.5）
  app.post('/api/today/tasks/:id/undo', async (req) => {
    const { id } = req.params as { id: string };
    return undoTodayTask(db, await resolveTodayDeps(), tz, new Date(), id);
  });

  app.post('/api/today/tasks/:id/feedback', async (req) => {
    const { id } = req.params as { id: string };
    const { feedback } = parseBody(TaskFeedbackRequest, req.body);
    return submitTaskFeedback(db, await resolveTodayDeps(), tz, id, feedback, new Date());
  });
}
