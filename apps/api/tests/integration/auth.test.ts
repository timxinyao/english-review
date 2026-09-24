import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';

export function createTestApp(overrides: Record<string, string> = {}) {
  const db = createDatabase(':memory:');
  runMigrations(db);
  const config = loadConfig({
    ...process.env,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    AUTH_PASSWORD: 'test-password',
    DATABASE_PATH: ':memory:',
    ...overrides,
  } as unknown as Record<string, string | undefined>);
  const app = buildApp({ config, db, logger: false });
  return { app, db };
}

describe('auth', () => {
  it('未登录访问受保护接口返回 401', async () => {
    const { app } = createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('错误密码返回 401 且错误码稳定', async () => {
    const { app } = createTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    await app.close();
  });

  it('空请求体返回 400 VALIDATION_ERROR', async () => {
    const { app } = createTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('正确密码设置 Cookie 且可访问受保护接口', async () => {
    const { app } = createTestApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'test-password' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ ok: true });

    const setCookie = login.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const ok = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it('登出返回 ok 并清除 Cookie（过期指令）', async () => {
    const { app } = createTestApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'test-password' },
    });
    const loginCookieHeader = login.headers['set-cookie'];
    const cookie = (
      Array.isArray(loginCookieHeader) ? loginCookieHeader[0] : loginCookieHeader
    )!
      .split(';')[0]!;

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    // 登出通过过期 Cookie 指令清除客户端会话（单用户无状态方案，见 ARCHITECTURE.md）
    const setCookie = logout.headers['set-cookie'];
    const cleared = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    expect(cleared).toContain('el_session=');
    await app.close();
  });

  it('非白名单 Origin 的修改型请求被拒绝', async () => {
    const { app } = createTestApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'test-password' },
    });
    const loginCookieHeader = login.headers['set-cookie'];
    const cookie = (
      Array.isArray(loginCookieHeader) ? loginCookieHeader[0] : loginCookieHeader
    )!
      .split(';')[0]!;
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie, origin: 'https://evil.example.com' },
      payload: { contentLevel: 'B2' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_ORIGIN');
    await app.close();
  });

  it('health 无需登录', async () => {
    const { app } = createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
