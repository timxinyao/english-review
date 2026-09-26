/**
 * 浏览器 TTS：iOS 排查版——诊断信息直接显示在页面 Toast 上（无需电脑连调）。
 */
export interface TtsDebug {
  ok: boolean;
  message: string;
}

export function speak(text: string, onDebug?: (d: TtsDebug) => void): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    onDebug?.({ ok: false, message: 'speechSynthesis 不可用' });
    return;
  }
  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 1;

  const voices = synth.getVoices();
  const voice =
    voices.find((v) => v.lang === 'en-US') ?? voices.find((v) => v.lang.startsWith('en'));
  if (voice) utterance.voice = voice;

  utterance.onstart = () => onDebug?.({ ok: true, message: `朗读中（${voice?.name ?? '默认'}）` });
  utterance.onend = () => onDebug?.({ ok: true, message: '' }); // 空消息 = 清除提示
  utterance.onerror = (e) =>
    onDebug?.({ ok: false, message: `错误: ${e.error}（voices=${voices.length}）` });

  try {
    synth.speak(utterance);
    // 500ms 后如果还没 start，可能是静默失败
    setTimeout(() => {
      if (!synth.speaking && !synth.pending) {
        onDebug?.({ ok: false, message: `未启动（voices=${voices.length}，引擎可能被系统阻止）` });
      }
    }, 500);
  } catch (err) {
    onDebug?.({ ok: false, message: `异常: ${(err as Error).message}` });
  }
}

// 预热 voice 列表
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    window.speechSynthesis.getVoices();
  });
}
