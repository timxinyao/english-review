import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';

export interface TestApp {
  app: FastifyInstance;
  db: AppDatabase;
}

export function createTestApp(): TestApp {
  const db = createDatabase(':memory:');
  runMigrations(db);
  const config = loadConfig({
    ...process.env,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    AUTH_PASSWORD: 'test-password',
    DATABASE_PATH: ':memory:',
  } as unknown as Record<string, string | undefined>);
  const app = buildApp({ config, db, logger: false });
  return { app, db };
}

/** 登录并返回可用的 Cookie 串（`el_session=...`） */
export async function loginCookie(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'test-password' },
  });
  const setCookie = res.headers['set-cookie']!;
  const full = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  return full.split(';')[0]!;
}
