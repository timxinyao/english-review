import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/ai/frontmatter.js';

const valid = `---
key: check_production
version: 1
task: checkProduction
response_schema: CheckProductionResult
---

# Role
你是批改器。目标：{{target}}
`;

describe('parseFrontmatter', () => {
  it('解析合法 frontmatter 与正文', () => {
    const { fm, body } = parseFrontmatter(valid);
    expect(fm).toEqual({
      key: 'check_production',
      version: 1,
      task: 'checkProduction',
      response_schema: 'CheckProductionResult',
    });
    expect(body).toContain('# Role');
    expect(body).toContain('{{target}}');
  });

  it('缺少起始分隔线时报错', () => {
    expect(() => parseFrontmatter('key: x\nversion: 1')).toThrow(/frontmatter/);
  });

  it('缺少闭合分隔线时报错', () => {
    expect(() => parseFrontmatter('---\nkey: x\nversion: 1\ntask: t\nresponse_schema: S\n')).toThrow(
      /闭合/,
    );
  });

  it('缺少必需字段时报错', () => {
    const bad = '---\nkey: x\nversion: 1\ntask: t\n---\nbody';
    expect(() => parseFrontmatter(bad)).toThrow(/response_schema/);
  });

  it('version 非正整数时报错', () => {
    const bad =
      '---\nkey: x\nversion: two\ntask: t\nresponse_schema: S\n---\nbody';
    expect(() => parseFrontmatter(bad)).toThrow(/version/);
  });

  it('未知字段时报错', () => {
    const bad =
      '---\nkey: x\nversion: 1\ntask: t\nresponse_schema: S\nextra: 1\n---\nbody';
    expect(() => parseFrontmatter(bad)).toThrow(/extra/);
  });

  it('空值字段报错', () => {
    const bad = '---\nkey: \nversion: 1\ntask: t\nresponse_schema: S\n---\nbody';
    expect(() => parseFrontmatter(bad)).toThrow(/key/);
  });
});
