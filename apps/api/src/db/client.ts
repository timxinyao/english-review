import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type AppDatabase = ReturnType<typeof createDatabase>;

/** 保留 db 实例 → 原生 better-sqlite3 句柄的映射（测试/迁移用途） */
const rawHandles = new WeakMap<object, Database.Database>();

export function createDatabase(dbPath: string) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  rawHandles.set(db, sqlite);
  return db;
}

/** 取底层 better-sqlite3 句柄（仅测试/迁移用途） */
export function rawSqlite(db: AppDatabase): Database.Database {
  const sqlite = rawHandles.get(db);
  if (!sqlite) throw new Error('未找到原生 sqlite 句柄');
  return sqlite;
}
