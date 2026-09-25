import type { FastifyInstance } from 'fastify';
import { LoginRequest, SESSION_COOKIE_NAME, SESSION_TTL_DAYS } from '@el/shared';
import type { AppConfig } from '../../config.js';
import { appError } from '../../lib/errors.js';
import { parseBody } from '../../lib/http.js';
import { signSession } from '../../lib/session.js';
import { verifyPassword } from './service.js';

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
      secure: config.cookieSecure,
      maxAge: SESSION_TTL_DAYS * 24 * 3600,
    });
    return { ok: true as const };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    void reply.setCookie(SESSION_COOKIE_NAME, '', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: 0,
    });
    return { ok: true as const };
  });
}
