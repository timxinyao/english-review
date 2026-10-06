/**
 * 思考纪律实验（2026-10-06）：check_production v2 临时加入「一次定案」指令后，
 * 全 14 fixtures × N 轮（thinking max）对比基准 42/42 · avg 13.8s · cp13 65-79s。
 * 校验口径与 ai-bench 一致：extractJson + Schema + checkAiOutput + expected.result。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AI_RESPONSE_SCHEMAS, type AiTask } from '@el/shared';
import { loadConfig } from '../src/config.js';
import { loadPromptRegistry, renderPrompt } from '../src/ai/promptRegistry.js';
import { createGlmProvider } from '../src/ai/provider/glm.js';
import { extractJson } from '../src/ai/complete.js';
import { checkAiOutput } from '../src/ai/invariants.js';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const config = loadConfig({ ...(process.env as Record<string, string>), AUTH_PASSWORD: 'x' });
const registry = loadPromptRegistry(fileURLToPath(new URL('../prompts', import.meta.url)));
const fx = JSON.parse(
  readFileSync(new URL('../tests/ai/eval/fixtures/check_production.sample.json', import.meta.url), 'utf8'),
) as { cases: Array<{ id: string; input: Record<string, unknown>; expected?: Record<string, unknown> }> };
const provider = createGlmProvider(config);
const schema = AI_RESPONSE_SCHEMAS.CheckProductionResult;
const RUNS = Number(process.env.EXP_RUNS ?? 2);
const ONLY = (process.env.EXP_ONLY ?? '').split(',').filter(Boolean);

let ok = 0;
let total = 0;
const times: number[] = [];
const cp13: string[] = [];

for (const c of fx.cases) {
  if (ONLY.length && !ONLY.some((k) => c.id.includes(k))) continue;
  const { text } = renderPrompt(registry, 'check_production', c.input);
  for (let run = 1; run <= RUNS; run++) {
    const t0 = Date.now();
    let pass = true;
    let err = '';
    try {
      const raw = await provider.complete({
        task: 'checkProduction' as AiTask,
        model: 'deepseek-flash',
        temperature: 0.2,
        thinking: 'max',
        prompt: text,
        vars: c.input,
      });
      const parsed = schema.safeParse(extractJson(raw));
      if (!parsed.success) throw new Error(`schema: ${parsed.error.issues[0]?.message}`);
      const violations = checkAiOutput('checkProduction', parsed.data, c.input);
      if (violations.length) throw new Error(`invariant: ${violations[0]}`);
      if (c.expected && (parsed.data as { result: string }).result !== c.expected.result) {
        throw new Error('expected 不符');
      }
    } catch (e) {
      pass = false;
      err = (e as Error).message.slice(0, 90);
    }
    const ms = Date.now() - t0;
    total++;
    if (pass) ok++;
    times.push(ms);
    const line = `${c.id} run${run}: ${pass ? '✓' : '✗ ' + err} · ${(ms / 1000).toFixed(1)}s`;
    if (c.id.includes('cp13')) cp13.push(line);
    else console.log(line);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
console.log('--- cp13 ---');
for (const l of cp13) console.log(l);
const sorted = [...times].sort((a, b) => a - b);
console.log(
  `\n合计 ${ok}/${total} · avg ${(times.reduce((a, b) => a + b, 0) / times.length / 1000).toFixed(1)}s · p50 ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)}s · max ${(sorted[sorted.length - 1] / 1000).toFixed(1)}s`,
);
