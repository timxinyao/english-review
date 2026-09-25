import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDatabase, rawSqlite, type AppDatabase } from '../db/client.js';
import { attempts, questions, readArticles, reviewTasks } from '../db/schema.js';
import {
  defaultSnapshotsDir,
  runMonthlyBackup,
  type BackupConfig,
  type BackupRunOptions,
  type BackupSummary,
} from './daily-backup.js';

/** 表行数膨胀阈值（TECHNICAL_DESIGN §12 异常膨胀检查；只告警不删数据） */
export const GROWTH_THRESHOLDS = {
  questions: 50_000,
  attempts: 100_000,
  reviewTasks: 200_000,
  readArticles: 20_000,
} as const;

export interface GrowthCounts {
  questions: number;
  attempts: number;
  reviewTasks: number;
  readArticles: number;
}

export interface MaintenanceSummary {
  warnings: string[];
  backup: BackupSummary;
}

/** 膨胀检查（纯函数）：行数严格大于阈值才告警（等于阈值不告警） */
export function checkGrowth(counts: GrowthCounts): string[] {
  const warnings: string[] = [];
  for (const [name, threshold] of Object.entries(GROWTH_THRESHOLDS)) {
    const value = counts[name as keyof GrowthCounts];
    if (value > threshold) {
      warnings.push(
        `表 ${name} 行数 ${value} 超过阈值 ${threshold}，请检查 weekly-cleanup 是否正常运行`,
      );
    }
  }
  return warnings;
}

/** 统计各核心表行数（只读） */
export function collectGrowthCounts(db: AppDatabase): GrowthCounts {
  const countOf = (
    table: typeof questions | typeof attempts | typeof reviewTasks | typeof readArticles,
  ): number => {
    const row = db
      .select({ total: sql<number>`count(*)` })
      .from(table)
      .get();
    return row ? Number(row.total) : 0;
  };
  return {
    questions: countOf(questions),
    attempts: countOf(attempts),
    reviewTasks: countOf(reviewTasks),
    readArticles: countOf(readArticles),
  };
}

/**
 * 月度维护（TECHNICAL_DESIGN §12）：膨胀检查（只告警）+ 月度长期快照上传。
 * 不修改数据库内容；备份逻辑见 daily-backup.ts。
 */
export async function runMonthlyMaintenance(
  db: AppDatabase,
  backupConfig: BackupConfig,
  opts: BackupRunOptions = {},
): Promise<MaintenanceSummary> {
  const warnings = checkGrowth(collectGrowthCounts(db));
  for (const warning of warnings) {
    console.warn(`[monthly-maintenance] ${warning}`);
  }
  const backup = await runMonthlyBackup(backupConfig, opts);
  return { warnings, backup };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  try {
    const summary = await runMonthlyMaintenance(db, {
      databasePath: config.databasePath,
      snapshotsDir: defaultSnapshotsDir(config.databasePath),
      s3Bucket: process.env.S3_BUCKET ?? '',
    });
    console.info(
      `[monthly-maintenance] warnings=${summary.warnings.length}，` +
        `backup uploaded=${summary.backup.uploaded} target=${summary.backup.target} ` +
        `rotated=${summary.backup.rotated}`,
    );
    for (const warning of summary.warnings) console.info(`[monthly-maintenance] ${warning}`);
  } finally {
    rawSqlite(db).close();
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedUrl && import.meta.url === invokedUrl) {
  main().catch((err) => {
    console.error('[monthly-maintenance] 执行失败：', err);
    process.exitCode = 1;
  });
}
