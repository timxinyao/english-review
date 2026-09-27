/**
 * TTS：后端代理获取音频 + Web Audio API（AudioContext）播放。
 *
 * 为什么不用 <audio>：会触发灵动岛"正在播放"（媒体播放器注册）。
 * 为什么不用 speechSynthesis：走系统音效通道，被 iOS 静音拨片拦截。
 *
 * AudioContext 在用户手势中创建/resume 后走 .playback 通道：
 * ✅ 不触发灵动岛   ✅ 解码后缓存内存（重播零延迟）
 *
 * iOS 静音拨片（2026-09-27 修复）：AudioContext 默认仍会被静音拨片拦截——
 * 之前"修复成功"是同一进程内先跑过 <audio> 版本（4c8cde3）把进程音频会话
 * 切到媒体类别的残留效果。进程重启后失效。现以"近无声解锁"显式完成这件事：
 * 进程内首次 speak 先用 <audio playsinline> 播 0.3s 振幅±5 的近无声 WAV
 * （技术上非静音播放），进程会话切到媒体类别（忽略静音拨片）且持续到进程结束；
 * 短促近无声片段不触发灵动岛。
 */
let audioCtx: AudioContext | null = null;
/** AudioContext 是否在用户手势内创建——iOS 对无手势创建的上下文可能永久静音（2026-09-28 实测） */
let ctxCreatedInGesture = false;
const bufferCache = new Map<string, AudioBuffer>();
/** 当前正在播放的音频源——新播放前 stop 旧的，全局互斥（词/例句/任何文本） */
let currentSource: AudioBufferSourceNode | null = null;
let sessionUnlocked = false;

function getCtx(inGesture: boolean): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    ctxCreatedInGesture = inGesture;
  }
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
}

/** 手势内重建上下文：冷启动时自动朗读（无手势）先行创建的 ctx 可能被 iOS 永久静音，
 *  首次手动发音时废弃重建（AudioBuffer 跨上下文有效，缓存可复用） */
async function ensureGestureCtx(): Promise<AudioContext> {
  if (audioCtx && !ctxCreatedInGesture) {
    const dead = audioCtx;
    audioCtx = null;
    try {
      await dead.close();
    } catch {
      // 关闭失败忽略，旧实例交由 GC
    }
  }
  return getCtx(true);
}

/**
 * iOS 静音拨片解锁：近无声媒体播放一次（进程内）。
 * 必须在用户手势内调用（自动发音的 effect 调用栈无手势，iOS 会拒绝 play()）；
 * 成功才锁定——失败（如首次来自自动朗读）保持未解锁，下次手势再试。
 */
async function unlockAudioSession(inGesture: boolean): Promise<void> {
  if (sessionUnlocked || !inGesture) return;
  try {
    const el = document.createElement('audio');
    el.setAttribute('playsinline', '');
    el.src = `data:audio/wav;base64,UklGRuQSAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YcASAAAFAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD7/wUA+/8=`;
    await el.play();
    sessionUnlocked = true; // 成功才锁定；失败下次手势重试
  } catch {
    // 解锁失败（非手势栈/系统限制/系统拒绝）：忽略，发音流程继续
  }
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

export async function speak(text: string, opts: { userGesture?: boolean } = {}): Promise<void> {
  const key = text.slice(0, 200);
  const inGesture = opts.userGesture === true;
  await unlockAudioSession(inGesture);
  const ctx = inGesture ? await ensureGestureCtx() : getCtx(false);

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
