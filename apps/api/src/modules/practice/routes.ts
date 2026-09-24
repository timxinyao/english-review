import type { FastifyInstance } from 'fastify';
import { PracticeAnswerRequest } from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { parseBody } from '../../lib/http.js';
import { answerLibraryPractice, resolvePracticeDeps, startLibraryPractice } from './service.js';

/** Library 单项「练一下」（PRODUCT §4.4）：路由 + Zod 校验；业务规则在 service */
export function practiceRoutes(app: FastifyInstance, db: AppDatabase): void {
  app.post('/api/library/:id/practice', async (req) => {
    const { id } = req.params as { id: string };
    return startLibraryPractice(db, await resolvePracticeDeps(), id, new Date());
  });

  app.post('/api/library/:id/practice/:questionId/answer', async (req) => {
    const { id, questionId } = req.params as { id: string; questionId: string };
    const body = parseBody(PracticeAnswerRequest, req.body);
    return answerLibraryPractice(db, await resolvePracticeDeps(), id, questionId, body, new Date());
  });
}
