import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginRequest, SESSION_COOKIE_NAME, SESSION_TTL_DAYS } from '@el/shared';
import type { AppConfig } from '../../config.js';
import { appError } from '../../lib/errors.js';
import { parseBody } from '../../lib/http.js';
import { signSession } from '../../lib/session.js';
import { verifyPassword } from './service.js';

/**
 * Cookie Secure 判定：COOKIE_SECURE 显式值优先；默认 auto——
 * 经 nginx HTTPS（X-Forwarded-Proto=https）则 Secure，HTTP 直访（IP:8080）不加，
 * 双入口并存时各自正确。
 */
export function shouldSecureCookie(req: FastifyRequest, config: AppConfig): boolean {
  if (config.cookieSecure !== null) return config.cookieSecure;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  return proto.split(',')[0]?.trim() === 'https';
}

export function authRoutes(app: FastifyInstance, config: AppConfig): void {
  app.post('/api/auth/login', async (req, reply) => {
    const { password } = parseBody(LoginRequest, req.body);
    if (!verifyPassword(config, password)) {
      throw appError('INVALID_CREDENTIALS', '密码不正确');
    }
    const token = signSession(config.sessionSecret, SESSION_TTL_DAYS);
    void reply.setCookie(SESSION_COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: shouldSecureCookie(req, config),
      maxAge: SESSION_TTL_DAYS * 24 * 3600,
    });
    return { ok: true as const };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    void reply.setCookie(SESSION_COOKIE_NAME, '', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: shouldSecureCookie(req, config),
      maxAge: 0,
    });
    return { ok: true as const };
  });
}
