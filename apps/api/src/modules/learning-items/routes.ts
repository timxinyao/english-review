import type { FastifyInstance } from 'fastify';
import { LibraryListQuery, UpdateLearningItemRequest } from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import type { AppConfig } from '../../config.js';
import { parseBody } from '../../lib/http.js';
import {
  archiveLearningItem,
  getLearningItemDetail,
  listLearningItems,
  masterLearningItem,
  pauseLearningItem,
  resetLearningItem,
  restoreLearningItem,
  resumeLearningItem,
  updateLearningItem,
} from './service.js';

function itemId(req: { params: unknown }): string {
  const { id } = req.params as { id: string };
  return id;
}

export function learningItemsRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: AppConfig,
): void {
  // LibraryListQuery 含 coerce/default（Input ≠ Output），直接 parse；
  // 抛出的 ZodError 由 errorHandler 归一化为 400 VALIDATION_ERROR
  app.get('/api/library', async (req) => listLearningItems(db, LibraryListQuery.parse(req.query)));

  app.get('/api/library/:id', async (req) => getLearningItemDetail(db, itemId(req)));

  app.patch('/api/library/:id', async (req) =>
    updateLearningItem(
      db,
      itemId(req),
      parseBody(UpdateLearningItemRequest, req.body),
      config.appTimezone,
    ),
  );

  app.post('/api/library/:id/pause', async (req) => pauseLearningItem(db, itemId(req)));
  app.post('/api/library/:id/resume', async (req) => resumeLearningItem(db, itemId(req)));
  app.post('/api/library/:id/archive', async (req) => archiveLearningItem(db, itemId(req)));
  app.post('/api/library/:id/restore', async (req) => restoreLearningItem(db, itemId(req)));
  app.post('/api/library/:id/reset', async (req) => resetLearningItem(db, itemId(req)));
  app.post('/api/library/:id/master', async (req) => masterLearningItem(db, itemId(req)));
}
