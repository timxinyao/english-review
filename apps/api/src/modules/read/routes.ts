import type { FastifyInstance } from 'fastify';
import { ReadCheckRequest, ReadFavoriteRequest, ReadHistoryQuery } from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { parseBody } from '../../lib/http.js';
import {
  answerReadCheck,
  generateReadArticle,
  getReadArticle,
  listReadHistory,
  resolveReadDeps,
  setReadFavorite,
} from './service.js';

/** Read（PRODUCT §8）：路由 + Zod 校验；选词/生成/过期/幂等规则在 service */
export function readRoutes(app: FastifyInstance, db: AppDatabase): void {
  app.post('/api/read/generate', async () =>
    generateReadArticle(db, await resolveReadDeps(), new Date()),
  );

  // ReadHistoryQuery 含 coerce/default（Input ≠ Output），直接 parse
  app.get('/api/read/history', async (req) =>
    listReadHistory(db, ReadHistoryQuery.parse(req.query), new Date()),
  );

  // 文章详情（历史项回源）；静态 /api/read/history 路由优先于本参数路由
  app.get('/api/read/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getReadArticle(db, id, new Date());
  });

  app.post('/api/read/:id/favorite', async (req) => {
    const { id } = req.params as { id: string };
    return setReadFavorite(db, id, parseBody(ReadFavoriteRequest, req.body));
  });

  app.post('/api/read/:id/check', async (req) => {
    const { id } = req.params as { id: string };
    return answerReadCheck(db, id, parseBody(ReadCheckRequest, req.body), new Date());
  });
}
