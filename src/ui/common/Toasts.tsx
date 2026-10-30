import { useEffect, useRef } from 'react';
import { dismissToast, type Toast } from '../../state/store';
import { IconClose } from './Icons';

// Action feedback. The visible toast is a manual popover so it sits in the
// browser's top layer, above open dialogs such as Demo controls. It is raised
// again whenever a dialog opens. Screen readers get the same text from a
// permanent live region, because a popover that appears with its content
// already inside is not reliably announced.
export function Toasts({ toasts }: { toasts: Toast[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = toasts.at(-1);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== 'function') return;
    const raise = () => {
      try {
        if (el.matches(':popover-open')) el.hidePopover();
        if (el.childElementCount > 0) el.showPopover();
      } catch {
        /* popover unsupported: the fixed-position fallback still shows */
      }
    };
    raise();
    const observer = new MutationObserver(raise);
    observer.observe(document.body, { subtree: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, [latest?.id]);

  return (
    <>
      <div className="visually-hidden" role="status" aria-live="polite">
        {latest?.text ?? ''}
      </div>
      <div ref={ref} popover="manual" className="toasts no-print">
        {latest && (
          <div key={latest.id} className={`toast toast-${latest.tone}`}>
            <span>{latest.text}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss message" onClick={() => dismissToast(latest.id)}>
              <IconClose size={16} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
