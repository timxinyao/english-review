import { describe, expect, it } from 'vitest';
import { notificationTag, parsePushPayload, shouldShowNotification } from '../src/lib/push-payload';

/**
 * SW push 载荷处理分支（sw.ts 与本模块共用——sw.ts 属 WebWorker lib 单独 tsconfig，
 * 不便直接实例化测试，决策逻辑全量收敛于此做行为断言）。
 */
describe('Web Push 载荷处理（sw.ts push 事件共用逻辑）', () => {
  it('test:true 自检载荷恒弹：前台可见窗口也弹（绕过静默——订阅瞬间用户必在前台）', () => {
    expect(shouldShowNotification({ test: true, title: '通知已开启' }, true)).toBe(true);
    expect(shouldShowNotification({ test: true }, false)).toBe(true);
  });

  it('批改载荷：任一可见窗口静默（用户正看着结果卡）；后台/无窗口弹', () => {
    expect(shouldShowNotification({ title: '造句批改完成' }, true)).toBe(false);
    expect(shouldShowNotification({ title: '造句批改完成' }, false)).toBe(true);
    expect(shouldShowNotification({}, false)).toBe(true);
  });

  it('自检与批改通知 tag 互异（同 tag 才覆盖，自检不顶掉真实批改通知）', () => {
    expect(notificationTag({ test: true })).toBe('push-selftest');
    expect(notificationTag({ title: '造句批改完成' })).toBe('grading');
    expect(notificationTag({})).toBe('grading');
  });

  it('载荷解析：JSON 全量透出；空/非 JSON/非对象回退空对象（默认标题 + /today）', () => {
    expect(parsePushPayload('{"title":"a","body":"b","url":"/today","test":true}')).toEqual({
      title: 'a',
      body: 'b',
      url: '/today',
      test: true,
    });
    expect(parsePushPayload(undefined)).toEqual({});
    expect(parsePushPayload(null)).toEqual({});
    expect(parsePushPayload('')).toEqual({});
    expect(parsePushPayload('not-json')).toEqual({});
    expect(parsePushPayload('["array"]')).toEqual({});
  });
});
