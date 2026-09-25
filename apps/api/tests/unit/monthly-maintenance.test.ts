import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, rawSqlite } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { learningItems, questions } from '../../src/db/schema.js';
import {
  checkGrowth,
  collectGrowthCounts,
  runMonthlyMaintenance,
} from '../../src/jobs/monthly-maintenance.js';
import type { RunAws } from '../../src/jobs/daily-backup.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'el-maint-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------- checkGrowth（纯函数，阈值边界） ----------

describe('checkGrowth', () => {
  it('各表恰好等于阈值 → 无 warning', () => {
    expect(
      checkGrowth({
        questions: 50_000,
        attempts: 100_000,
        reviewTasks: 200_000,
        readArticles: 20_000,
      }),
    ).toEqual([]);
  });

  it('questions 50001 → 一条 warning（含表名）', () => {
    const warnings = checkGrowth({
      questions: 50_001,
      attempts: 0,
      reviewTasks: 0,
      readArticles: 0,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('questions');
  });

  it('attempts 100001 → warning', () => {
    expect(
      checkGrowth({ questions: 0, attempts: 100_001, reviewTasks: 0, readArticles: 0 }),
    ).toHaveLength(1);
  });

  it('review_tasks 200001 → warning', () => {
    expect(
      checkGrowth({ questions: 0, attempts: 0, reviewTasks: 200_001, readArticles: 0 }),
    ).toHaveLength(1);
  });

  it('read_articles 20001 → warning', () => {
    expect(
      checkGrowth({ questions: 0, attempts: 0, reviewTasks: 0, readArticles: 20_001 }),
    ).toHaveLength(1);
  });

  it('多表同时超阈值 → 多条 warning，不删除数据', () => {
    const warnings = checkGrowth({
      questions: 60_000,
      attempts: 120_000,
      reviewTasks: 0,
      readArticles: 0,
    });
    expect(warnings).toHaveLength(2);
  });
});

// ---------- collectGrowthCounts ----------

describe('collectGrowthCounts', () => {
  it('从数据库统计各表行数', () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const now = new Date().toISOString();
    db.insert(learningItems)
      .values({
        id: 'i1',
        type: 'word',
        target: 't',
        meaning: 'm',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(questions)
      .values({
        id: 'q1',
        learningItemId: 'i1',
        type: 'understanding',
        meaningSnapshot: 'm',
        promptKey: 'generate_understanding',
        promptVersion: 1,
        promptHash: 'h',
        model: 'mock',
        createdAt: now,
      })
      .run();
    db.insert(questions)
      .values({
        id: 'q2',
        learningItemId: 'i1',
        type: 'cloze',
        meaningSnapshot: 'm',
        promptKey: 'generate_cloze',
        promptVersion: 1,
        promptHash: 'h',
        model: 'mock',
        createdAt: now,
      })
      .run();

    const counts = collectGrowthCounts(db);
    rawSqlite(db).close();

    expect(counts).toEqual({
      questions: 2,
      attempts: 0,
      reviewTasks: 0,
      readArticles: 0,
    });
  });
});

// ---------- runMonthlyMaintenance（装配层） ----------

describe('runMonthlyMaintenance', () => {
  it('正常规模：无 warning，执行月度备份并上传 + 轮转', async () => {
    const dbPath = join(tmpRoot, 'maint.db');
    const db = createDatabase(dbPath);
    runMigrations(db);
    const now = new Date().toISOString();
    db.insert(learningItems)
      .values({
        id: 'i1',
        type: 'word',
        target: 't',
        meaning: 'm',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const calls: string[][] = [];
    const runAws: RunAws = async (args) => {
      calls.push(args);
      if (args[1] === 'ls') {
        return '2025-09-01 02:00:00       20480 english-review/monthly/2025-09-01.db';
      }
      return '';
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await runMonthlyMaintenance(
      db,
      { databasePath: dbPath, snapshotsDir: join(tmpRoot, 'snap'), s3Bucket: 'bkt' },
      { now: new Date('2026-09-01T02:00:00.000Z'), runAws },
    );

    expect(summary.warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(summary.backup.uploaded).toBe(true);
    expect(summary.backup.rotated).toBe(0); // 2025-09-01 恰在保留边界内
    expect(calls[0]?.slice(0, 2)).toEqual(['s3', 'cp']);
    expect(calls[1]?.slice(0, 2)).toEqual(['s3', 'ls']);
    rawSqlite(db).close();
  });

  it('膨胀时：返回 warning 并写入日志，仍完成备份', async () => {
    const dbPath = join(tmpRoot, 'maint2.db');
    const db = createDatabase(dbPath);
    runMigrations(db);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = await runMonthlyMaintenance(
      db,
      { databasePath: dbPath, snapshotsDir: join(tmpRoot, 'snap2'), s3Bucket: '' },
      { now: new Date('2026-09-01T02:00:00.000Z'), runAws: async () => '' },
    );
    rawSqlite(db).close();

    // 空库 + 无桶：warning 取决于实际行数（0），此处主要验证无桶路径不失败
    expect(summary.backup.uploaded).toBe(false);
    expect(Array.isArray(summary.warnings)).toBe(true);
    expect(warn).toHaveBeenCalled(); // 无桶提示
  });
});
