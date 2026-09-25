import type { FastifyInstance } from 'fastify';
import {
  BackupExport,
  ImportCommitRequest,
  LibraryImport,
  localDateString,
  RestoreCommitRequest,
} from '@el/shared';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { parseBody } from '../../lib/http.js';
import {
  commitImport,
  commitRestore,
  createRuntimeJudge,
  exportBackup,
  exportLibrary,
  previewImport,
  previewRestore,
} from './service.js';

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

  // ---------- 完整备份 / 覆盖恢复（PRODUCT §9.3） ----------

  app.get('/api/export/backup', async (_req, reply) => {
    const now = new Date();
    const data = exportBackup(db, now);
    const stamp = localDateString(now, config.appTimezone).replace(/-/g, '');
    return reply
      .header('content-disposition', `attachment; filename="english-review-backup-${stamp}.json"`)
      .send(data);
  });

  app.post('/api/restore/preview', async (req) =>
    previewRestore(db, parseBody(BackupExport, req.body)),
  );

  app.post('/api/restore/commit', async (req) =>
    commitRestore(db, config, parseBody(RestoreCommitRequest, req.body), new Date()),
  );
}
