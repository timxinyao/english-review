/**
 * 导入 CLI —— 供 Coding Agent / 脚本调用学习库导入 API（与 PC 导入页同一契约：
 * preview → 用户确认 → commit；PRODUCT §9 重复处理规则全部由服务端执行）。
 *
 * 用法（在 apps/api 目录）：
 *   echo '<LibraryImport JSON>' | tsx scripts/import-cli.ts preview
 *   tsx scripts/import-cli.ts preview items.json
 *   tsx scripts/import-cli.ts commit --token <tok> [--apply suggested] \
 *        [--decision 0=new_item] [--decision 2=skip_exact_duplicate]
 *
 * 配置（环境变量，缺省自动从 apps/api/.env 或 /etc/english-learning/env 读取）：
 *   IMPORT_API_BASE  默认 http://127.0.0.1:5174（本机服务）
 *   IMPORT_PASSWORD   访问密码（AUTH_PASSWORD）
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import type { ImportPreviewResponse } from '@el/shared';

const DECISION_LABEL: Record<string, string> = {
  merge: '合并',
  new_item: '新增',
  skip_exact_duplicate: '跳过(完全重复)',
};

function loadEnv(): { apiBase: string; password: string } {
  const fromFile = (p: string): Record<string, string> => {
    if (!existsSync(p)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
    return out;
  };
  // 优先级：显式环境变量 > 生产 /etc/english-learning/env > 开发 apps/api/.env
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

function readInput(file?: string): string {
  if (file) return readFileSync(file, 'utf-8');
  if (!process.stdin.isTTY) return readFileSync(0, 'utf-8');
  throw new Error('preview 需要 stdin JSON 或文件参数');
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { apiBase, password } = loadEnv();
  const cookie = await login(apiBase, password);

  if (cmd === 'preview') {
    const body = readInput(rest[0]);
    JSON.parse(body); // 提前校验，给清晰报错
    const res = await fetch(`${apiBase}/api/import/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body,
    });
    if (!res.ok)
      throw new Error(`preview 失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as ImportPreviewResponse;
    console.log(`previewToken: ${data.previewToken}`);
    console.log(`共 ${data.items.length} 条候选：`);
    for (const it of data.items) {
      console.log(`\n[${it.index}] ${it.candidate.target}（${it.candidate.meaning}）`);
      console.log(
        `    建议: ${DECISION_LABEL[it.suggestion.action] ?? it.suggestion.action} · 来源 ${
          it.suggestion.source
        } · 置信 ${it.suggestion.confidence.toFixed(2)}`,
      );
      console.log(`    理由: ${it.suggestion.reason}`);
      if (it.match)
        console.log(`    匹配已有: ${it.match.existingTarget}（${it.match.existingMeaning}）`);
    }
    return;
  }

  if (cmd === 'commit') {
    const args = rest;
    const token = args[args.indexOf('--token') + 1] ?? '';
    if (!token) throw new Error('commit 需要 --token（来自 preview 输出）');
    const overrides: Array<{ index: number; action: string }> = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--decision') {
        const m = /^(\d+)=(\w+)$/.exec(args[i + 1] ?? '');
        if (!m) throw new Error(`--decision 格式: <index>=<merge|new_item|skip_exact_duplicate>`);
        overrides.push({ index: Number(m[1]), action: m[2]! });
      }
    }
    // --apply suggested 是默认行为（未覆盖条目沿用系统建议），保留参数以示语义
    const res = await fetch(`${apiBase}/api/import/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ previewToken: token, decisions: overrides }),
    });
    if (!res.ok)
      throw new Error(`commit 失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const r = (await res.json()) as { created: number; merged: number; skipped: number };
    console.log(`导入完成：新增 ${r.created} · 合并 ${r.merged} · 跳过 ${r.skipped}`);
    return;
  }

  throw new Error(
    '用法: import-cli.ts preview [<file.json>] | commit --token <tok> [--decision N=action]',
  );
}

main().catch((err) => {
  console.error(`[import-cli] ${(err as Error).message}`);
  process.exit(1);
});
