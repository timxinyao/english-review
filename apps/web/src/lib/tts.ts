/**
 * TTS：后端代理获取音频 + Web Audio API（AudioContext）播放。
 *
 * 为什么不用 <audio>：会触发灵动岛"正在播放"（媒体播放器注册）。
 * 为什么不用 speechSynthesis：走系统音效通道，被 iOS 静音拨片拦截。
 *
 * AudioContext 在用户手势中创建/resume 后走 .playback 通道：
 * ✅ 静音拨片下出声   ✅ 不触发灵动岛   ✅ 解码后缓存内存（重播零延迟）
 */
let audioCtx: AudioContext | null = null;
const bufferCache = new Map<string, AudioBuffer>();

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
}

export async function speak(text: string): Promise<void> {
  const key = text.slice(0, 200);

  // 1. 取/建 AudioContext（必须在用户手势调用栈内——按钮 onClick 满足）
  const ctx = getCtx();

  // 2. 缓存命中 → 直接播放（零延迟）
  let buffer = bufferCache.get(key);
  if (buffer) {
    playBuffer(ctx, buffer);
    return;
  }

  // 3. 首次：拉取音频 → 解码 → 缓存 → 播放
  try {
    const res = await fetch(`/api/tts?text=${encodeURIComponent(key)}`);
    if (!res.ok) return;
    const arrayBuffer = await res.arrayBuffer();
    buffer = await ctx.decodeAudioData(arrayBuffer);
    bufferCache.set(key, buffer);
    playBuffer(ctx, buffer);
  } catch {
    // 静默失败（不打断学习流程）
  }
}

function playBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
}
