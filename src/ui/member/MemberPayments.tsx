import { formatNaira } from '../../domain/money';
import { formatDateTime } from '../../domain/time';
import type { LedgerState } from '../../domain/types';
import { EmptyState } from '../common/bits';
import { IconAlert, IconCheckCircle, IconClock, IconReceipt } from '../common/Icons';

export function MemberPayments({
  ledger,
  memberId,
  onViewReceipt,
}: {
  ledger: LedgerState;
  memberId: string;
  onViewReceipt: (id: string) => void;
}) {
  const payments = ledger.payments.filter((p) => p.memberId === memberId).reverse();
  const attempts = ledger.attempts.filter((a) => a.memberId === memberId && a.status !== 'confirmed').reverse();

  return (
    <div className="page">
      <h1>Payments</h1>

      {attempts.length > 0 && (
        <section aria-labelledby="attempts-h" className="card">
          <h2 id="attempts-h">Not completed</h2>
          <p className="muted">These attempts haven’t changed your balance.</p>
          <ul className="rows">
            {attempts.map((a) => (
              <li key={a.id} className="row">
                <span className={`state-dot ${a.status === 'failed' ? 'is-failed' : 'is-pending'}`}>
                  {a.status === 'failed' ? <IconAlert size={18} /> : <IconClock size={18} />}
                </span>
                <span className="row-main">
                  <strong>{a.status === 'failed' ? 'Didn’t go through' : a.status === 'pending' ? 'Being checked' : 'Not finished'}</strong>
                  <span className="muted">
                    {a.reference} · {formatDateTime(a.createdAt)}
                  </span>
                </span>
                <span className="row-amount">{formatNaira(a.amountKobo)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="history-h" className="card">
        <h2 id="history-h">Payment history</h2>
        {payments.length === 0 ? (
          <EmptyState title="No payments yet" icon={<IconReceipt size={28} />}>
            When a payment is confirmed it appears here with its receipt.
          </EmptyState>
        ) : (
          <ul className="rows">
            {payments.map((p) => {
              const receipt = ledger.receipts.find((r) => r.paymentId === p.id);
              return (
                <li key={p.id} className="row">
                  <span className="state-dot is-good">
                    <IconCheckCircle size={18} />
                  </span>
                  <span className="row-main">
                    <strong>Payment received</strong>
                    <span className="muted">
                      {formatDateTime(p.confirmedAt)} · {p.source === 'opening-record' ? 'Opening record' : 'Simulated'}
                    </span>
                  </span>
                  <span className="row-amount">{formatNaira(p.amountKobo)}</span>
                  {receipt && (
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => onViewReceipt(receipt.id)}>
                      View receipt
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
