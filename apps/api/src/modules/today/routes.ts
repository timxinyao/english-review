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

  app.post('/api/today/start', async () =>
    startTodaySession(db, await resolveTodayDeps(), tz, new Date()),
  );

  // 同日追加学习：向已完成会话追加一批 Learn 任务并重新激活
  app.post('/api/today/extend', async () =>
    extendTodaySession(db, await resolveTodayDeps(), tz, new Date()),
  );

  app.post('/api/today/tasks/:id/answer', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AnswerRequest, req.body);
    return answerTodayTask(db, await resolveTodayDeps(), tz, new Date(), id, body);
  });

  app.post('/api/today/tasks/:id/later', async (req) => {
    const { id } = req.params as { id: string };
    return deferTodayTask(db, id);
  });

  app.post('/api/today/tasks/:id/bad-question', async (req) => {
    const { id } = req.params as { id: string };
    return reportBadQuestion(db, id, new Date());
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
