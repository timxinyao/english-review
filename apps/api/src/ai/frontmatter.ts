export interface PromptFrontmatter {
  key: string;
  version: number;
  task: string;
  response_schema: string;
}

export class PromptFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptFormatError';
  }
}

const REQUIRED_KEYS = ['key', 'version', 'task', 'response_schema'] as const;

/** 严格解析 YAML frontmatter（仅支持平铺 key: value） */
export function parseFrontmatter(content: string): { fm: PromptFrontmatter; body: string } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new PromptFormatError('Prompt 文件必须以 frontmatter（---）开头');
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) {
    throw new PromptFormatError('frontmatter 缺少闭合分隔线（---）');
  }

  const raw: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) throw new PromptFormatError(`frontmatter 行格式非法：${line}`);
    const [, k, v] = m;
    if (!(REQUIRED_KEYS as readonly string[]).includes(k!)) {
      throw new PromptFormatError(`frontmatter 含未知字段：${k}`);
    }
    if (!v || !v.trim()) throw new PromptFormatError(`frontmatter 字段 ${k} 为空`);
    raw[k!] = v!.trim();
  }

  for (const k of REQUIRED_KEYS) {
    if (!(k in raw)) throw new PromptFormatError(`frontmatter 缺少必需字段：${k}`);
  }

  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new PromptFormatError(`frontmatter version 必须是正整数，实际为 ${raw.version}`);
  }

  const fm: PromptFrontmatter = {
    key: raw.key!,
    version,
    task: raw.task!,
    response_schema: raw['response_schema']!,
  };
  const body = lines.slice(end + 1).join('\n');
  return { fm, body };
}
