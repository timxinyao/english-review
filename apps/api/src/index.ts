import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';
import { loadPromptRegistry, validateRegistry } from './ai/promptRegistry.js';
import { applyV2Cutover } from './modules/review/v2-cutover.js';
import { applyFsrsCutover } from './modules/review/fsrs-cutover.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  runMigrations(db);

  // Prompt Registry fail fast：加载失败则拒绝启动（TECHNICAL_DESIGN §10.4）。
  // 必须先于 V2 cutover：否则校验失败退出时 DB 已被切换却没有服务可用。
  try {
    const registry = loadPromptRegistry(fileURLToPath(new URL('../prompts', import.meta.url)));
    validateRegistry(registry);
  } catch (err) {
    console.error(`[boot] Prompt Registry 校验失败：${(err as Error).message}`);
    process.exit(1);
  }

  applyV2Cutover(db, new Date(), config.appTimezone);
  // FSRS 回放迁移（Task 3）：必须在 V2 cutover 之后——先清掉旧 cloze 混入的 P 证据，
  // 再以 today 正式作答重建 D/S，避免作废证据污染回放结果。幂等（marker 'fsrs'）。
  applyFsrsCutover(db, new Date());

  const app = buildApp({ config, db });
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`api listening on ${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('[boot] 启动失败：', err);
  process.exit(1);
});
