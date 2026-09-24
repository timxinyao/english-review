/** Playwright E2E 专用 API 服务：独立临时数据库 + 环境变量注入 */
import { rmSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';

function main(): void {
  // 清理旧 e2e 数据库，保证每次运行从空库开始
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`./data/e2e${suffix === '' ? '.db' : `.db${suffix}`}`, { force: true });
  }

  const config = loadConfig();
  const db = createDatabase('./data/e2e.db');
  runMigrations(db);
  const app = buildApp({ config, db, logger: false });

  void app.listen({ port: config.port, host: config.host }).then(() => {
    console.info(`[e2e] api listening on ${config.host}:${config.port}`);
  });
}

main();
