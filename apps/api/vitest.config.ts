import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      AUTH_PASSWORD: 'test-password',
      DATABASE_PATH: ':memory:',
    },
  },
});
