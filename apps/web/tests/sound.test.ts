import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playGradingCue, resetGradingCueForTests } from '../src/lib/sound';

// ---------- 最小面 AudioContext mock（OscillatorNode/GainNode/connect/start/stop）----------

interface OscNode {
  type: string;
  frequency: { value: number };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  state: 'running' | 'suspended';
  currentTime = 1;
  destination = { node: 'destination' };
  resume = vi.fn(() => Promise.resolve());
  oscillators: OscNode[] = [];

  constructor(state: 'running' | 'suspended' = 'running') {
    this.state = state;
    MockAudioContext.instances.push(this);
  }

  private audioParam() {
    return {
      value: 0,
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    };
  }

  createGain() {
    return { gain: this.audioParam(), connect: vi.fn() };
  }

  createOscillator() {
    const osc: OscNode = {
      type: 'sine',
      frequency: this.audioParam(),
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.oscillators.push(osc);
    return osc;
  }
}

const realAudioContext = window.AudioContext;

beforeEach(() => {
  resetGradingCueForTests();
  MockAudioContext.instances = [];
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    writable: true,
    value: MockAudioContext,
  });
});

afterEach(() => {
  vi.restoreAllMocks(); // 还原 Date.now spy
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    writable: true,
    value: realAudioContext,
  });
});

describe('playGradingCue（Web Audio 合成提示音）', () => {
  it('done：两连音 E5→A5（各 90ms，间隔 60ms），2 次 oscillator start', () => {
    playGradingCue('done');

    expect(MockAudioContext.instances).toHaveLength(1);
    const ctx = MockAudioContext.instances[0]!;
    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.oscillators.map((o) => o.frequency.value)).toEqual([659.25, 880]);
    for (const osc of ctx.oscillators) {
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
      // 90ms 音长：stop 晚于 start（含 20ms 收尾余量）
      expect(osc.stop.mock.calls[0]![0]).toBeGreaterThan(osc.start.mock.calls[0]![0]);
    }
    // 两音起点间隔 150ms（90ms 音长 + 60ms 间隔）
    expect(ctx.oscillators[1]!.start.mock.calls[0]![0] - ctx.oscillators[0]!.start.mock.calls[0]![0]).toBeCloseTo(
      0.15,
      5,
    );
  });

  it('fail：单低音 A3（约 140ms），仅 1 次 oscillator start', () => {
    playGradingCue('fail');

    const ctx = MockAudioContext.instances[0]!;
    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.oscillators[0]!.frequency.value).toBe(220);
    expect(ctx.oscillators[0]!.start).toHaveBeenCalledTimes(1);
  });

  it('防抖：200ms 内第二次调用直接合并，不新建 context 调用链（start 次数不变）', () => {
    playGradingCue('done');
    playGradingCue('fail'); // 200ms 内：被防抖吞掉

    expect(MockAudioContext.instances).toHaveLength(1);
    const ctx = MockAudioContext.instances[0]!;
    expect(ctx.oscillators).toHaveLength(2); // 仅第一次 done 的两音
    expect(ctx.oscillators.map((o) => o.start)).toHaveLength(2);
    expect(ctx.createGain).toBeDefined();

    // 越过 200ms 后恢复发声（fail 单音）
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 250);
    playGradingCue('fail');
    expect(ctx.oscillators).toHaveLength(3);
  });

  it('AudioContext 惰性单例：跨调用复用同一实例', () => {
    playGradingCue('done');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 250);
    playGradingCue('done');
    expect(MockAudioContext.instances).toHaveLength(1);
  });

  it('首次调用若 suspended 则 resume（iOS 手势链）', () => {
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: class extends MockAudioContext {
        constructor() {
          super('suspended');
        }
      },
    });
    playGradingCue('done');
    expect(MockAudioContext.instances[0]!.state).toBe('suspended');
    expect(MockAudioContext.instances[0]!.resume).toHaveBeenCalledTimes(1);
  });
});
