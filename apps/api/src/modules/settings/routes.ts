import type { FastifyInstance } from 'fastify';
import { UpdateSettingsRequest } from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { parseBody } from '../../lib/http.js';
import { getSettings, updateSettings } from './service.js';

export function settingsRoutes(app: FastifyInstance, db: AppDatabase): void {
  app.get('/api/settings', async () => getSettings(db));

  app.patch('/api/settings', async (req) => {
    const patch = parseBody(UpdateSettingsRequest, req.body);
    return updateSettings(db, patch);
  });
}
