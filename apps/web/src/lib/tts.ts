/**
 * 浏览器 TTS（PRODUCT §12.1）：词/词块与例句朗读，优先 en-US voice。
 *
 * iOS 排查指南（2026-09-26）：
 * - 如果点按钮没声音，用 Mac Safari → 开发 → 你的 iPhone → 控制台查看下方日志
 * - "voices=0" 表示系统语音列表未加载（iOS 26 独立窗口已知问题）
 * - "speak error: ..." 表示引擎报错
 * - cancel() 已去掉：iOS 上 cancel 紧跟 speak 会把新语音一并取消
 */
export function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    console.warn('[tts] speechSynthesis 不可用');
    return;
  }
  const synth = window.speechSynthesis;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 1;

  const voices = synth.getVoices();
  const voice =
    voices.find((v) => v.lang === 'en-US') ?? voices.find((v) => v.lang.startsWith('en'));
  if (voice) {
    utterance.voice = voice;
  }
  console.log(
    `[tts] speak "${text.slice(0, 30)}" voices=${voices.length} voice=${voice?.name ?? 'default'}`,
  );

  utterance.onerror = (e) => console.warn('[tts] speak error:', e.error);
  utterance.onstart = () => console.log('[tts] started');
  utterance.onend = () => console.log('[tts] ended');

  // 注意：不调 cancel()——iOS 上 cancel 紧跟 speak 会把新语音一并取消
  synth.speak(utterance);
}

// 预热 voice 列表（某些浏览器首次 getVoices 为空，异步加载后才可用）
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.getVoices(); // 触发加载
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    const v = window.speechSynthesis.getVoices();
    console.log(`[tts] voices loaded: ${v.length}`);
  });
}
