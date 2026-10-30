import { useState } from 'react';
import { formatNaira } from '../../domain/money';
import { formatDayYear } from '../../domain/time';
import { memberSummary } from '../../domain/ledger';
import type { LedgerState } from '../../domain/types';
import { StatusChip } from '../common/bits';
import { IconAlert, IconCheckCircle, IconClock } from '../common/Icons';

export function Members({ ledger, onViewReceipt }: { ledger: LedgerState; onViewReceipt: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="page">
      <h1>Members</h1>
      <p className="muted">Fictional members. Adding or editing members comes with the connected version.</p>
      <ul className="member-cards">
        {ledger.members.map((m) => {
          const s = memberSummary(ledger, m.id);
          const isOpen = open === m.id;
          const receipts = ledger.receipts.filter((r) => r.memberId === m.id);
          return (
            <li key={m.id} className="card member-card">
              <button type="button" className="member-card-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : m.id)}>
                <span className="avatar">{m.displayName.slice(-1)}</span>
                <span className="row-main">
                  <strong>{m.displayName}</strong>
                  <span className="muted">
                    Joined {formatDayYear(m.joinedOn)} · Reminders: {m.reminderChannel === 'none' ? 'off' : m.reminderChannel === 'whatsapp' ? 'WhatsApp' : 'Email'}
                  </span>
                </span>
                <span className="member-figs">
                  <span>
                    <span className="muted">Owes</span> <strong>{formatNaira(s.outstandingKobo)}</strong>
                  </span>
                  <span className="member-flag">
                    {s.charges.length === 0 ? (
                      <span className="chip chip-later">No dues yet</span>
                    ) : s.overdueKobo > 0 ? (
                      <span className="chip chip-overdue">
                        <IconAlert size={16} /> {formatNaira(s.overdueKobo)} overdue
                      </span>
                    ) : s.outstandingKobo === 0 ? (
                      <span className="chip chip-paid">
                        <IconCheckCircle size={16} /> All paid
                      </span>
                    ) : (
                      <span className="chip chip-later">Up to date</span>
                    )}
                    {s.openAttempts.length > 0 && (
                      <span className="chip chip-soon">
                        <IconClock size={16} /> Payment being checked
                      </span>
                    )}
                    {s.creditKobo > 0 && <span className="chip chip-soon">{formatNaira(s.creditKobo)} credit</span>}
                  </span>
                </span>
              </button>
              {isOpen && (
                <div className="member-detail">
                  {s.charges.length === 0 ? (
                    <p className="muted">No charges yet.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Charge</th>
                            <th scope="col">Due</th>
                            <th scope="col" className="num">Amount</th>
                            <th scope="col" className="num">Paid</th>
                            <th scope="col" className="num">Owes</th>
                            <th scope="col">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.charges.map((c) => (
                            <tr key={c.charge.id}>
                              <td data-label="Charge">{c.charge.title}</td>
                              <td data-label="Due">{formatDayYear(c.charge.dueDate)}</td>
                              <td data-label="Amount" className="num">{formatNaira(c.charge.amountKobo)}</td>
                              <td data-label="Paid" className="num">{formatNaira(c.paidKobo)}</td>
                              <td data-label="Owes" className="num strong">{formatNaira(c.outstandingKobo)}</td>
                              <td data-label="Status">
                                <StatusChip status={c.status} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {receipts.length > 0 && (
                    <div className="btn-row">
                      {receipts.map((r) => (
                        <button key={r.id} type="button" className="btn btn-ghost btn-small" onClick={() => onViewReceipt(r.id)}>
                          {r.number} · {formatNaira(r.amountKobo)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
