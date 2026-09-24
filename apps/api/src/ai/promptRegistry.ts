import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_RESPONSE_SCHEMAS, AI_TASK_CATALOG, type AiTask } from '@el/shared';
import { parseFrontmatter, PromptFormatError } from './frontmatter.js';

export interface PromptMeta {
  key: string;
  version: number;
  task: AiTask;
  responseSchemaName: string;
  /** 模板文件全文 SHA-256 */
  hash: string;
  filePath: string;
  variables: string[];
}

export interface LoadedPrompt extends PromptMeta {
  body: string;
}

export class PromptRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptRegistryError';
  }
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** 提取模板变量（唯一、按首次出现顺序） */
export function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(VAR_RE)) {
    seen.add(m[1]!);
  }
  return [...seen];
}

/** 从目录加载全部 Prompt；任何非法文件立即抛错（fail fast） */
export function loadPromptRegistry(dir: string): Map<string, LoadedPrompt> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    throw new PromptRegistryError(`Prompt 目录不存在或不可读：${dir}`);
  }

  const registry = new Map<string, LoadedPrompt>();
  for (const file of files) {
    const filePath = join(dir, file);
    const content = readFileSync(filePath, 'utf-8');
    const loaded = loadPromptFile(content, file, filePath);
    if (registry.has(loaded.key)) {
      throw new PromptRegistryError(
        `Prompt key 重复：${loaded.key}（${registry.get(loaded.key)!.filePath} 与 ${filePath}）`,
      );
    }
    registry.set(loaded.key, loaded);
  }
  return registry;
}

export function loadPromptFile(content: string, file: string, filePath: string): LoadedPrompt {
  const { fm, body } = parseFrontmatter(content);

  // 文件名必须为 <key>.v<version>.md 且与 frontmatter 一致
  const m = /^(.+)\.v(\d+)\.md$/.exec(file);
  if (!m || m[1] !== fm.key || Number(m[2]) !== fm.version) {
    throw new PromptFormatError(
      `文件名 ${file} 与 frontmatter（key=${fm.key}, version=${fm.version}）不一致`,
    );
  }

  return {
    key: fm.key,
    version: fm.version,
    task: fm.task as AiTask,
    responseSchemaName: fm.response_schema,
    hash: createHash('sha256').update(content, 'utf-8').digest('hex'),
    filePath,
    variables: extractVariables(body),
    body,
  };
}

/** 校验 registry 与任务目录一致：7 个 key 齐全、task/schema 对应 */
export function validateRegistry(registry: Map<string, LoadedPrompt>): void {
  for (const spec of Object.values(AI_TASK_CATALOG)) {
    const prompt = registry.get(spec.promptKey);
    if (!prompt) {
      throw new PromptRegistryError(`缺少 Prompt：${spec.promptKey}`);
    }
    if (prompt.task !== spec.task) {
      throw new PromptRegistryError(
        `Prompt ${spec.promptKey} 的 task=${prompt.task} 与目录 ${spec.task} 不一致`,
      );
    }
    if (prompt.responseSchemaName !== spec.responseSchemaName) {
      throw new PromptRegistryError(
        `Prompt ${spec.promptKey} 的 response_schema=${prompt.responseSchemaName} 与目录 ${spec.responseSchemaName} 不一致`,
      );
    }
    if (!(prompt.responseSchemaName in AI_RESPONSE_SCHEMAS)) {
      throw new PromptRegistryError(`未知 response_schema：${prompt.responseSchemaName}`);
    }
  }
  if (registry.size !== Object.keys(AI_TASK_CATALOG).length) {
    throw new PromptRegistryError(
      `Prompt 数量 ${registry.size} 与任务目录 ${Object.keys(AI_TASK_CATALOG).length} 不一致（存在多余文件）`,
    );
  }
}

export interface RenderedPrompt {
  text: string;
  meta: PromptMeta;
}

/**
 * 渲染 Prompt。变量缺失即抛错，禁止静默空串。
 * `xxx_json` 变量接受未序列化值并在此 JSON 化。
 */
export function renderPrompt(
  registry: Map<string, LoadedPrompt>,
  key: string,
  vars: Record<string, unknown>,
): RenderedPrompt {
  const prompt = registry.get(key);
  if (!prompt) throw new PromptRegistryError(`未知 Prompt key：${key}`);

  const rendered: Record<string, string> = {};
  for (const v of prompt.variables) {
    const sourceKey = v.replace(/_json$/, '');
    let value = vars[sourceKey];
    if (v.endsWith('_json')) value = value === undefined ? 'null' : JSON.stringify(value);
    if (value === undefined || value === null) {
      if (v.endsWith('_json')) {
        rendered[v] = 'null';
        continue;
      }
      throw new PromptRegistryError(`Prompt ${key} 缺失变量：${sourceKey}（模板变量 ${v}）`);
    }
    rendered[v] = String(value);
  }

  const text = prompt.body.replace(VAR_RE, (full, name: string) => {
    if (!(name in rendered)) throw new PromptRegistryError(`Prompt ${key} 渲染异常：${full}`);
    return rendered[name]!;
  });

  const meta: PromptMeta = {
    key: prompt.key,
    version: prompt.version,
    task: prompt.task,
    responseSchemaName: prompt.responseSchemaName,
    hash: prompt.hash,
    filePath: prompt.filePath,
    variables: prompt.variables,
  };
  return { text, meta };
}
