import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';

const execFileAsync = promisify(execFile);

const DAY_MS = 86_400_000;
/** S3 内的项目根前缀（TECHNICAL_DESIGN §14） */
const S3_ROOT_KEY = 'english-review';

// ---------- aws-cli 封装（可注入） ----------

export type RunAws = (args: string[]) => Promise<string>;

/** 默认实现：本机 aws-cli（v1/v2 均兼容该参数形式）；只返回 stdout */
export const runAws: RunAws = async (args) => {
  const { stdout } = await execFileAsync('aws', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

// ---------- 快照 ----------

/**
 * SQLite 一致性快照（TECHNICAL_DESIGN §11/§14：不直接复制正在写入的裸文件）。
 * 以只读连接打开源库，用 better-sqlite3 原生 backup API 落到 destPath；
 * dest 目录不存在时自动创建。
 */
export async function createSnapshot(dbPath: string, destPath: string): Promise<string> {
  mkdirSync(dirname(destPath), { recursive: true });
  const source = new Database(dbPath, { readonly: true });
  try {
    await source.backup(destPath);
  } finally {
    source.close();
  }
  return destPath;
}

// ---------- S3 轮转（纯逻辑 + aws 封装） ----------

export interface S3ListingObject {
  key: string;
  lastModified: Date;
}

export type RotatePolicy = 'daily30' | 'monthly12';

/** 当月前 12 个月的月初（UTC）：monthly12 轮转删除边界 */
function monthCutoff(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1));
}

/**
 * 轮转保留判定（纯函数）：
 * - daily30：lastModified 严格早于 now-30d 才删（30 天整保留、31 天删）。
 * - monthly12：lastModified 严格早于当月前 12 个月的月初才删（月初当天保留）。
 */
export function objectsToRotate(
  listing: S3ListingObject[],
  now: Date,
  policy: RotatePolicy,
): S3ListingObject[] {
  if (listing.length === 0) return [];
  const cutoff = policy === 'daily30' ? now.getTime() - 30 * DAY_MS : monthCutoff(now).getTime();
  return listing.filter((o) => o.lastModified.getTime() < cutoff);
}

/**
 * 解析 `aws s3 ls s3://bucket/prefix/` 输出（aws-cli v1 格式，UTC）：
 * `2026-08-25 05:00:00       20480 english-review/daily/2026-08-25.db`；
 * `PRE dir/` 目录行与空行被跳过。
 */
export function parseS3Listing(output: string): S3ListingObject[] {
  const objects: S3ListingObject[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s+\d+\s+(\S+)\s*$/);
    if (!m) continue;
    objects.push({ key: m[3], lastModified: new Date(`${m[1]}T${m[2]}Z`) });
  }
  return objects;
}

/** 列出 prefix 下对象并删除超期者；返回删除数 */
export async function rotateS3(
  runAwsFn: RunAws,
  bucket: string,
  prefix: string,
  policy: RotatePolicy,
  now: Date,
): Promise<number> {
  const listing = parseS3Listing(await runAwsFn(['s3', 'ls', `s3://${bucket}/${prefix}`]));
  const expired = objectsToRotate(listing, now, policy);
  for (const obj of expired) {
    await runAwsFn(['s3', 'rm', `s3://${bucket}/${obj.key}`]);
  }
  return expired.length;
}

/**
 * 本地轮转（无 S3 模式）：按文件名日期判定保留期（daily-<yyyy-mm-dd>.db /
 * monthly-<yyyy-mm>.db），与 S3 轮转共用 objectsToRotate 的边界规则。
 * 以文件名而非 mtime 判定，复制/移动文件不改变轮转结果；
 * daily 以整日粒度比较（now 归一到当日 00:00），保留最近 30 个日期名。
 */
export function rotateLocalSnapshots(
  snapshotsDir: string,
  prefix: 'daily' | 'monthly',
  policy: RotatePolicy,
  now: Date,
): number {
  let names: string[];
  try {
    names = readdirSync(snapshotsDir).filter(
      (n) => n.startsWith(`${prefix}-`) && n.endsWith('.db'),
    );
  } catch {
    return 0;
  }
  const objects: S3ListingObject[] = [];
  for (const name of names) {
    const daily = new RegExp(`^${prefix}-(\\d{4})-(\\d{2})-(\\d{2})\\.db$`).exec(name);
    const monthly = new RegExp(`^${prefix}-(\\d{4})-(\\d{2})\\.db$`).exec(name);
    let lastModified: Date | null = null;
    if (daily) {
      lastModified = new Date(Date.UTC(Number(daily[1]), Number(daily[2]) - 1, Number(daily[3])));
    } else if (monthly) {
      lastModified = new Date(Date.UTC(Number(monthly[1]), Number(monthly[2]) - 1, 1));
    }
    if (lastModified) objects.push({ key: name, lastModified });
  }
  const dayNormalized =
    policy === 'daily30'
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      : now;
  const expired = objectsToRotate(objects, dayNormalized, policy);
  for (const obj of expired) {
    rmSync(join(snapshotsDir, obj.key), { force: true });
  }
  return expired.length;
}

// ---------- 备份入口 ----------

export interface BackupConfig {
  /** 运行中的 SQLite 路径 */
  databasePath: string;
  /** 快照目录（与数据库同级的 snapshots/） */
  snapshotsDir: string;
  /** S3 桶名；空串 = 未配置 S3，仅本地保留一份 */
  s3Bucket: string;
}

export interface BackupRunOptions {
  now?: Date;
  /** 注入 aws 调用（测试用 fake；默认 execFile('aws', ...)） */
  runAws?: RunAws;
}

export interface BackupSummary {
  uploaded: boolean;
  /** s3:// 完整 URL，或本地保留路径 */
  target: string;
  /** 本次轮转删除的 S3 对象数 */
  rotated: number;
}

interface BackupKind {
  prefix: 'daily' | 'monthly';
  policy: RotatePolicy;
}

/**
 * 日备份（TECHNICAL_DESIGN §14）：
 * 快照 → 有 S3_BUCKET：上传 s3://<bucket>/english-review/daily/<yyyy-mm-dd>.db →
 * 立即删除本地临时快照 → S3 轮转（30 天）；
 * 无桶（本地模式）：快照落 snapshots/daily-<yyyy-mm-dd>.db（同日覆盖）→ 本地轮转
 * 删除超 30 天者。两种模式轮转策略一致，磁盘占用有界（≤30 日份 + 12 月份）。
 */
export async function runDailyBackup(
  config: BackupConfig,
  opts: BackupRunOptions = {},
): Promise<BackupSummary> {
  return runBackup(config, { prefix: 'daily', policy: 'daily30' }, opts);
}

/** 月备份：S3 monthly/ 或本地 monthly-<yyyy-mm>.db，保留最近 12 个月 */
export async function runMonthlyBackup(
  config: BackupConfig,
  opts: BackupRunOptions = {},
): Promise<BackupSummary> {
  return runBackup(config, { prefix: 'monthly', policy: 'monthly12' }, opts);
}

async function runBackup(
  config: BackupConfig,
  kind: BackupKind,
  opts: BackupRunOptions,
): Promise<BackupSummary> {
  const now = opts.now ?? new Date();
  const runAwsFn = opts.runAws ?? runAws;

  const tmpPath = join(config.snapshotsDir, `tmp-${kind.prefix}-${timestampToken(now)}.db`);
  await createSnapshot(config.databasePath, tmpPath);
  try {
    if (config.s3Bucket) {
      const url = `s3://${config.s3Bucket}/${S3_ROOT_KEY}/${kind.prefix}/${utcDateKey(now)}.db`;
      await runAwsFn(['s3', 'cp', tmpPath, url]);
      const rotated = await rotateS3(
        runAwsFn,
        config.s3Bucket,
        `${S3_ROOT_KEY}/${kind.prefix}/`,
        kind.policy,
        now,
      );
      return { uploaded: true, target: url, rotated };
    }
    // 本地模式：按日/月命名（同日重跑覆盖），随后本地轮转
    const nameKey = kind.prefix === 'daily' ? utcDateKey(now) : `${utcDateKey(now).slice(0, 7)}`;
    const localPath = join(config.snapshotsDir, `${kind.prefix}-${nameKey}.db`);
    renameSync(tmpPath, localPath);
    const rotated = rotateLocalSnapshots(config.snapshotsDir, kind.prefix, kind.policy, now);
    console.warn(
      `[backup] 未配置 S3_BUCKET，${kind.prefix} 快照本地保留（清理超期 ${rotated} 份）：${localPath}`,
    );
    return { uploaded: false, target: localPath, rotated };
  } finally {
    // 上传后立即删除本地临时快照；失败/异常路径也清理残留（rename 后 tmp 已不存在）
    rmSync(tmpPath, { force: true });
  }
}

// ---------- 工具 ----------

function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10); // yyyy-mm-dd
}

function timestampToken(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); // 20260925T050000Z
}

/** 快照目录：与数据库文件同级（DATABASE_PATH=data/dev.db → data/snapshots） */
export function defaultSnapshotsDir(databasePath: string): string {
  return join(dirname(resolve(databasePath)), 'snapshots');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const summary = await runDailyBackup({
    databasePath: config.databasePath,
    snapshotsDir: defaultSnapshotsDir(config.databasePath),
    s3Bucket: process.env.S3_BUCKET ?? '',
  });
  console.info(
    `[daily-backup] uploaded=${summary.uploaded} target=${summary.target} rotated=${summary.rotated}`,
  );
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedUrl && import.meta.url === invokedUrl) {
  main().catch((err) => {
    console.error('[daily-backup] 执行失败：', err);
    process.exitCode = 1;
  });
}
