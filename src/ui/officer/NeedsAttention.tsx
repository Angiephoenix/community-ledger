import { useState } from 'react';
import { formatDateTime } from '../../domain/time';
import { memberName } from '../../domain/ledger';
import type { LedgerState, Task } from '../../domain/types';
import { actions } from '../../state/store';
import { EmptyState } from '../common/bits';
import { IconAlert, IconCheckCircle, IconClock, IconFlag, IconInfo } from '../common/Icons';

const typeLabel: Record<Task['type'], string> = {
  'unapplied-credit': 'Extra payment',
  'held-event': 'Held payment',
  'unresolved-payment': 'Unconfirmed payment',
  'invalid-rule': 'Dues rule',
  discrepancy: 'Member report',
  'event-failed': 'Payment event',
};

const decisionNote: Partial<Record<Task['type'], string>> = {
  'unapplied-credit': 'Refunds and carrying credit forward are not built yet because the group has not set a rule. Marking reviewed moves no money.',
  'unresolved-payment': 'The payment is re-checked automatically if a confirmation arrives. Marking reviewed does not credit or cancel it.',
  'held-event': 'Held payments are not applied. Resolving them needs the connected provider’s verification.',
};

export function NeedsAttention({ ledger }: { ledger: LedgerState }) {
  const [showClosed, setShowClosed] = useState(false);
  const open = ledger.tasks.filter((t) => t.status === 'open').reverse();
  const closed = ledger.tasks.filter((t) => t.status !== 'open').reverse();
  return (
    <div className="page">
      <h1>Needs attention</h1>
      <p className="muted">Ordinary confirmed payments are handled automatically. Only cases that need a decision appear here.</p>
      {open.length === 0 ? (
        <EmptyState title="Nothing needs attention" icon={<IconCheckCircle size={28} />} />
      ) : (
        <ul className="task-list">
          {open.map((t) => (
            <TaskCard key={t.id} ledger={ledger} task={t} />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <section className="card">
          <button type="button" className="btn btn-ghost" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? 'Hide' : 'Show'} closed items ({closed.length})
          </button>
          {showClosed && (
            <ul className="rows">
              {closed.map((t) => (
                <li key={t.id} className="row">
                  <span className="row-main">
                    <strong>
                      {t.title} · {t.status === 'resolved' ? 'Resolved automatically' : 'Reviewed'}
                    </strong>
                    <span className="muted">
                      {t.closeNote} · {t.closedAt && formatDateTime(t.closedAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function TaskCard({ ledger, task }: { ledger: LedgerState; task: Task }) {
  const [note, setNote] = useState('');
  const Icon = task.type === 'unresolved-payment' ? IconClock : task.type === 'discrepancy' ? IconFlag : task.type === 'unapplied-credit' ? IconInfo : IconAlert;
  const noteId = `note-${task.id}`;
  return (
    <li className="card task">
      <div className="task-head">
        <span className="state-dot is-pending">
          <Icon size={18} />
        </span>
        <div className="row-main">
          <span className="task-type">{typeLabel[task.type]}</span>
          <strong>{task.title}</strong>
          <span className="muted">
            {task.memberId ? `${memberName(ledger, task.memberId)} · ` : ''}
            {formatDateTime(task.createdAt)}
          </span>
        </div>
      </div>
      <p>{task.detail}</p>
      {decisionNote[task.type] && <p className="fine">{decisionNote[task.type]}</p>}
      <form
        className="task-form"
        onSubmit={(e) => {
          e.preventDefault();
          actions.reviewTask(task.id, note);
        }}
      >
        <label htmlFor={noteId} className="field-label">
          Note for the record (optional)
        </label>
        <input id={noteId} className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" className="btn btn-secondary">
          Mark as reviewed
        </button>
      </form>
    </li>
  );
}
