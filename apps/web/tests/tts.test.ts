import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeAudioContext {
  state = 'running';
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

describe('tts iOS 静音拨片解锁', () => {
  it('首次 speak 创建 playsinline 近无声解锁音频并播放一次；二次 speak 不再解锁', async () => {
    const { speak } = await import('../src/lib/tts');
    await speak('hello');
    expect(playSpy).toHaveBeenCalledTimes(1);
    // 解锁元素不挂 DOM（游离播放即可），从 play 调用实例捕获
    const el = playSpy.mock.instances[0] as HTMLAudioElement;
    expect(el).toBeTruthy();
    expect(el.hasAttribute('playsinline')).toBe(true);
    expect(el.src.startsWith('data:audio/wav;base64,')).toBe(true);
    await speak('world');
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('解锁播放被拒绝不阻塞发音（fetch/播放照常）', async () => {
    playSpy.mockRejectedValueOnce(new Error('not allowed'));
    const { speak } = await import('../src/lib/tts');
    await expect(speak('hello')).resolves.toBeUndefined();
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
});
