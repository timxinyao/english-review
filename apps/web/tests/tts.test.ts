import { beforeEach, describe, expect, it, vi } from 'vitest';

const closedContexts: unknown[] = [];

class FakeAudioContext {
  state = 'running';
  close = vi.fn(async () => {
    closedContexts.push(this);
  });
  decodeAudioData = vi.fn(async () => ({ tag: 'buffer' }) as unknown as AudioBuffer);
  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    } as unknown as AudioBufferSourceNode;
  }
  get destination() {
    return {} as AudioNode;
  }
}

let playSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })),
  );
  document.querySelectorAll('audio').forEach((a) => a.remove());
});

describe('tts iOS 静音拨片解锁（手势门控）', () => {
  it('非手势 speak（自动发音）不尝试解锁', async () => {
    const { speak } = await import('../src/lib/tts');
    await speak('hello');
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('首次手势 speak 播放 playsinline 近无声解锁音频一次；后续不再解锁', async () => {
    const { speak } = await import('../src/lib/tts');
    await speak('hello', { userGesture: true });
    expect(playSpy).toHaveBeenCalledTimes(1);
    // 解锁元素不挂 DOM（游离播放即可），从 play 调用实例捕获
    const el = playSpy.mock.instances[0] as HTMLAudioElement;
    expect(el).toBeTruthy();
    expect(el.hasAttribute('playsinline')).toBe(true);
    expect(el.src.startsWith('data:audio/wav;base64,')).toBe(true);
    await speak('world', { userGesture: true });
    await speak('auto');
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('冷启动场景：自动朗读先建 ctx，首次手动发音废弃重建（手势内）', async () => {
    const { speak } = await import('../src/lib/tts');
    await speak('auto'); // 无手势：创建 ctx#1（模拟 iOS 判死）
    const ctxCountBefore = closedContexts.length;
    await speak('hello', { userGesture: true });
    // 无手势创建的 ctx 被 close，并在手势内重建
    expect(closedContexts.length).toBe(ctxCountBefore + 1);
    await speak('again', { userGesture: true }); // 已是手势 ctx：不再重建
    expect(closedContexts.length).toBe(ctxCountBefore + 1);
  });

  it('解锁播放被拒绝不锁定：发音照常，下次手势重试解锁', async () => {
    playSpy.mockRejectedValueOnce(new Error('not allowed'));
    const { speak } = await import('../src/lib/tts');
    await expect(speak('hello', { userGesture: true })).resolves.toBeUndefined();
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    // 未锁定：下一次手势再次尝试
    await speak('world', { userGesture: true });
    expect(playSpy).toHaveBeenCalledTimes(2);
  });
});
