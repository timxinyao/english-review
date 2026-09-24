import { fileURLToPath } from 'node:url';
import type { JudgeDuplicateMeaningResult } from '@el/shared';
import type { AppConfig } from '../config.js';
import { completeStructured } from './complete.js';
import { loadPromptRegistry, validateRegistry, type LoadedPrompt } from './promptRegistry.js';
import { resolveProvider, type AiProvider } from './provider/index.js';

/** judge_duplicate_meaning 的输入条目（结构化变量，registry 渲染时 JSON 化） */
export interface DuplicateJudgeItem {
  type: string;
  target: string;
  meaning: string;
  source_example: string | null;
}

export interface AiRuntime {
  readonly config: AppConfig;
  readonly provider: AiProvider;
  readonly registry: Map<string, LoadedPrompt>;
  judgeDuplicateMeaning(
    existing: DuplicateJudgeItem,
    candidate: DuplicateJudgeItem,
  ): Promise<JudgeDuplicateMeaningResult>;
}

let currentRuntime: AiRuntime | null = null;

/**
 * 初始化 AI 运行时单例：加载并校验 Prompt Registry（fail fast），
 * provider = 有 GLM key 用 glm，否则 mock（mock 仅用于测试管线，
 * 生产判定路径不得依赖 mock 的语言判断，见 import-export 的 judge 回退）。
 */
export function initAiRuntime(config: AppConfig): AiRuntime {
  const registry = loadPromptRegistry(fileURLToPath(new URL('../../prompts', import.meta.url)));
  validateRegistry(registry);
  const provider = resolveProvider('auto', config);
  const runtime: AiRuntime = {
    config,
    provider,
    registry,
    async judgeDuplicateMeaning(existing, candidate) {
      const { data } = await completeStructured<JudgeDuplicateMeaningResult>(
        { provider, config, registry },
        'judgeDuplicateMeaning',
        { existing_item: existing, candidate_item: candidate },
      );
      return data;
    },
  };
  currentRuntime = runtime;
  return runtime;
}

export function getAiRuntime(): AiRuntime | null {
  return currentRuntime;
}
