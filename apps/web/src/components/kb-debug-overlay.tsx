/**
 * 【临时调试代码——键盘避让真机诊断用，问题定位后整体删除】
 * 固定浮层实时显示：build 标识、innerHeight、visualViewport 高/偏移、
 * --kb-inset（hook 值与 CSS 变量）、window.scrollY，以及最近 6 条
 * resize/scroll/focus 事件快照。挂载于 shell，全页面可见。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useKeyboardInset } from '../lib/keyboard-inset';

declare const __BUILD_TAG__: string;

interface Snap {
  t: string;
  ev: string;
  ih: number;
  vh: number;
  vo: number;
  inset: number;
  sy: number;
}

function snapOf(ev: string): Snap {
  const vv = window.visualViewport;
  return {
    t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    ev,
    ih: Math.round(window.innerHeight),
    vh: vv ? Math.round(vv.height) : -1,
    vo: vv ? Math.round(vv.offsetTop) : -1,
    inset: Math.max(0, Math.round(window.innerHeight - (vv ? vv.height + vv.offsetTop : window.innerHeight))),
    sy: Math.round(window.scrollY),
  };
}

export function KbDebugOverlay(): ReactNode {
  const inset = useKeyboardInset();
  const [snap, setSnap] = useState<Snap>(() => snapOf('init'));
  const historyRef = useRef<Snap[]>([]);
  const [history, setHistory] = useState<Snap[]>([]);

  useEffect(() => {
    const record = (ev: string) => {
      const s = snapOf(ev);
      setSnap(s);
      historyRef.current = [s, ...historyRef.current].slice(0, 6);
      setHistory(historyRef.current);
    };
    const vv = window.visualViewport;
    vv?.addEventListener('resize', () => record('vv-resize'));
    vv?.addEventListener('scroll', () => record('vv-scroll'));
    window.addEventListener('scroll', () => record('win-scroll'), { passive: true });
    window.addEventListener('focusin', (e) => record(`focus:${(e.target as HTMLElement).tagName}`));
    window.addEventListener('focusout', () => record('focusout'));
    return () => {
      // 常驻调试浮层随 app 生命周期，不拆卸
    };
  }, []);

  const build = typeof __BUILD_TAG__ === 'string' ? __BUILD_TAG__.slice(5, 16) : 'dev';

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed left-1 top-[calc(env(safe-area-inset-top)+3.5rem)] z-[90] max-w-[240px] rounded bg-black/75 px-1.5 py-1 font-mono text-[10px] leading-tight text-lime-200"
    >
      <div>build {build}</div>
      <div>
        ih {snap.ih} vv {snap.vh}/{snap.vo} sy {snap.sy}
      </div>
      <div>
        hook {inset} css {document.documentElement.style.getPropertyValue('--kb-inset') || '-'}
      </div>
      {history.map((h) => (
        <div key={`${h.t}-${h.ev}-${h.inset}-${h.sy}`}>
          {h.t} {h.ev} ih{h.ih} v{h.vh}/{h.vo} ins{h.inset} sy{h.sy}
        </div>
      ))}
    </div>
  );
}
