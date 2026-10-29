import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDatabase, rawSqlite } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

describe('source translation additive migration', () => {
  it('upgrades a populated 0010 database without changing any existing business rows', () => {
    const migrationsDir = fileURLToPath(new URL('../../drizzle', import.meta.url));
    const legacyDir = mkdtempSync(join(tmpdir(), 'translation-migration-'));
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 10);
    mkdirSync(join(legacyDir, 'meta'));
    writeFileSync(join(legacyDir, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(join(migrationsDir, `${entry.tag}.sql`), join(legacyDir, `${entry.tag}.sql`));
    const db = createDatabase(':memory:');
    const raw = rawSqlite(db);
    try {
      migrate(db, { migrationsFolder: legacyDir });
      raw.exec(`
        INSERT INTO learning_items (id,type,target,meaning,queue_state,created_at,updated_at)
          VALUES ('existing','word','gravity','重力','started','2026-09-01','2026-10-01');
        INSERT INTO learning_examples (id,learning_item_id,kind,text,pinned,created_at,updated_at)
          VALUES ('source','existing','source','Gravity pulls things down.',0,'2026-09-01','2026-10-01'),
                 ('personal','existing','personal','Gravity keeps me on Earth.',1,'2026-09-02','2026-10-02');
        INSERT INTO review_states (id,learning_item_id,dimension,difficulty,stability,reps,lapses,next_review_at,updated_at)
          VALUES ('understanding','existing','understanding',4,30,7,2,'2026-12-01','2026-10-01');
        INSERT INTO attempts (id,learning_item_id,mode,result,created_at)
          VALUES ('history','existing','library_practice','pass','2026-10-01');
      `);
      const tables = ['learning_items', 'learning_examples', 'review_states', 'attempts'];
      const before = Object.fromEntries(
        tables.map((table) => [table, raw.prepare(`SELECT * FROM ${table}`).all()]),
      );
      runMigrations(db);
      const columns = raw.prepare('PRAGMA table_info(learning_examples)').all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      expect(columns.find((column) => column.name === 'translation')).toMatchObject({
        notnull: 0,
        dflt_value: null,
      });
      for (const table of tables) {
        const rows = raw.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        if (table === 'learning_examples')
          for (const row of rows) {
            expect(row.translation).toBeNull();
            delete row.translation;
          }
        expect(rows).toEqual(before[table]);
      }
      expect(() => runMigrations(db)).not.toThrow();
    } finally {
      raw.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
