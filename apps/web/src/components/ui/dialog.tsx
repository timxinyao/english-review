import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

const focusable =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Portal, focus containment, Escape and scroll restoration for every blocking sheet. */
export function Dialog({
  label,
  children,
  onClose,
  dismissible = true,
  sheet = false,
  className,
}: {
  label: string;
  children: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  sheet?: boolean;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, dismissible });
  latest.current = { onClose, dismissible };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const element = root.current!;
    const siblings = Array.from(document.body.children).filter(
      (el) => el !== element,
    ) as HTMLElement[];
    const inert = siblings.map((el) => el.inert);
    siblings.forEach((el) => {
      el.inert = true;
    });
    const controls = () =>
      Array.from(element.querySelectorAll<HTMLElement>(focusable)).filter(
        (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true',
      );
    (controls()[0] ?? element).focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (element.inert) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (latest.current.dismissible) latest.current.onClose();
      }
      if (event.key === 'Tab') {
        const items = controls();
        const first = items[0];
        const last = items.at(-1);
        if (!first) {
          event.preventDefault();
          element.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === element)
        ) {
          event.preventDefault();
          last!.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === element)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (!element.inert && !element.contains(event.target as Node))
        (controls()[0] ?? element).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', containFocus);
      document.body.style.overflow = overflow;
      siblings.forEach((el, index) => {
        el.inert = inert[index] ?? false;
      });
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={cn(
        'dialog-backdrop fixed inset-0 z-overlay flex bg-foreground/25 outline-none',
        sheet ? 'items-end justify-center sm:items-center' : 'items-center justify-center p-5',
      )}
      onClick={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      <div
        className={cn(
          'dialog-panel w-full overflow-y-auto rounded-xl border border-border bg-card p-5',
          sheet ? 'dialog-sheet max-w-xl' : 'max-w-[360px]',
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
