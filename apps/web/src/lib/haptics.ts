/** Progressive enhancement only: API availability does not prove physical vibration. */
const KEY = 'el:haptics';
export type HapticKind = 'selection' | 'confirm';
export function hapticsSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}
export function hapticsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
export function setHapticsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0');
  } catch {
    /* unavailable storage is safe */
  }
}
/** Call synchronously from a user gesture, never from network callbacks or background timers. */
export function haptic(kind: HapticKind): boolean {
  if (!hapticsSupported() || !hapticsEnabled() || document.visibilityState === 'hidden')
    return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  try {
    return navigator.vibrate(kind === 'selection' ? 8 : 16);
  } catch {
    return false;
  }
}
