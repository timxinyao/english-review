import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../../src/db/client.js';

const apps: { app: FastifyInstance; db: AppDatabase }[] = [];
afterAll(async () => {
  for (const { app } of apps) await app.close();
});

function createApp() {
  const db = createDatabase(':memory:');
  runMigrations(db);
  const config = loadConfig({
    ...process.env,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    AUTH_PASSWORD: 'test-password',
    DATABASE_PATH: ':memory:',
  } as unknown as Record<string, string | undefined>);
  const app = buildApp({ config, db, logger: false });
  apps.push({ app, db });
  return app;
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'test-password' },
  });
  const setCookie = res.headers['set-cookie']!;
  const full = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  return full.split(';')[0]!;
}

describe('settings', () => {
  it('首次读取返回默认值（额度 10 / B1）', async () => {
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.maxNewItemsPerDay).toBe(10);
    expect(body.contentLevel).toBe('B1');
    expect(body.preferredTtsVoice).toBeNull();
    expect(typeof body.updatedAt).toBe('string');
  });

  it('PATCH 合法值生效', async () => {
    const app = createApp();
    const cookie = await loginCookie(app);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { maxNewItemsPerDay: 15, contentLevel: 'B2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxNewItemsPerDay).toBe(15);
    expect(res.json().contentLevel).toBe('B2');

    const again = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(again.json().maxNewItemsPerDay).toBe(15);
  });

  it('PATCH 不限制额度（-1）合法，非法值 400', async () => {
    const app = createApp();
    const cookie = await loginCookie(app);

    const unlimited = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { maxNewItemsPerDay: -1 },
    });
    expect(unlimited.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { maxNewItemsPerDay: 7 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');

    const badLevel = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { contentLevel: 'C9' },
    });
    expect(badLevel.statusCode).toBe(400);
  });
});
