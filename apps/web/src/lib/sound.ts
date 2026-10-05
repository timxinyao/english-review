/**
 * 前台批改提示音（Web Audio 合成，无素材文件）：
 * - done = 上行两连音（E5→A5，鼓励感）；fail = 单低音（A3，克制不刺耳）
 * - 总增益约 0.12（quiet），音头/音尾 10ms 指数淡入淡出避免爆音
 * - AudioContext 惰性单例；首次调用若 suspended 则 resume（iOS 需手势链——
 *   调用点均在提交/结果交互之后，天然满足）
 * - 连续调用 200ms 防抖合并（React StrictMode 双执行由它兜底）
 */

export type GradingCueKind = 'done' | 'fail';

const MASTER_GAIN = 0.12;
const DEBOUNCE_MS = 200;

/** 单音规格：频率 / 相对起点（s）/ 时长（s） */
interface ToneSpec {
  freq: number;
  at: number;
  duration: number;
}

const CUES: Record<GradingCueKind, ToneSpec[]> = {
  // E5(659.25) 90ms → 间隔 60ms → A5(880) 90ms
  done: [
    { freq: 659.25, at: 0, duration: 0.09 },
    { freq: 880.0, at: 0.15, duration: 0.09 },
  ],
  // A3(220) 140ms
  fail: [{ freq: 220.0, at: 0, duration: 0.14 }],
};

let audioCtx: AudioContext | null = null;
let lastCueAt = 0;

function getAudioContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  const Ctor =
    typeof window !== 'undefined'
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!Ctor) return null; // 环境不支持（如极老浏览器）：静默不响
  audioCtx = new Ctor();
  return audioCtx;
}

export function playGradingCue(kind: GradingCueKind): void {
  const now = Date.now();
  if (now - lastCueAt < DEBOUNCE_MS) return; // 防抖：200ms 内合并为一次
  lastCueAt = now;

  const ctx = getAudioContext();
  if (!ctx) return;
  // iOS Safari 出厂 suspended：调用点在用户手势链内（提交/结果后），resume 即可出声
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);

  const t0 = ctx.currentTime;
  for (const tone of CUES[kind]) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = tone.freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0 + tone.at);
    env.gain.exponentialRampToValueAtTime(1, t0 + tone.at + 0.01);
    env.gain.setValueAtTime(1, t0 + tone.at + tone.duration - 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.at + tone.duration);
    osc.connect(env);
    env.connect(master);
    osc.start(t0 + tone.at);
    osc.stop(t0 + tone.at + tone.duration + 0.02);
  }
}

/** 测试专用：重置单例与防抖时间戳（生产不调用） */
export function resetGradingCueForTests(): void {
  audioCtx = null;
  lastCueAt = 0;
}
