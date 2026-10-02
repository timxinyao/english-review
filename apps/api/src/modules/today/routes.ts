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

  const lookahead = (taskId: string | undefined): void => {
    if (!taskId) return;
    // 响应先返回；仅当前 pending 任务由客户端主动 prepare，后台最多备好后续两题。
    setImmediate(() => {
      try {
        const today = getTodayStatus(db, tz, new Date());
        if (today.status !== 'active') return;
        void getSessionTasks(db, tz, new Date())
          .then((entries) => {
            const unfinished = entries.tasks.filter(
              (entry) => !entry.canceled && entry.result === null,
            );
            const currentIndex = unfinished.findIndex((entry) => entry.task.taskId === taskId);
            if (currentIndex < 0) return;
            const pending = unfinished
              .slice(currentIndex + 1, currentIndex + 3)
              .filter((entry) => entry.task.question === null);
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
    if (result.status === 'active') lookahead(result.currentTask?.taskId);
    return result;
  });

  // 同日追加学习：向已完成会话追加一批 Learn 任务并重新激活
  app.post('/api/today/extend', async () => {
    const result = await extendTodaySession(db, await resolveTodayDeps(), tz, new Date());
    lookahead(result.currentTask?.taskId);
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
