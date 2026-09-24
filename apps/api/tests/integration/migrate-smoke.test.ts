import { describe, expect, it } from 'vitest';
import { createDatabase, rawSqlite } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const EXPECTED_TABLES = [
  'learning_items',
  'learning_examples',
  'review_states',
  'review_sessions',
  'review_tasks',
  'questions',
  'attempts',
  'read_articles',
  'read_article_items',
  'settings',
  'daily_stats',
];

describe('migration smoke', () => {
  it('空库执行 migration 后全部表存在', () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const names = rawSqlite(db)
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = names.map((r) => r.name);
    for (const t of EXPECTED_TABLES) {
      expect(tableNames, `missing table: ${t}`).toContain(t);
    }
  });

  it('migration 可重复执行（幂等）', () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
