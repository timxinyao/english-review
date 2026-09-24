import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';
import { loadPromptRegistry, validateRegistry } from './ai/promptRegistry.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  runMigrations(db);

  // Prompt Registry fail fast：加载失败则拒绝启动（TECHNICAL_DESIGN §10.4）
  try {
    const registry = loadPromptRegistry(fileURLToPath(new URL('../prompts', import.meta.url)));
    validateRegistry(registry);
  } catch (err) {
    console.error(`[boot] Prompt Registry 校验失败：${(err as Error).message}`);
    process.exit(1);
  }

  const app = buildApp({ config, db });
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`api listening on ${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('[boot] 启动失败：', err);
  process.exit(1);
});
