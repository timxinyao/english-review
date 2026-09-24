import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../config.js';

/** 生成 scrypt 密码哈希（AUTH_PASSWORD_HASH 格式：<hex盐>:<hex哈希>） */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(config: AppConfig, password: string): boolean {
  if (config.authPasswordHash) {
    const [saltHex, hashHex] = config.authPasswordHash.split(':');
    if (!saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return timingSafeEqual(actual, expected);
  }
  if (!config.authPassword) return false;
  // 明文配置：对两侧做 SHA-256 摘要后常量时间比较，避免长度泄漏
  const a = createHash('sha256').update(password, 'utf-8').digest();
  const b = createHash('sha256').update(config.authPassword, 'utf-8').digest();
  return timingSafeEqual(a, b);
}
