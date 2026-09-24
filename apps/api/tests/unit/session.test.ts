import { describe, expect, it } from 'vitest';
import { SESSION_TTL_DAYS } from '@el/shared';
import { signSession, verifySession } from '../../src/lib/session.js';

const SECRET = 'unit-test-secret-0123456789abcdef';

describe('session token', () => {
  it('签发的 token 可验证通过', () => {
    const token = signSession(SECRET, SESSION_TTL_DAYS);
    expect(verifySession(SECRET, token)).toBe(true);
  });

  it('过期 token 验证失败', () => {
    const token = signSession(SECRET, 1, Date.now() - 2 * 24 * 3600 * 1000);
    expect(verifySession(SECRET, token)).toBe(false);
  });

  it('篡改 token 验证失败', () => {
    const token = signSession(SECRET, SESSION_TTL_DAYS);
    const [exp, sig] = token.split('.');
    const tampered = `${Number(exp) + 999999}.${sig}`;
    expect(verifySession(SECRET, tampered)).toBe(false);
  });

  it('密钥不匹配验证失败', () => {
    const token = signSession(SECRET, SESSION_TTL_DAYS);
    expect(verifySession('another-secret-0123456789abcdef', token)).toBe(false);
  });

  it('空/畸形 token 验证失败', () => {
    expect(verifySession(SECRET, '')).toBe(false);
    expect(verifySession(SECRET, 'abc')).toBe(false);
    expect(verifySession(SECRET, '123.456')).toBe(false);
  });
});
