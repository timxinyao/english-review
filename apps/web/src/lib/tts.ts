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
/** 当前正在播放的音频源——新播放前 stop 旧的，全局互斥（词/例句/任何文本） */
let currentSource: AudioBufferSourceNode | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
}

/** 停止当前播放（如果有） */
export function stopSpeaking(): void {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // already stopped
    }
    currentSource = null;
  }
}

export async function speak(text: string): Promise<void> {
  const key = text.slice(0, 200);
  const ctx = getCtx();

  let buffer = bufferCache.get(key);
  if (buffer) {
    playBuffer(ctx, buffer);
    return;
  }

  try {
    const res = await fetch(`/api/tts?text=${encodeURIComponent(key)}`);
    if (!res.ok) return;
    const arrayBuffer = await res.arrayBuffer();
    buffer = await ctx.decodeAudioData(arrayBuffer);
    bufferCache.set(key, buffer);
    playBuffer(ctx, buffer);
  } catch {
    // 静默失败
  }
}

function playBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
  stopSpeaking(); // 全局互斥：新播放立即停旧的（无论之前在播什么）

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  currentSource = source;

  source.onended = () => {
    if (currentSource === source) currentSource = null;
  };
}
