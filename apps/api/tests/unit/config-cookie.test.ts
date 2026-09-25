import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

function envWith(overrides: Record<string, string>): Record<string, string | undefined> {
  return {
    SESSION_SECRET: 'unit-secret-0123456789abcdef',
    AUTH_PASSWORD: 'x',
    ...overrides,
  };
}

describe('COOKIE_SECURE（HTTP/IP 部署支持）', () => {
  it('默认：production=true、development=false', () => {
    expect(loadConfig(envWith({ NODE_ENV: 'production' })).cookieSecure).toBe(true);
    expect(loadConfig(envWith({ NODE_ENV: 'development' })).cookieSecure).toBe(false);
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
