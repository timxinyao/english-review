/** Playwright E2E 专用 API 服务：独立临时数据库（每次运行前清空） */
import { rmSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';

function main(): void {
  const config = loadConfig();
  const dbPath = config.databasePath.endsWith('e2e.db') ? config.databasePath : './data/e2e.db'; // 防误删：仅当路径以 e2e.db 结尾才清理
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }

  const db = createDatabase(dbPath);
  runMigrations(db);
  const app = buildApp({ config, db, logger: false });

  void app.listen({ port: config.port, host: config.host }).then(() => {
    console.info(`[e2e] api listening on ${config.host}:${config.port} (db: ${dbPath})`);
  });
}

main();
