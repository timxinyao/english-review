/**
 * 浏览器 TTS（PRODUCT §12.1）：词/词块与例句朗读，优先 en-US voice；不保存音频。
 * jsdom 与不支持 SpeechSynthesis 的环境下静默跳过。
 */
export function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  const voices = synth.getVoices();
  const voice =
    voices.find((v) => v.lang === 'en-US') ?? voices.find((v) => v.lang.startsWith('en'));
  if (voice) utterance.voice = voice;
  synth.cancel(); // 打断上一次朗读，避免排队堆积
  synth.speak(utterance);
}
