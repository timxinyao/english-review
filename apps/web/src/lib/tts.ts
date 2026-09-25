/**
 * 浏览器 TTS：iOS 需首次手势解锁 + voiceschanged 缓存 + 同步调用。
 */
let cachedVoices: SpeechSynthesisVoice[] = [];
let unlocked = false;

function initVoiceCache(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  cachedVoices = synth.getVoices();
  synth.addEventListener('voiceschanged', () => {
    cachedVoices = synth.getVoices();
  });
}

initVoiceCache();

function unlockSpeech(): void {
  if (unlocked || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance('');
  u.volume = 0;
  window.speechSynthesis.speak(u);
  unlocked = true;
}

if (typeof document !== 'undefined') {
  document.addEventListener('touchend', () => unlockSpeech(), { once: true, passive: true });
  document.addEventListener('click', () => unlockSpeech(), { once: true, passive: true });
}

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
  if (synth.speaking || synth.pending) synth.cancel();
  synth.speak(utterance);
}
