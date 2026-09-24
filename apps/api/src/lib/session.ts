import { createHmac, timingSafeEqual } from 'node:crypto';

const PURPOSE = 'el_session_v1';

/** 签发无状态会话 token：`${expiryEpochSeconds}.${hex hmac}` */
export function signSession(secret: string, ttlDays: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlDays * 24 * 3600;
  return `${exp}.${hmac(secret, exp)}`;
}

export function verifySession(secret: string, token: string, now = Date.now()): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expStr) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const exp = Number(expStr);
  if (exp * 1000 <= now) return false;
  const expected = hmac(secret, exp);
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

function hmac(secret: string, exp: number): string {
  return createHmac('sha256', secret).update(`${PURPOSE}.${exp}`).digest('hex');
}
