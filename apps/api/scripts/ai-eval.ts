/**
 * Prompt Eval CLI（TECHNICAL_DESIGN §10.8）
 *
 * 用法：
 *   pnpm ai:eval -- --task check_production
 *   pnpm ai:eval -- --all
 *   pnpm ai:eval -- --all --provider mock
 *   pnpm ai:eval -- --task check_production --save-baseline
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AI_TASK_CATALOG,
  AI_TASKS,
  type AiTask,
  type CheckClozeResult,
  type CheckProductionResult,
  type JudgeDuplicateMeaningResult,
} from '@el/shared';
import { completeStructured } from '../src/ai/complete.js';
import { loadPromptRegistry, validateRegistry } from '../src/ai/promptRegistry.js';
import { getTaskConfig } from '../src/ai/taskConfig.js';
import { resolveProvider, type AiProvider } from '../src/ai/provider/index.js';
import { loadConfig, type AppConfig } from '../src/config.js';

interface FixtureCase {
  id: string;
  input: Record<string, unknown>;
  expected?: Record<string, unknown>;
  expected_invariants?: string[];
}

interface Fixture {
  task: string;
  cases: FixtureCase[];
}

interface CaseResult {
  id: string;
  ok: boolean;
  failures: string[];
  digest: string;
}

const FIXTURES_DIR = fileURLToPath(new URL('../tests/ai/eval/fixtures', import.meta.url));
const BASELINES_DIR = fileURLToPath(new URL('../tests/ai/eval/baselines', import.meta.url));

function parseArgs(): {
  task: string | null;
  all: boolean;
  provider: 'mock' | 'glm' | 'auto';
  saveBaseline: boolean;
} {
  const args = process.argv.slice(2);
  const out = {
    task: null as string | null,
    all: false,
    provider: 'auto' as 'mock' | 'glm' | 'auto',
    saveBaseline: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task') out.task = args[++i] ?? null;
    else if (args[i] === '--all') out.all = true;
    else if (args[i] === '--provider') {
      const v = args[++i];
      if (v === 'mock' || v === 'glm') out.provider = v;
      else if (v === 'auto') out.provider = 'auto';
      else throw new Error(`--provider 仅支持 mock|glm|auto，收到 ${v}`);
    } else if (args[i] === '--save-baseline') out.saveBaseline = true;
  }
  if (!out.all && !out.task) {
    console.error(
      '用法：pnpm ai:eval -- --task <task|prompt_key> | --all [--provider mock|glm] [--save-baseline]',
    );
    process.exit(2);
  }
  return out;
}

function resolveTask(name: string): AiTask {
  if ((AI_TASKS as readonly string[]).includes(name)) return name as AiTask;
  const byKey = Object.values(AI_TASK_CATALOG).find((s) => s.promptKey === name);
  if (byKey) return byKey.task;
  throw new Error(`未知任务：${name}`);
}

function digestOf(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

/** 期望结果对比（有标签任务） */
function expectedFailures(
  task: AiTask,
  output: unknown,
  expected: Record<string, unknown>,
): string[] {
  const failures: string[] = [];
  const out = output as Record<string, unknown>;
  if (task === 'checkProduction' && 'result' in expected) {
    if ((out as CheckProductionResult).result !== expected.result) {
      failures.push(`result=${(out as CheckProductionResult).result}，期望 ${expected.result}`);
    }
  }
  if (task === 'checkCloze' && 'accepted' in expected) {
    if ((out as CheckClozeResult).accepted !== expected.accepted) {
      failures.push(`accepted=${(out as CheckClozeResult).accepted}，期望 ${expected.accepted}`);
    }
  }
  if (task === 'judgeDuplicateMeaning' && 'decision' in expected) {
    if ((out as JudgeDuplicateMeaningResult).decision !== expected.decision) {
      failures.push(
        `decision=${(out as JudgeDuplicateMeaningResult).decision}，期望 ${expected.decision}`,
      );
    }
  }
  return failures;
}

async function runTask(
  task: AiTask,
  provider: AiProvider,
  config: AppConfig,
  registry: ReturnType<typeof loadPromptRegistry>,
  saveBaseline: boolean,
): Promise<{
  total: number;
  passed: number;
  failed: CaseResult[];
  changed: string[];
  manual: number;
}> {
  const spec = AI_TASK_CATALOG[task];
  const fixturePath = `${FIXTURES_DIR}/${spec.promptKey}.sample.json`;
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture;

  const baselinePath = `${BASELINES_DIR}/${spec.promptKey}.json`;
  let baseline: { promptVersion?: number; cases?: Record<string, string> } | null = null;
  if (existsSync(baselinePath)) {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  }

  const results: CaseResult[] = [];
  const manualNotes: FixtureCase[] = [];

  // mock provider 无法做语言判断：对判定类任务跳过 expected 标签对比，
  // mock 模式只验证 Schema 与机器不变式管线。
  const skipExpected =
    provider.name === 'mock' && (task === 'checkProduction' || task === 'judgeDuplicateMeaning');

  for (const c of fixture.cases) {
    const failures: string[] = [];
    let data: unknown = null;
    try {
      const res = await completeStructured({ provider, config, registry }, task, c.input);
      data = res.data;
    } catch (err) {
      failures.push((err as Error).message);
    }
    if (data && c.expected && !skipExpected)
      failures.push(...expectedFailures(task, data, c.expected));
    if (fixtureCaseHasInvariants(c)) manualNotes.push(c);

    results.push({ id: c.id, ok: failures.length === 0, failures, digest: digestOf(data) });
  }

  const changed: string[] = [];
  if (baseline?.cases) {
    for (const r of results) {
      const prev = baseline.cases[r.id];
      if (prev && prev !== r.digest) changed.push(r.id);
    }
  }

  const meta = { promptVersion: registry.get(spec.promptKey)?.version };
  console.log(`\n=== ${task}（${spec.promptKey}）===`);
  const prompt = registry.get(spec.promptKey)!;
  const taskConf = getTaskConfig(task, config);
  console.log(
    `prompt v${prompt.version} hash=${prompt.hash.slice(0, 12)} model=${provider.name === 'mock' ? `mock(${taskConf.model})` : taskConf.model} provider=${provider.name}`,
  );
  if (skipExpected)
    console.log('（mock 模式：跳过语言判定类 expected 对比，仅验证 Schema/不变式）');
  const passed = results.filter((r) => r.ok).length;
  console.log(
    `fixtures: ${results.length}，schema/不变式通过: ${passed}，失败: ${results.length - passed}`,
  );
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  ✗ ${r.id}: ${r.failures.join('；')}`);
  }
  if (baseline?.cases) {
    console.log(
      changed.length ? `changed cases（对比基线）: ${changed.join(', ')}` : 'changed cases: 无',
    );
  } else {
    console.log('changed cases: 无基线可对比（首次可用 --save-baseline 生成）');
  }
  if (manualNotes.length) {
    console.log(`需人工/Agent 审阅 invariants 的 case: ${manualNotes.map((c) => c.id).join(', ')}`);
  }

  if (saveBaseline) {
    mkdirSync(BASELINES_DIR, { recursive: true });
    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          promptVersion: meta.promptVersion,
          cases: Object.fromEntries(results.map((r) => [r.id, r.digest])),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`已保存基线：${baselinePath}`);
  }

  return {
    total: results.length,
    passed,
    failed: results.filter((r) => !r.ok),
    changed,
    manual: manualNotes.length,
  };
}

function fixtureCaseHasInvariants(c: FixtureCase): boolean {
  return Array.isArray(c.expected_invariants) && c.expected_invariants.length > 0;
}

async function main(): Promise<void> {
  const args = parseArgs();
  // Eval 只需要 GLM 相关配置；auth 密码与运行无关，给占位以通过校验
  const config = loadConfig({
    ...(process.env as Record<string, string | undefined>),
    AUTH_PASSWORD: process.env.AUTH_PASSWORD ?? 'eval-placeholder',
  });
  const registry = loadPromptRegistry(fileURLToPath(new URL('../prompts', import.meta.url)));
  validateRegistry(registry);
  const provider = resolveProvider(args.provider, config);

  const tasks: AiTask[] = args.all ? [...AI_TASKS] : [resolveTask(args.task!)];

  let exitCode = 0;
  for (const task of tasks) {
    const r = await runTask(task, provider, config, registry, args.saveBaseline);
    if (r.failed.length > 0) exitCode = 1;
  }
  process.exit(exitCode);
}

void main();
