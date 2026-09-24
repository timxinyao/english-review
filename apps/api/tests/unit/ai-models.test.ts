import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import {
  FALLBACK_MODELS,
  parseModelVersion,
  pickFlashModel,
  pickMainModel,
  resolveModelConfig,
} from '../../src/ai/models.js';

function configWith(models: Partial<AppConfig['glmModels']>): AppConfig['glmModels'] {
  return { flash: '', air: '', max: '', ...models };
}

describe('parseModelVersion', () => {
  it('解析主版本与多段版本', () => {
    expect(parseModelVersion('glm-5.3')).toEqual([5, 3]);
    expect(parseModelVersion('glm-5.3-flash')).toEqual([5, 3]);
    expect(parseModelVersion('glm-4.5-air')).toEqual([4, 5]);
    expect(parseModelVersion('glm-5.10-turbo')).toEqual([5, 10]);
    expect(parseModelVersion('not-glm')).toBeNull();
  });

  it('数字段比较（5.10 > 5.9 > 5.3）', () => {
    // 数组不能直接用 > 比较（会走字符串化）；逐段数字比较
    const cmp = (a: string, b: string): number => {
      const va = parseModelVersion(a)!;
      const vb = parseModelVersion(b)!;
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (va[i] ?? 0) - (vb[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    };
    expect(cmp('glm-5.10', 'glm-5.9')).toBeGreaterThan(0);
    expect(cmp('glm-5.9', 'glm-5.3')).toBeGreaterThan(0);
  });
});

describe('pickFlashModel', () => {
  it('取版本最高的 flash 型号，同版本取更短名', () => {
    const ids = [
      'glm-4.5',
      'glm-4.5-air',
      'glm-5.2',
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-flashx',
      'glm-5.4',
    ];
    expect(pickFlashModel(ids)).toBe('glm-5.3-flash');
  });

  it('新版本出现时自动跟进（5.4-flash）', () => {
    const ids = ['glm-5.3-flash', 'glm-5.4-flash', 'glm-5.3'];
    expect(pickFlashModel(ids)).toBe('glm-5.4-flash');
  });

  it('无 flash 型号返回 null', () => {
    expect(pickFlashModel(['glm-5.3', 'glm-5.3-turbo'])).toBeNull();
  });
});

describe('pickMainModel', () => {
  it('取版本最高的无后缀主模型', () => {
    const ids = [
      'glm-4.5',
      'glm-4.6',
      'glm-5',
      'glm-5.2',
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5-turbo',
    ];
    expect(pickMainModel(ids)).toBe('glm-5.3');
  });

  it('无主模型返回 null', () => {
    expect(pickMainModel(['glm-5.3-flash'])).toBeNull();
  });
});

describe('resolveModelConfig', () => {
  const LIST = ['glm-4.5', 'glm-4.5-air', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'];

  it('未指定 → auto 按清单选择', () => {
    const r = resolveModelConfig(configWith({}), LIST, new Date('2026-09-25T00:00:00Z'));
    expect(r.models.flash).toEqual({ model: 'glm-5.3-flash', source: 'auto', inList: true });
    expect(r.models.air).toEqual({ model: 'glm-5.3', source: 'auto', inList: true });
    expect(r.models.max).toEqual({ model: 'glm-5.3', source: 'auto', inList: true });
    expect(r.availableModels).toEqual(LIST);
    expect(r.checkedAt).toBe('2026-09-25T00:00:00.000Z');
  });

  it('显式指定 → config 优先（即便不在清单，inList=false）', () => {
    const r = resolveModelConfig(
      configWith({ flash: 'glm-4.5-air', air: 'glm-5.2' }),
      LIST,
      new Date('2026-09-25T00:00:00Z'),
    );
    expect(r.models.flash).toEqual({ model: 'glm-4.5-air', source: 'config', inList: true });
    expect(r.models.air).toEqual({ model: 'glm-5.2', source: 'config', inList: true });
    expect(r.models.max.source).toBe('auto');
  });

  it('指定不存在的型号 → 仍使用但 inList=false', () => {
    const r = resolveModelConfig(configWith({ air: 'glm-9.9' }), LIST, new Date());
    expect(r.models.air).toEqual({ model: 'glm-9.9', source: 'config', inList: false });
  });

  it('发现失败（空清单）且未指定 → fallback 常量', () => {
    const r = resolveModelConfig(configWith({}), [], new Date());
    expect(r.models.flash).toEqual({
      model: FALLBACK_MODELS.flash,
      source: 'fallback',
      inList: false,
    });
    expect(r.models.air.source).toBe('fallback');
    expect(r.availableModels).toEqual([]);
  });
});
