import { describe, expect, it } from 'vitest';
import { normalizeTarget, normalizeText } from '../../src/modules/import-export/service.js';

describe('normalizeTarget', () => {
  it('大小写与首尾空白归一', () => {
    expect(normalizeTarget('  Wear Down ')).toBe('wear down');
  });

  it('压缩内部多余空白（含制表符/换行）', () => {
    expect(normalizeTarget('be    supposed\tto do')).toBe('be supposed to do');
  });

  it('去除指定标点 .,!?\'"；:', () => {
    expect(normalizeTarget('"Steady."')).toBe('steady');
    expect(normalizeTarget("it's")).toBe('its');
    expect(normalizeTarget('raw,')).toBe('raw');
    expect(normalizeTarget('wear down!')).toBe('wear down');
    expect(normalizeTarget('steady;')).toBe('steady');
    expect(normalizeTarget('gravity:')).toBe('gravity');
  });

  it('组合：大小写 + 多空白 + 标点', () => {
    expect(normalizeTarget('  Wear  DOWN; ')).toBe('wear down');
    expect(normalizeTarget('What?!')).toBe('what');
  });

  it('大小写不同的同 target 归一后相等', () => {
    expect(normalizeTarget('Gravity')).toBe(normalizeTarget('gravity'));
    expect(normalizeTarget('GRAVITY')).toBe('gravity');
  });
});

describe('normalizeText', () => {
  it('压缩空白并转小写，保留其余字符', () => {
    expect(normalizeText('  逐渐  消耗 ')).toBe('逐渐 消耗');
    expect(normalizeText('It  Wears You Down.')).toBe('it wears you down.');
  });
});
