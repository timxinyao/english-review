import { afterEach, describe, expect, it, vi } from 'vitest';
import { haptic, hapticsSupported, hapticsEnabled, setHapticsEnabled } from '../src/lib/haptics';
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
});
describe('optional haptic feedback', () => {
  it('is opt-in and unsupported browsers are a no-op', () => {
    expect(hapticsSupported()).toBe(false);
    expect(hapticsEnabled()).toBe(false);
    expect(haptic('selection')).toBe(false);
  });
  it('requests a short pulse only when opted in and exposed by browser', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    expect(haptic('selection')).toBe(false);
    setHapticsEnabled(true);
    expect(haptic('selection')).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(8);
    setHapticsEnabled(false);
    expect(haptic('selection')).toBe(false);
  });
  it('survives denied storage and browser errors', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(haptic('selection')).toBe(false);
    expect(hapticsEnabled()).toBe(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => setHapticsEnabled(true)).not.toThrow();
  });
  it('does not vibrate in the background', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    setHapticsEnabled(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    expect(haptic('selection')).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });
  it('does not request vibration with reduced motion', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    setHapticsEnabled(true);
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    expect(haptic('confirm')).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });
  it('ignores errors from an exposed vibration API', () => {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        throw new Error('unsupported');
      },
    });
    setHapticsEnabled(true);
    expect(haptic('confirm')).toBe(false);
  });
});
