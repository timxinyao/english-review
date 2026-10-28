import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  extractVariables,
  loadPromptRegistry,
  renderPrompt,
  validateRegistry,
} from '../../src/ai/promptRegistry.js';

const PROMPTS_DIR = join(process.cwd(), 'prompts');

const tmpDirs: string[] = [];
afterAll(() => {
  // 由操作系统清理 tmp；这里只记录
  void tmpDirs;
});

describe('真实仓库 Prompt 文件', () => {
  it('加载全部 9 个 Prompt，key 唯一且与目录一致', () => {
    const registry = loadPromptRegistry(PROMPTS_DIR);
    expect(registry.size).toBe(9);
    expect([...registry.keys()].sort()).toEqual(
      [
        'check_cloze',
        'check_production',
        'check_production_scramble',
        'generate_cloze',
        'generate_production_prompt',
        'generate_production_scramble',
        'generate_read',
        'generate_understanding',
        'judge_duplicate_meaning',
      ].sort(),
    );
    expect(() => validateRegistry(registry)).not.toThrow();
  });

  it('文件名 .vN 与 frontmatter version 一致（校验内置）', () => {
    const registry = loadPromptRegistry(PROMPTS_DIR);
    for (const p of registry.values()) {
      expect(p.filePath).toMatch(new RegExp(`${p.key}\\.v${p.version}\\.md$`));
    }
  });

  it('check_production 使用 v3 当前 Prompt（v3=v2+思考纪律：一次定案）', () => {
    const prompt = loadPromptRegistry(PROMPTS_DIR).get('check_production');
    expect(prompt?.version).toBe(3);
    expect(prompt?.filePath).toMatch(/check_production\.v3\.md$/);
  });

  it('hash 为 64 位十六进制且稳定', () => {
    const r1 = loadPromptRegistry(PROMPTS_DIR);
    const r2 = loadPromptRegistry(PROMPTS_DIR);
    for (const p of r1.values()) {
      expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(p.hash).toBe(r2.get(p.key)?.hash);
    }
  });

  it('renderPrompt 渲染变量并返回元数据', () => {
    const registry = loadPromptRegistry(PROMPTS_DIR);
    const { text, meta } = renderPrompt(registry, 'check_production', {
      type: 'chunk',
      target: 'wear down',
      meaning: '逐渐消耗',
      zh_prompt: '压力让我疲惫。',
      reference_answer: 'Stress wears me down.',
      acceptance_notes: '允许时态变化。',
      source_example: 'It wears you down.',
      extra_examples: [],
      user_answer: 'Stress wear me down.',
    });
    expect(meta.key).toBe('check_production');
    expect(meta.version).toBeGreaterThanOrEqual(1);
    expect(meta.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(text).toContain('wear down');
    expect(text).toContain('Stress wear me down.');
    expect(text).not.toContain('{{');
  });

  it('缺失变量时报错', () => {
    const registry = loadPromptRegistry(PROMPTS_DIR);
    expect(() => renderPrompt(registry, 'check_production', {})).toThrow(/缺失变量/);
  });

  it('未知 key 报错', () => {
    const registry = loadPromptRegistry(PROMPTS_DIR);
    expect(() => renderPrompt(registry, 'nope', {})).toThrow(/nope/);
  });
});

describe('坏文件 fail-fast', () => {
  function tmpWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'prompts-'));
    tmpDirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  it('重复 key 报错', () => {
    const body =
      '---\nkey: check_cloze\nversion: 1\ntask: checkCloze\nresponse_schema: CheckClozeResult\n---\n{{target}}';
    const dir = tmpWith({
      'check_cloze.v1.md': body,
      'check_cloze_copy.v1.md': body,
    });
    expect(() => loadPromptRegistry(dir)).toThrow(/check_cloze/);
  });

  it('文件名版本与 frontmatter 不一致报错', () => {
    const dir = tmpWith({
      'check_cloze.v2.md':
        '---\nkey: check_cloze\nversion: 1\ntask: checkCloze\nresponse_schema: CheckClozeResult\n---\n{{target}}',
    });
    expect(() => loadPromptRegistry(dir)).toThrow(/version/i);
  });

  it('frontmatter 非法报错', () => {
    const dir = tmpWith({ 'broken.v1.md': 'no frontmatter here' });
    expect(() => loadPromptRegistry(dir)).toThrow();
  });
});

describe('extractVariables', () => {
  it('提取唯一变量并忽略非变量花括号', () => {
    expect(extractVariables('a {{one}} b {{two}} c {{one}} { json }')).toEqual(['one', 'two']);
  });
});
