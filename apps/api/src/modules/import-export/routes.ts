import type { FastifyInstance } from 'fastify';
import { ImportCommitRequest, LibraryImport } from '@el/shared';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { parseBody } from '../../lib/http.js';
import { commitImport, createRuntimeJudge, exportLibrary, previewImport } from './service.js';

export function importExportRoutes(app: FastifyInstance, db: AppDatabase, config: AppConfig): void {
  const judge = createRuntimeJudge(config);

  // LibraryImport 含 default 字段（Input ≠ Output），直接 parse；
  // 抛出的 ZodError 由 errorHandler 归一化为 400 VALIDATION_ERROR
  app.post('/api/import/preview', async (req) =>
    previewImport({ db, judge }, LibraryImport.parse(req.body)),
  );

  app.post('/api/import/commit', async (req) =>
    commitImport(db, parseBody(ImportCommitRequest, req.body)),
  );

  app.get('/api/export/library', async (_req, reply) => {
    const data = await exportLibrary(db);
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-disposition', `attachment; filename="library-${date}.json"`)
      .send(data);
  });
}
