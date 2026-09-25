/**
 * 浏览器 TTS（PRODUCT §12.1）：词/词块与例句朗读，优先 en-US voice；不保存音频。
 * iOS 兼容：voices 异步加载（voiceschanged 缓存）；cancel 后需微延迟再 speak，
 * 否则 iOS WKWebView 会把新 utterance 一并取消。
 */
let cachedVoices: SpeechSynthesisVoice[] = [];

function initVoiceCache(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  cachedVoices = synth.getVoices();
  synth.addEventListener('voiceschanged', () => {
    cachedVoices = synth.getVoices();
  });
}

initVoiceCache();

export function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 0.9;

  const voices = cachedVoices.length > 0 ? cachedVoices : synth.getVoices();
  const voice =
    voices.find((v) => v.lang === 'en-US') ?? voices.find((v) => v.lang.startsWith('en'));
  if (voice) utterance.voice = voice;

  // iOS：speak 必须在手势同步调用栈内执行，setTimeout 会丢失手势上下文导致静音
  if (synth.speaking || synth.pending) synth.cancel();
  synth.speak(utterance);
}
