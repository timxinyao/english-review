import { describe, expect, it } from 'vitest';
import { highlightParts } from '../src/features/read/highlight';
import { relativeTime } from '../src/features/read/time';

describe('highlightParts（Read focus 高亮纯函数）', () => {
  it('对每个 focus surfaceForm 做大小写不敏感标记', () => {
    const parts = highlightParts('The plan felt Stable, raw and she did not give up.', [
      'stable',
      'raw',
      'give up',
    ]);

    const marks = parts.filter((p) => p.highlighted);
    expect(marks.map((p) => p.text)).toEqual(['Stable', 'raw', 'give up']);
    // 未高亮片段与高亮片段拼回原文
    expect(parts.map((p) => p.text).join('')).toBe(
      'The plan felt Stable, raw and she did not give up.',
    );
  });

  it('同词多次出现全部标记；重复 surfaceForm 去重', () => {
    const parts = highlightParts('raw sugar and raw milk', ['raw', 'raw']);
    expect(parts.filter((p) => p.highlighted).map((p) => p.text)).toEqual(['raw', 'raw']);
  });

  it('词边界保护：单词内的子串不误标（drawing 不含 raw）', () => {
    const parts = highlightParts('She was drawing by the raw window.', ['raw']);
    expect(parts.filter((p) => p.highlighted).map((p) => p.text)).toEqual(['raw']);
  });

  it('无匹配或空 surfaceForms 时返回整段未高亮', () => {
    expect(highlightParts('plain text', [])).toEqual([{ text: 'plain text', highlighted: false }]);
    expect(highlightParts('plain text', ['zzz'])).toEqual([
      { text: 'plain text', highlighted: false },
    ]);
  });
});

describe('relativeTime（安静相对时间）', () => {
  const now = new Date('2026-09-25T12:00:00.000Z');

  it('按分钟/小时/天输出中文相对时间', () => {
    expect(relativeTime('2026-09-25T11:59:30.000Z', now)).toBe('刚刚');
    expect(relativeTime('2026-09-25T11:30:00.000Z', now)).toBe('30 分钟前');
    expect(relativeTime('2026-09-25T09:00:00.000Z', now)).toBe('3 小时前');
    expect(relativeTime('2026-09-23T12:00:00.000Z', now)).toBe('2 天前');
    expect(relativeTime('2026-08-25T12:00:00.000Z', now)).toBe('1 个月前');
  });
});
