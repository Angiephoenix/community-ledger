import { useEffect, useRef, type ReactNode } from 'react';
import type { ChargeStatus } from '../../domain/ledger';
import { IconAlert, IconCalendar, IconCheckCircle, IconClock, IconClose } from './Icons';

export function StatusChip({ status }: { status: ChargeStatus }) {
  switch (status) {
    case 'paid':
      return (
        <span className="chip chip-paid">
          <IconCheckCircle size={16} /> Paid
        </span>
      );
    case 'overdue':
      return (
        <span className="chip chip-overdue">
          <IconAlert size={16} /> Overdue
        </span>
      );
    case 'due-soon':
      return (
        <span className="chip chip-soon">
          <IconClock size={16} /> Due soon
        </span>
      );
    default:
      return (
        <span className="chip chip-later">
          <IconCalendar size={16} /> Upcoming
        </span>
      );
  }
}

/** Accessible modal dialog using the native <dialog> element. */
export function Modal({
  open,
  onClose,
  title,
  children,
  className = '',
  hideTitle = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
  hideTitle?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="modal-inner">
          <div className={`modal-head ${hideTitle ? 'modal-head-floating' : ''}`}>
            <h2 className={hideTitle ? 'visually-hidden' : ''}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <IconClose />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function SimLabel({ children = 'Simulation' }: { children?: ReactNode }) {
  return <span className="sim-label">{children}</span>;
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
