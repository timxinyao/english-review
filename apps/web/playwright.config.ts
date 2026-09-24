import { defineConfig } from '@playwright/test';

const API_PORT = 5174;
const WEB_PORT = 5173;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
  },
  webServer: [
    {
      command: 'pnpm --filter @el/api run dev:e2e',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        AUTH_PASSWORD: 'e2e-password',
        SESSION_SECRET: 'e2e-session-secret-0123456789',
        DATABASE_PATH: './data/e2e.db',
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
      },
    },
    {
      command: 'pnpm dev',
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
