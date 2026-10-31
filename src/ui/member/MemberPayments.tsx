import { formatNaira } from '../../domain/money';
import { formatDateTime } from '../../domain/time';
import { modeLabels } from '../../config/mode';
import { attemptChargesSettled } from '../../domain/ledger';
import type { LedgerState, PaymentAttempt } from '../../domain/types';
import { EmptyState } from '../common/bits';
import { IconAlert, IconCheckCircle, IconClock, IconMinus, IconReceipt } from '../common/Icons';

function attemptLabel(status: PaymentAttempt['status']) {
  switch (status) {
    case 'pending':
      return 'Submitted · being checked';
    case 'failed':
      return 'Didn’t go through';
    case 'abandoned':
      return 'Checkout closed · nothing submitted';
    default:
      return 'Checkout opened · nothing submitted yet';
  }
}

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
          <h2 id="attempts-h">Other payment attempts</h2>
          <p className="muted">None of these changed your balance.</p>
          <ul className="rows">
            {attempts.map((a) => (
              <li key={a.id} className="row">
                <span className={`state-dot ${a.status === 'failed' ? 'is-failed' : a.status === 'pending' ? 'is-pending' : 'is-muted'}`}>
                  {a.status === 'failed' ? <IconAlert size={18} /> : a.status === 'pending' ? <IconClock size={18} /> : <IconMinus size={18} />}
                </span>
                <span className="row-main">
                  <strong>{attemptLabel(a.status)}</strong>
                  <span className="muted">
                    {a.reference} · {formatDateTime(a.createdAt)}
                    {a.status === 'pending' && attemptChargesSettled(ledger, a) && ' · Its dues have since been paid'}
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
                      {formatDateTime(p.confirmedAt)} · {p.source === 'opening-record' ? 'Opening record' : modeLabels.paymentKind}
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
