/**
 * 模型 × 思考强度 基准测试（bench）：
 * 全部 7 个 AI 任务 × {flash, main} × {off,low,medium,high(判定类加 max)}，
 * 多次独立调用（判定类 3 轮 / 生成类 2 轮，间隔 1.5s），记录每次
 * 首次通过（Schema+不变式+期望标签，无重试）与延迟，输出 JSONL + 汇总 Markdown。
 *
 * 用法：cd apps/api && pnpm exec tsx scripts/ai-bench.ts [--max-minutes 90]
 */
import 'dotenv/config';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AI_RESPONSE_SCHEMAS,
  AI_TASK_CATALOG,
  type AiTask,
  type ThinkingLevel,
} from '@el/shared';
import { loadConfig } from '../src/config.js';
import { loadPromptRegistry, renderPrompt, validateRegistry } from '../src/ai/promptRegistry.js';
import { createGlmProvider } from '../src/ai/provider/glm.js';
import { extractJson } from '../src/ai/complete.js';
import { checkAiOutput } from '../src/ai/invariants.js';
import { TASK_MODEL_POLICY } from '../src/ai/taskConfig.js';

const FIXTURES_DIR = fileURLToPath(new URL('../tests/ai/eval/fixtures', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('.', import.meta.url)) + 'bench';

interface FixtureCase {
  id: string;
  input: Record<string, unknown>;
  expected?: Record<string, unknown>;
}

function expectedOk(task: AiTask, out: unknown, expected: Record<string, unknown>): boolean {
  const o = out as Record<string, unknown>;
  if (task === 'checkProduction') return o.result === expected.result;
  if (task === 'checkCloze') return o.accepted === expected.accepted;
  if (task === 'judgeDuplicateMeaning') return o.decision === expected.decision;
  return true; // 生成类无标签：通过 = Schema + 不变式
}

const MODELS = [
  { label: 'flash', id: 'glm-5.3-flash' },
  { label: 'main', id: 'glm-5.3' },
];
const LEVELS_JUDGMENT: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];
const LEVELS_GEN: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];
const RUNS = { judgment: 3, gen: 2 } as const;
const GAP_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  task: AiTask;
  model: string;
  thinking: string;
  ok: number;
  total: number;
  avgMs: number;
  maxMs: number;
  errors: string[];
}

async function main() {
  const args = process.argv.slice(2);
  const maxMinIdx = args.indexOf('--max-minutes');
  const maxMinutes = maxMinIdx === -1 ? 90 : Number(args[maxMinIdx + 1] ?? 90);
  const deadline = Date.now() + maxMinutes * 60_000;

  const baseConfig = loadConfig({
    ...(process.env as Record<string, string | undefined>),
    AUTH_PASSWORD: process.env.AUTH_PASSWORD ?? 'bench-placeholder',
  });
  if (!baseConfig.glmApiKey) throw new Error('需要 GLM_API_KEY');
  const registry = loadPromptRegistry(fileURLToPath(new URL('../prompts', import.meta.url)));
  validateRegistry(registry);
  const provider = createGlmProvider(baseConfig);

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const jsonlPath = `${OUT_DIR}/results-${stamp}.jsonl`;
  console.log(`bench 开始 → ${jsonlPath}（预算 ${maxMinutes} 分钟）`);

  const rows: Row[] = [];
  let skipped = 0;

  for (const task of Object.keys(AI_TASK_CATALOG) as AiTask[]) {
    const spec = AI_TASK_CATALOG[task];
    const fixture = JSON.parse(
      readFileSync(`${FIXTURES_DIR}/${spec.promptKey}.sample.json`, 'utf-8'),
    ) as { cases: FixtureCase[] };
    const isJudgment =
      task === 'checkProduction' || task === 'checkCloze' || task === 'judgeDuplicateMeaning';
    const levels = isJudgment ? LEVELS_JUDGMENT : LEVELS_GEN;
    const runs = isJudgment ? RUNS.judgment : RUNS.gen;
    const temperature = TASK_MODEL_POLICY[task].temperature; // 用各任务策略温度，贴近真实

    for (const model of MODELS) {
      for (const level of levels) {
        const row: Row = {
          task,
          model: model.label,
          thinking: level,
          ok: 0,
          total: 0,
          avgMs: 0,
          maxMs: 0,
          errors: [],
        };
        const times: number[] = [];
        outer: for (let run = 1; run <= runs; run++) {
          for (const c of fixture.cases) {
            if (Date.now() > deadline) {
              skipped++;
              break outer;
            }
            const t0 = Date.now();
            const rec: Record<string, unknown> = {
              task,
              model: model.id,
              thinking: level,
              run,
              caseId: c.id,
            };
            try {
              const { text } = renderPrompt(registry, spec.promptKey, c.input);
              const raw = await provider.complete({
                task,
                model: model.id,
                temperature,
                thinking: level,
                prompt: text,
                vars: c.input,
              });
              const schema = AI_RESPONSE_SCHEMAS[spec.responseSchemaName];
              const parsed = schema.safeParse(extractJson(raw));
              if (!parsed.success) throw new Error(`schema: ${parsed.error.issues[0]?.message}`);
              const violations = checkAiOutput(task, parsed.data, c.input);
              if (violations.length) throw new Error(`invariant: ${violations[0]}`);
              if (c.expected && !expectedOk(task, parsed.data, c.expected)) {
                throw new Error('expected 不符');
              }
              rec.ok = true;
              row.ok++;
            } catch (err) {
              rec.ok = false;
              rec.error = (err as Error).message.slice(0, 120);
              row.errors.push(String(rec.error));
            }
            const ms = Date.now() - t0;
            rec.ms = ms;
            times.push(ms);
            row.total++;
            row.maxMs = Math.max(row.maxMs, ms);
            appendFileSync(jsonlPath, JSON.stringify(rec) + '\n');
            await sleep(GAP_MS);
          }
        }
        row.avgMs = times.length
          ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
          : 0;
        if (row.total > 0) {
          rows.push(row);
          console.log(
            `${task} ${model.label}/${level}: ${row.ok}/${row.total} 通过 · avg ${(row.avgMs / 1000).toFixed(1)}s · max ${(row.maxMs / 1000).toFixed(1)}s${row.errors.length ? ' · ' + row.errors[0] : ''}`,
          );
        }
      }
    }
  }

  const md: string[] = [
    `# 模型 × 思考强度基准（${new Date().toISOString().slice(0, 16)}）`,
    '',
    `每个组合对全部 fixtures 独立调用：判定类 ${RUNS.judgment} 轮 / 生成类 ${RUNS.gen} 轮，间隔 ${GAP_MS}ms，**无重试**（首次通过率）；temperature 用各任务策略值。通过 = Schema + 机器不变式 + 期望标签（生成类无标签，仅前两项）。${skipped ? `\n\n> ⚠ 超时间预算，跳过 ${skipped} 个组合` : ''}`,
    '',
    '| 任务 | 模型 | 思考 | 通过率 | 平均延迟 | 最大延迟 | 典型错误 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    md.push(
      `| ${r.task} | ${r.model} | ${r.thinking} | ${r.ok}/${r.total} (${Math.round((r.ok / r.total) * 100)}%) | ${(r.avgMs / 1000).toFixed(1)}s | ${(r.maxMs / 1000).toFixed(1)}s | ${r.errors[0]?.replace(/\|/g, '/') ?? '-'} |`,
    );
  }
  const mdPath = `${OUT_DIR}/matrix-${stamp}.md`;
  writeFileSync(mdPath, md.join('\n') + '\n');
  console.log(`\n汇总已写入：${mdPath}`);
}

main().catch((err) => {
  console.error('[bench]', (err as Error).message);
  process.exit(1);
});
