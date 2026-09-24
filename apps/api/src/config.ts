import { z } from 'zod';
import { DEFAULT_APP_TIMEZONE } from '@el/shared';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().default(5174),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SESSION_SECRET: z.string().min(16).default('dev-only-session-secret-0123456789'),
  AUTH_PASSWORD: z.string().optional(),
  AUTH_PASSWORD_HASH: z
    .string()
    .regex(/^[0-9a-f]+:[0-9a-f]+$/, '格式必须为 <hex盐>:<hex哈希>（scrypt）')
    .optional(),
  DATABASE_PATH: z.string().default('./data/dev.db'),
  APP_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  APP_TIMEZONE: z.string().default(DEFAULT_APP_TIMEZONE),
  GLM_API_KEY: z.string().optional(),
  GLM_API_BASE: z.string().default('https://open.bigmodel.cn/api/anthropic'),
  // 留空 = 自动发现（/v1/models 选最新 flash / 主模型）；非空 = 固定使用该型号
  GLM_MODEL_FLASH: z.string().default(''),
  GLM_MODEL_AIR: z.string().default(''),
  GLM_MODEL_MAX: z.string().default(''),
  GLM_MAX_TOKENS: z.coerce.number().int().min(256).default(8192),
});

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: 'development' | 'test' | 'production';
  sessionSecret: string;
  authPassword?: string;
  authPasswordHash?: string;
  databasePath: string;
  appOrigins: string[];
  appTimezone: string;
  glmApiKey?: string;
  glmApiBase: string;
  glmModels: { flash: string; air: string; max: string };
  glmMaxTokens: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`环境变量配置无效：${issues}`);
  }
  const e = parsed.data;

  if (e.NODE_ENV === 'production' && e.SESSION_SECRET.startsWith('dev-only')) {
    throw new Error('生产环境必须设置 SESSION_SECRET');
  }
  if (!e.AUTH_PASSWORD && !e.AUTH_PASSWORD_HASH) {
    throw new Error('必须设置 AUTH_PASSWORD 或 AUTH_PASSWORD_HASH 之一');
  }

  return {
    port: e.PORT,
    host: e.HOST,
    nodeEnv: e.NODE_ENV,
    sessionSecret: e.SESSION_SECRET,
    authPassword: e.AUTH_PASSWORD,
    authPasswordHash: e.AUTH_PASSWORD_HASH,
    databasePath: e.DATABASE_PATH,
    appOrigins: e.APP_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    appTimezone: e.APP_TIMEZONE,
    glmApiKey: e.GLM_API_KEY,
    glmApiBase: e.GLM_API_BASE,
    glmModels: { flash: e.GLM_MODEL_FLASH, air: e.GLM_MODEL_AIR, max: e.GLM_MODEL_MAX },
    glmMaxTokens: e.GLM_MAX_TOKENS,
  };
}
