import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { SESSION_COOKIE_NAME } from '@el/shared';
import type { AppConfig } from './config.js';
import type { AppDatabase } from './db/client.js';
import { AppError } from './lib/errors.js';
import { errorHandler } from './lib/http.js';
import { verifySession } from './lib/session.js';
import { initAiRuntime } from './ai/runtime.js';
import { authRoutes } from './modules/auth/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { importExportRoutes } from './modules/import-export/routes.js';
import { learningItemsRoutes } from './modules/learning-items/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';

const PUBLIC_ROUTES = new Set(['POST/api/auth/login', 'GET/api/health']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AppOptions {
  config: AppConfig;
  db: AppDatabase;
  logger?: boolean;
}

export function buildApp({ config, db, logger = true }: AppOptions): FastifyInstance {
  const app = Fastify({ logger });

  void app.register(cookie);
  app.setErrorHandler(errorHandler);

  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (PUBLIC_ROUTES.has(`${req.method}${path}`)) return;

    // 修改型接口做 Origin 白名单校验（TECHNICAL_DESIGN §13.3）
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !config.appOrigins.includes(origin)) {
        throw new AppError('FORBIDDEN_ORIGIN', '来源不被允许');
      }
    }

    const token = req.cookies[SESSION_COOKIE_NAME];
    if (!token || !verifySession(config.sessionSecret, token)) {
      throw new AppError('UNAUTHORIZED', '未登录或会话已过期');
    }
  });

  // AI 运行时单例：Registry 加载/校验失败则构建失败（fail fast，行为与 index.ts 启动校验一致）
  initAiRuntime(config);

  healthRoutes(app);
  authRoutes(app, config);
  settingsRoutes(app, db);
  learningItemsRoutes(app, db);
  importExportRoutes(app, db, config);

  return app;
}
