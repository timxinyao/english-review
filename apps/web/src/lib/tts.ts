/**
 * TTS：通过后端代理获取音频 + <audio playsinline> 播放。
 * iOS speechSynthesis 走"系统音效"通道（跟随静音拨片），
 * <audio> 走"媒体播放"通道（不跟随静音拨片）——Spotify/YouTube 同理。
 * 音频由浏览器缓存 24h（后端设了 cache-control），重复点击零延迟。
 */
export function speak(text: string): void {
  const key = text.slice(0, 200);
  const audio = new Audio(`/api/tts?text=${encodeURIComponent(key)}`);
  audio.setAttribute('playsinline', 'true');
  audio.play().catch(() => {});
}
