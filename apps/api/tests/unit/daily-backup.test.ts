import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase, rawSqlite } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { learningItems } from '../../src/db/schema.js';
import {
  createSnapshot,
  objectsToRotate,
  parseS3Listing,
  runDailyBackup,
  runMonthlyBackup,
  type RunAws,
  type S3ListingObject,
} from '../../src/jobs/daily-backup.js';

const DAY = 86_400_000;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'el-backup-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 建一个带 1 条 learning_items 的真实文件库并关闭连接 */
function makeSourceDb(name = 'source.db'): string {
  const path = join(tmpRoot, name);
  const db = createDatabase(path);
  runMigrations(db);
  const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
  db.insert(learningItems)
    .values({
      id: 'item-1',
      type: 'word',
      target: 'snapshot',
      meaning: '快照测试',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  rawSqlite(db).close();
  return path;
}

/** 记录调用序列的 fake aws；ls 调用返回固定 listing */
function fakeAws(lsOutput = ''): { run: RunAws; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunAws = async (args) => {
    calls.push(args);
    if (args[1] === 'ls') return lsOutput;
    return '';
  };
  return { run, calls };
}

// ---------- objectsToRotate（纯函数） ----------

describe('objectsToRotate', () => {
  const NOW = new Date('2026-09-25T05:00:00.000Z');

  it('daily30：30 天整保留，31 天删', () => {
    const listing: S3ListingObject[] = [
      {
        key: 'english-review/daily/2026-08-26.db',
        lastModified: new Date(NOW.getTime() - 30 * DAY),
      },
      {
        key: 'english-review/daily/2026-08-25.db',
        lastModified: new Date(NOW.getTime() - 31 * DAY),
      },
    ];
    const rotate = objectsToRotate(listing, NOW, 'daily30');
    expect(rotate.map((o) => o.key)).toEqual(['english-review/daily/2026-08-25.db']);
  });

  it('daily30：空列表返回空', () => {
    expect(objectsToRotate([], NOW, 'daily30')).toEqual([]);
  });

  it('monthly12：早于当月前 12 个月的月初才删；等于月初保留', () => {
    // now=2026-09 → cutoff=2025-09-01
    const listing: S3ListingObject[] = [
      {
        key: 'english-review/monthly/2025-09-01.db',
        lastModified: new Date('2025-09-01T00:00:00Z'),
      },
      {
        key: 'english-review/monthly/2025-08-31.db',
        lastModified: new Date('2025-08-31T23:59:59Z'),
      },
      {
        key: 'english-review/monthly/2026-09-01.db',
        lastModified: new Date('2026-09-01T02:00:00Z'),
      },
    ];
    const rotate = objectsToRotate(listing, NOW, 'monthly12');
    expect(rotate.map((o) => o.key)).toEqual(['english-review/monthly/2025-08-31.db']);
  });

  it('monthly12：跨年边界（now=2027-01-15 → cutoff=2026-01-01）', () => {
    const listing: S3ListingObject[] = [
      { key: 'm/2026-01-01.db', lastModified: new Date('2026-01-01T00:00:00Z') },
      { key: 'm/2025-12-31.db', lastModified: new Date('2025-12-31T23:59:59Z') },
    ];
    const rotate = objectsToRotate(listing, new Date('2027-01-15T00:00:00Z'), 'monthly12');
    expect(rotate.map((o) => o.key)).toEqual(['m/2025-12-31.db']);
  });
});

// ---------- parseS3Listing ----------

describe('parseS3Listing', () => {
  it('解析 aws s3 ls 输出行（UTC 时间），跳过 PRE 目录行', () => {
    const output = [
      '2026-08-25 05:00:00       20480 english-review/daily/2026-08-25.db',
      '                           PRE monthly/',
      '2026-09-24 05:00:00       20480 english-review/daily/2026-09-24.db',
      '',
    ].join('\n');
    const objects = parseS3Listing(output);
    expect(objects).toHaveLength(2);
    expect(objects[0]).toEqual({
      key: 'english-review/daily/2026-08-25.db',
      lastModified: new Date('2026-08-25T05:00:00Z'),
    });
  });
});

// ---------- createSnapshot ----------

describe('createSnapshot', () => {
  it('生成一致性快照：目录自动创建、文件可用 sqlite 打开且表/数据存在', async () => {
    const src = makeSourceDb();
    const dest = join(tmpRoot, 'nested', 'dir', 'snap.db');
    await createSnapshot(src, dest);

    const check = new Database(dest);
    try {
      const tables = check
        .prepare("select name from sqlite_master where type='table'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toContain('learning_items');
      expect(tables).toContain('questions');
      const count = check.prepare('select count(*) as n from learning_items').get() as {
        n: number;
      };
      expect(count.n).toBe(1);
    } finally {
      check.close();
    }
  });
});

// ---------- runDailyBackup ----------

describe('runDailyBackup', () => {
  const NOW = new Date('2026-09-25T05:00:00.000Z');
  const LS_OUTPUT = [
    '2026-08-25 05:00:00       20480 english-review/daily/2026-08-25.db',
    '2026-09-24 05:00:00       20480 english-review/daily/2026-09-24.db',
  ].join('\n');

  it('有桶：快照 → s3 cp 上传 → 删除本地临时 → ls 轮转 → 只 rm 过期对象', async () => {
    const src = makeSourceDb();
    const snapshotsDir = join(tmpRoot, 'snap');
    const aws = fakeAws(LS_OUTPUT);

    const summary = await runDailyBackup(
      { databasePath: src, snapshotsDir, s3Bucket: 'test-bucket' },
      { now: NOW, runAws: aws.run },
    );

    // 调用序列：cp → ls → rm（过期的一个）
    expect(aws.calls).toHaveLength(3);
    expect(aws.calls[0]?.slice(0, 2)).toEqual(['s3', 'cp']);
    expect(aws.calls[0]?.[2]).toMatch(/tmp-daily-.*\.db$/);
    expect(aws.calls[0]?.[3]).toBe('s3://test-bucket/english-review/daily/2026-09-25.db');
    expect(aws.calls[1]).toEqual(['s3', 'ls', 's3://test-bucket/english-review/daily/']);
    expect(aws.calls[2]).toEqual([
      's3',
      'rm',
      's3://test-bucket/english-review/daily/2026-08-25.db',
    ]);

    expect(summary).toEqual({
      uploaded: true,
      target: 's3://test-bucket/english-review/daily/2026-09-25.db',
      rotated: 1,
    });

    // 临时快照已删除：snapshots 目录为空
    expect(readdirSync(snapshotsDir)).toEqual([]);
  });

  it('无桶：快照落到本地 latest-daily.db（覆盖式），console.warn 但不抛错', async () => {
    const src = makeSourceDb();
    const snapshotsDir = join(tmpRoot, 'snap-local');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await runDailyBackup(
      { databasePath: src, snapshotsDir, s3Bucket: '' },
      { now: NOW },
    );

    const localPath = join(snapshotsDir, 'latest-daily.db');
    expect(summary).toEqual({ uploaded: false, target: localPath, rotated: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    const files = readdirSync(snapshotsDir);
    expect(files).toEqual(['latest-daily.db']);
    const check = new Database(localPath);
    try {
      const count = check.prepare('select count(*) as n from learning_items').get() as {
        n: number;
      };
      expect(count.n).toBe(1);
    } finally {
      check.close();
    }

    // 覆盖式：再跑一次仍是同一份文件
    const src2 = makeSourceDb('source2.db');
    await runDailyBackup(
      { databasePath: src2, snapshotsDir, s3Bucket: '' },
      { now: new Date(NOW.getTime() + DAY) },
    );
    expect(readdirSync(snapshotsDir)).toEqual(['latest-daily.db']);
  });

  it('覆盖式本地保留：同日重复执行无残留临时文件', async () => {
    const src = makeSourceDb();
    const snapshotsDir = join(tmpRoot, 'snap-idem');
    await runDailyBackup(
      { databasePath: src, snapshotsDir, s3Bucket: '' },
      { now: NOW, runAws: fakeAws().run },
    );
    await runDailyBackup(
      { databasePath: src, snapshotsDir, s3Bucket: '' },
      { now: NOW, runAws: fakeAws().run },
    );
    expect(readdirSync(snapshotsDir)).toEqual(['latest-daily.db']);
  });
});

// ---------- runMonthlyBackup ----------

describe('runMonthlyBackup', () => {
  it('monthly/ 前缀 + 12 个月轮转：早于当月前 12 个月月初的对象被 rm', async () => {
    const src = makeSourceDb();
    const NOW = new Date('2026-09-01T02:00:00.000Z');
    const LS_OUTPUT = [
      '2025-09-01 02:00:00       20480 english-review/monthly/2025-09-01.db',
      '2025-08-31 02:00:00       20480 english-review/monthly/2025-08-31.db',
    ].join('\n');
    const aws = fakeAws(LS_OUTPUT);

    const summary = await runMonthlyBackup(
      { databasePath: src, snapshotsDir: join(tmpRoot, 'snap-m'), s3Bucket: 'test-bucket' },
      { now: NOW, runAws: aws.run },
    );

    expect(summary).toEqual({
      uploaded: true,
      target: 's3://test-bucket/english-review/monthly/2026-09-01.db',
      rotated: 1,
    });
    expect(aws.calls[1]).toEqual(['s3', 'ls', 's3://test-bucket/english-review/monthly/']);
    expect(aws.calls[2]).toEqual([
      's3',
      'rm',
      's3://test-bucket/english-review/monthly/2025-08-31.db',
    ]);
    expect(readdirSync(join(tmpRoot, 'snap-m'))).toEqual([]);
  });
});
