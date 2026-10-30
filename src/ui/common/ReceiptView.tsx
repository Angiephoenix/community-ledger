import { useEffect } from 'react';
import { formatNaira } from '../../domain/money';
import { formatDateTime } from '../../domain/time';
import { memberName, memberSummary } from '../../domain/ledger';
import type { LedgerState } from '../../domain/types';
import { brand } from '../../config/brand';
import { track } from '../../state/store';
import { IconPrint } from './Icons';
import { Logo } from './Artwork';

export function ReceiptView({ ledger, receiptId, surface }: { ledger: LedgerState; receiptId: string; surface: 'member' | 'officer' }) {
  const receipt = ledger.receipts.find((r) => r.id === receiptId);
  const payment = ledger.payments.find((p) => p.id === receipt?.paymentId);

  useEffect(() => {
    if (receipt) track('receipt viewed', surface, receipt.memberId);
  }, [receipt?.id]);

  if (!receipt || !payment) return <p>This receipt could not be found.</p>;
  const remaining = memberSummary(ledger, receipt.memberId).outstandingKobo;

  return (
    <div className="receipt print-area">
      <div className="receipt-head">
        <div className="brand-row">
          <Logo />
          <span>{brand.name}</span>
        </div>
        <span className="sim-label">Simulated payment · Demo</span>
      </div>
      <p className="receipt-kicker">Receipt {receipt.number}</p>
      <p className="receipt-amount">{formatNaira(receipt.amountKobo)}</p>
      <dl className="receipt-meta">
        <div>
          <dt>Paid by</dt>
          <dd>{memberName(ledger, receipt.memberId)}</dd>
        </div>
        <div>
          <dt>Confirmed</dt>
          <dd>{formatDateTime(payment.confirmedAt)}</dd>
        </div>
        <div>
          <dt>Transaction</dt>
          <dd className="mono">{payment.providerRef}</dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>{payment.source === 'opening-record' ? 'Opening record (fictional)' : 'Payment simulator'}</dd>
        </div>
      </dl>
      <h3 className="receipt-sub">What this paid</h3>
      <ul className="receipt-lines">
        {receipt.lines.map((l) => (
          <li key={l.chargeId}>
            <span>{l.title}</span>
            <strong>{formatNaira(l.amountKobo)}</strong>
          </li>
        ))}
        {receipt.unappliedKobo > 0 && (
          <li className="receipt-credit">
            <span>Kept as credit, under review</span>
            <strong>{formatNaira(receipt.unappliedKobo)}</strong>
          </li>
        )}
      </ul>
      <div className="receipt-remaining">
        <span>Remaining dues now</span>
        <strong>{formatNaira(remaining)}</strong>
      </div>
      <p className="fine">
        This receipt confirms the payment was recorded in {brand.name}. It does not confirm the money has reached the group's bank
        account. In this demo no real money moved.
      </p>
      <button type="button" className="btn btn-ghost no-print" onClick={() => window.print()}>
        <IconPrint /> Print receipt
      </button>
    </div>
  );
}
