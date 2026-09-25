import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { shouldSecureCookie } from '../../src/modules/auth/routes.js';

function envWith(overrides: Record<string, string>): Record<string, string | undefined> {
  return {
    SESSION_SECRET: 'unit-secret-0123456789abcdef',
    AUTH_PASSWORD: 'x',
    ...overrides,
  };
}

describe('COOKIE_SECURE（HTTP/IP 部署支持）', () => {
  it('默认（未设）→ null=auto 按请求协议自适应（与 NODE_ENV 无关）', () => {
    expect(loadConfig(envWith({ NODE_ENV: 'production' })).cookieSecure).toBeNull();
    expect(loadConfig(envWith({ NODE_ENV: 'development' })).cookieSecure).toBeNull();
  });

  it('显式 false：production + HTTP 部署（IP 直访）可登录', () => {
    expect(loadConfig(envWith({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })).cookieSecure).toBe(
      false,
    );
  });

  it('显式 true：development 也可强制 Secure', () => {
    expect(loadConfig(envWith({ NODE_ENV: 'development', COOKIE_SECURE: 'true' })).cookieSecure).toBe(
      true,
    );
  });

  it('非法值：启动报错（避免静默拼错）', () => {
    expect(() => loadConfig(envWith({ COOKIE_SECURE: 'yes' }))).toThrow(/COOKIE_SECURE/);
  });
});

describe('shouldSecureCookie（auto：按请求协议自适应，双入口并存）', () => {
  it('X-Forwarded-Proto=https（经 nginx 443）→ Secure', () => {
    expect(
      shouldSecureCookie({ headers: { 'x-forwarded-proto': 'https' } } as never, loadConfig(envWith({}))),
    ).toBe(true);
  });
  it('HTTP（IP:8080 直访）→ 非 Secure，登录可用', () => {
    expect(shouldSecureCookie({ headers: {} } as never, loadConfig(envWith({ NODE_ENV: 'production' })))).toBe(
      false,
    );
  });
  it('显式 COOKIE_SECURE 覆盖一切', () => {
    expect(
      shouldSecureCookie(
        { headers: { 'x-forwarded-proto': 'https' } } as never,
        loadConfig(envWith({ COOKIE_SECURE: 'false' })),
      ),
    ).toBe(false);
  });
});
