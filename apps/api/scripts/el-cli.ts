/**
 * el-cli —— English Review 管理 CLI（供 Coding Agent / 脚本调用，与 Web 界面同一 API 契约）。
 *
 * 用法（在 apps/api 目录）：
 *   导入（与 PC 导入页同一契约，重复检测/合并由服务端执行）：
 *     tsx scripts/el-cli.ts preview <file.json|->        # '-' = stdin
 *     tsx scripts/el-cli.ts commit --token <tok> [--decision 0=new_item ...]
 *   学习库：
 *     tsx scripts/el-cli.ts find [query] [--type word|chunk] [--status active|mastered|paused|archived]
 *     tsx scripts/el-cli.ts show <id>
 *     tsx scripts/el-cli.ts set <id> --json '<UpdateLearningItemRequest 局部 JSON>'
 *     tsx scripts/el-cli.ts archive|restore|pause|resume|reset|master <id>
 *     tsx scripts/el-cli.ts stats
 *     tsx scripts/el-cli.ts backup <out.json>
 *
 * 配置（环境变量优先；否则 /etc/english-learning/env（生产）> apps/api/.env（开发））：
 *   IMPORT_API_BASE  默认 http://127.0.0.1:5174
 *   IMPORT_PASSWORD   访问密码（AUTH_PASSWORD）
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type {
  ImportPreviewResponse,
  LibraryItemDetail,
  LibraryListResponse,
  StatsResponse,
  UpdateLearningItemResponse,
} from '@el/shared';

// ---------- env / 登录 ----------

function loadEnv(): { apiBase: string; password: string } {
  const fromFile = (p: string): Record<string, string> => {
    // 文件不可读（如生产 env 为 root-only 600）时静默跳过，交给环境变量
    let raw: string;
    try {
      if (!existsSync(p)) return {};
      raw = readFileSync(p, 'utf-8');
    } catch {
      return {};
    }
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
    return out;
  };
  const file = existsSync('/etc/english-learning/env')
    ? fromFile('/etc/english-learning/env')
    : fromFile('.env');
  const pick = (name: string, fileKey?: string): string | undefined =>
    process.env[name] || file[fileKey ?? name] || undefined;
  return {
    apiBase: (pick('IMPORT_API_BASE') ?? 'http://127.0.0.1:5174').replace(/\/$/, ''),
    password: pick('IMPORT_PASSWORD', 'AUTH_PASSWORD') ?? '',
  };
}

async function login(apiBase: string, password: string): Promise<string> {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok)
    throw new Error(`登录失败：HTTP ${res.status}（检查 IMPORT_PASSWORD/AUTH_PASSWORD）`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('登录响应缺少 Cookie');
  return setCookie.split(';')[0]!;
}

type Json = Record<string, unknown>;

async function call(
  apiBase: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { cookie };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    // 字符串 body（如 preview 的原始 JSON 文本）原样发送；对象才 stringify
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(`${apiBase}${path}`, { method, headers, body: payload });
}

async function callJson<T>(...args: Parameters<typeof call>): Promise<{ status: number; data: T }> {
  const res = await call(...args);
  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`HTTP ${res.status} 非 JSON 响应：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = data as { error?: { message?: string } };
    throw new Error(`HTTP ${res.status}：${err.error?.message ?? text.slice(0, 200)}`);
  }
  return { status: res.status, data };
}

// ---------- 各命令 ----------

const DECISION_LABEL: Record<string, string> = {
  merge: '合并',
  new_item: '新增',
  skip_exact_duplicate: '跳过(完全重复)',
};

function cmdPreview(apiBase: string, cookie: string, file?: string): Promise<void> {
  const body =
    file && file !== '-'
      ? readFileSync(file, 'utf-8')
      : !process.stdin.isTTY
        ? readFileSync(0, 'utf-8')
        : '';
  if (!body) throw new Error('preview 需要 JSON 文件参数或 stdin');
  JSON.parse(body);
  return callJson<ImportPreviewResponse>(apiBase, cookie, 'POST', '/api/import/preview', body).then(
    ({ data }) => {
      console.log(`previewToken: ${data.previewToken}`);
      console.log(`共 ${data.items.length} 条候选：`);
      for (const it of data.items) {
        console.log(`\n[${it.index}] ${it.candidate.target}（${it.candidate.meaning}）`);
        console.log(
          `    建议: ${DECISION_LABEL[it.suggestion.action] ?? it.suggestion.action} · 来源 ${it.suggestion.source} · 置信 ${it.suggestion.confidence.toFixed(2)}`,
        );
        console.log(`    理由: ${it.suggestion.reason}`);
        if (it.warnings.length > 0) console.log(`    ⚠ ${it.warnings.join('；')}`);
        if (it.match)
          console.log(`    匹配已有: ${it.match.existingTarget}（${it.match.existingMeaning}）`);
      }
    },
  );
}

function cmdCommit(apiBase: string, cookie: string, args: string[]): Promise<void> {
  const token = args[args.indexOf('--token') + 1] ?? '';
  if (!token) throw new Error('commit 需要 --token（来自 preview 输出）');
  const decisions: Array<{ index: number; action: string }> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--decision') {
      const m = /^(\d+)=(\w+)$/.exec(args[i + 1] ?? '');
      if (!m) throw new Error('--decision 格式: <index>=<merge|new_item|skip_exact_duplicate>');
      decisions.push({ index: Number(m[1]), action: m[2]! });
    }
  }
  return callJson<{ created: number; merged: number; skipped: number }>(
    apiBase,
    cookie,
    'POST',
    '/api/import/commit',
    { previewToken: token, decisions },
  ).then(({ data }) => {
    console.log(`导入完成：新增 ${data.created} · 合并 ${data.merged} · 跳过 ${data.skipped}`);
  });
}

async function cmdFind(apiBase: string, cookie: string, args: string[]): Promise<void> {
  const plain = args.filter((a) => !a.startsWith('--'));
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const q = new URLSearchParams({ page: '1', pageSize: '30' });
  if (plain[0]) q.set('query', plain[0]);
  if (flag('type')) q.set('type', flag('type')!);
  if (flag('status')) q.set('status', flag('status')!);
  const { data } = await callJson<LibraryListResponse>(
    apiBase,
    cookie,
    'GET',
    `/api/library?${q.toString()}`,
  );
  console.log(`共 ${data.total} 项（显示前 ${data.items.length}）：`);
  for (const it of data.items) {
    console.log(
      `id=${it.id}\n    ${it.target}${it.type === 'word' ? '' : ' (chunk)'} · ${it.meaning} · ${it.status}${it.queueState === 'new' ? ' · NewQueue' : ''} · U:${it.understandingStage}/P:${it.productionStage}${it.nextReviewAt ? ` · 下次 ${it.nextReviewAt.slice(0, 10)}` : ''}`,
    );
  }
}

function fmtExamples(d: LibraryItemDetail): string {
  const lines: string[] = [`source: ${d.sourceExample}`];
  d.extraExamples.forEach((e, i) => lines.push(`extra[${i}]: ${e}`));
  d.personalExamples.forEach((p) => lines.push(`personal${p.pinned ? '📌' : ''}: ${p.text}`));
  d.reviewStates.forEach((r) =>
    lines.push(
      `${r.dimension === 'understanding' ? 'U' : 'P'}: L${r.level}${r.stable ? '(stable)' : ''} · 下次 ${r.nextReviewAt?.slice(0, 10) ?? '-'}`,
    ),
  );
  d.productionHistory
    .slice(0, 3)
    .forEach((h) =>
      lines.push(
        `造句 ${h.result}: ${h.correctedSentence ?? h.originalText ?? ''}（${h.createdAt.slice(0, 10)}）`,
      ),
    );
  return lines.join('\n');
}

async function cmdShow(apiBase: string, cookie: string, id: string): Promise<void> {
  const { data } = await callJson<LibraryItemDetail>(apiBase, cookie, 'GET', `/api/library/${id}`);
  const i = data.item;
  console.log(`${i.target}（${i.type}${i.ipa ? ` ${i.ipa}` : ''}）`);
  console.log(`释义: ${i.meaning}`);
  if (i.source) console.log(`来源: ${i.source}${i.sourceUrl ? ` · ${i.sourceUrl}` : ''}`);
  if (i.tags.length) console.log(`标签: ${i.tags.join(', ')}`);
  if (i.notes) console.log(`备注: ${i.notes}`);
  console.log(
    `状态: ${i.status}${i.queueState === 'new' ? ' · NewQueue' : ''}${i.needsReinforcement ? ' · 待补强' : ''}`,
  );
  console.log(`---`);
  console.log(fmtExamples(data));
}

async function cmdSet(apiBase: string, cookie: string, id: string, args: string[]): Promise<void> {
  const i = args.indexOf('--json');
  if (i === -1 || !args[i + 1])
    throw new Error("set 需要 --json '<局部 JSON>'（字段见 UpdateLearningItemRequest）");
  const patch = JSON.parse(args[i + 1]!) as Json;
  const { data } = await callJson<UpdateLearningItemResponse>(
    apiBase,
    cookie,
    'PATCH',
    `/api/library/${id}`,
    patch,
  );
  console.log(`已更新 ${data.item.target}（${data.item.meaning}）`);
  if (data.progressResetSuggested) {
    console.log('⚠ 释义已变化：建议确认是否重置学习进度（用户确认后执行 el-cli reset <id>）');
  }
}

async function cmdOp(apiBase: string, cookie: string, op: string, id: string): Promise<void> {
  const { data } = await callJson<LibraryItemDetail>(
    apiBase,
    cookie,
    'POST',
    `/api/library/${id}/${op}`,
  );
  const effects: Record<string, string> = {
    archive: '已归档（可 restore 恢复）',
    restore: '已恢复为 active',
    pause: '已暂停（Today 不再调度）',
    resume: '已恢复调度',
    reset: '进度已重置，回到 New Queue 重新排队',
    master: '已标记为已掌握',
  };
  console.log(`${data.item.target}：${effects[op] ?? op}`);
}

async function cmdStats(apiBase: string, cookie: string): Promise<void> {
  const { data: s } = await callJson<StatsResponse>(apiBase, cookie, 'GET', '/api/stats');
  const rate =
    s.productionPassRate === null
      ? '暂无'
      : `${Math.round(s.productionPassRate * 100)}%（${s.productionAttempts} 次作答）`;
  const active30d = s.heatmap.slice(-30).reduce((n, d) => n + d.count, 0);
  console.log(
    [
      `总学习项 ${s.totals.items}（word ${s.totals.words} / chunk ${s.totals.chunks}）`,
      `学习中 ${s.totals.active} · 已掌握 ${s.totals.mastered} · 暂停 ${s.totals.paused} · 归档 ${s.totals.archived}`,
      `New Queue 待学 ${s.totals.newQueue}`,
      `近 7 天正式任务 ${s.last7DaysFormalTasks} · 近 30 天 ${active30d}`,
      `表达通过率 ${rate}`,
      `近 30 天新增 ${s.last30DaysNewItems}`,
    ].join('\n'),
  );
}

async function cmdBackup(apiBase: string, cookie: string, out: string): Promise<void> {
  const res = await call(apiBase, cookie, 'GET', '/api/export/backup');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, buf);
  console.log(`备份已导出：${out}（${(buf.length / 1024).toFixed(1)} KB）`);
}

// ---------- 入口 ----------

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { apiBase, password } = loadEnv();
  const cookie = await login(apiBase, password);

  switch (cmd) {
    case 'preview':
      return void (await cmdPreview(apiBase, cookie, rest[0]));
    case 'commit':
      return void (await cmdCommit(apiBase, cookie, rest));
    case 'find':
      return void (await cmdFind(apiBase, cookie, rest));
    case 'show':
      return void (await cmdShow(apiBase, cookie, rest[0]));
    case 'set':
      return void (await cmdSet(apiBase, cookie, rest[0], rest));
    case 'stats':
      return void (await cmdStats(apiBase, cookie));
    case 'backup':
      return void (await cmdBackup(apiBase, cookie, rest[0]));
    case 'archive':
    case 'restore':
    case 'pause':
    case 'resume':
    case 'reset':
    case 'master':
      return void (await cmdOp(apiBase, cookie, cmd, rest[0]));
    default:
      throw new Error(
        '命令：preview|commit|find|show|set|archive|restore|pause|resume|reset|master|stats|backup',
      );
  }
}

main().catch((err) => {
  console.error(`[el-cli] ${(err as Error).message}`);
  process.exit(1);
});
