import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { getStats } from './service.js';

export function statsRoutes(app: FastifyInstance, db: AppDatabase, config: AppConfig): void {
  const tz = config.appTimezone;

  app.get('/api/stats', async () => getStats(db, tz, new Date()));
}
