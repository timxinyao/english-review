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
  'app_metadata',
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

  it('旧记录迁移后新增覆盖列默认为 NULL，并限制为 0/1/NULL', () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const raw = rawSqlite(db);
    const columns = raw.prepare('PRAGMA table_info(learning_items)').all() as {
      name: string;
      dflt_value: string | null;
    }[];
    expect(columns.find((c) => c.name === 'production_enabled_override')?.dflt_value).toBeNull();
    raw
      .prepare(
        "INSERT INTO learning_items (id,type,target,meaning,created_at,updated_at) VALUES ('goal-test','word','word','meaning','2026-09-30','2026-09-30')",
      )
      .run();
    expect(
      (
        raw
          .prepare(
            "SELECT production_enabled_override AS value FROM learning_items WHERE id='goal-test'",
          )
          .get() as { value: number | null }
      ).value,
    ).toBeNull();
    expect(() =>
      raw
        .prepare("UPDATE learning_items SET production_enabled_override=2 WHERE id='goal-test'")
        .run(),
    ).toThrow();
  });
});
