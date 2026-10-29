import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AiModelsResponse, AI_TASKS } from '@el/shared';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';

const app: FastifyInstance = (() => {
  const db = createDatabase(':memory:');
  runMigrations(db);
  const config = loadConfig({
    ...(process.env as Record<string, string | undefined>),
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    AUTH_PASSWORD: 'test-password',
    DATABASE_PATH: ':memory:',
    GLM_API_KEY: '',
    GLM_MODEL_FLASH: '',
    GLM_MODEL_AIR: '',
    GLM_MODEL_MAX: '',
  } as Record<string, string>);
  return buildApp({ config, db, logger: false });
})();

afterAll(async () => {
  await app.close();
});

async function loginCookie(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'test-password' },
  });
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc[0]! : sc!).split(';')[0]!;
}

describe('GET /api/ai/models', () => {
  it('需登录', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai/models' });
    expect(res.statusCode).toBe(401);
  });

  it('无 key → fallback 来源，响应符合契约且不暴露 endpoint', async () => {
    const cookie = await loginCookie();
    const res = await app.inject({
      method: 'GET',
      url: '/api/ai/models',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(AiModelsResponse.safeParse(body).success).toBe(true);
    expect(body.models.flash.source).toBe('fallback');
    expect(body.models.air.source).toBe('fallback');
    // All current tasks, including scramble, are exposed exactly once.
    expect(body.taskMapping.map((task: { task: string }) => task.task).sort()).toEqual([...AI_TASKS].sort());
    // 不暴露 baseUrl / apiKey
    expect(JSON.stringify(body)).not.toMatch(/bigmodel|api-key|apiKey/i);
  });
});
