import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { AppDatabase } from './client.js';

/** migrations 目录：模块相对定位（src/db → apps/api/drizzle） */
function migrationsFolder(): string {
  return fileURLToPath(new URL('../../drizzle', import.meta.url));
}

export function runMigrations(db: AppDatabase): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}
