import { useState } from 'react';
import { formatNaira } from '../../domain/money';
import { memberSummary } from '../../domain/ledger';
import type { LedgerState, PaymentAttempt } from '../../domain/types';
import { actions } from '../../state/store';
import { Modal } from '../common/bits';
import { Sculpture } from '../common/Artwork';
import { IconAlert, IconArrow, IconCheck, IconClock, IconInfo } from '../common/Icons';

type Stage = 'review' | 'processing' | 'success' | 'pending' | 'failed' | 'held';

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function PaymentSheet({
  ledger,
  attempt: initialAttempt,
  onClose,
  onViewReceipt,
}: {
  ledger: LedgerState;
  attempt: PaymentAttempt;
  onClose: () => void;
  onViewReceipt: (receiptId: string) => void;
}) {
  const [attempt, setAttempt] = useState(initialAttempt);
  const [stage, setStage] = useState<Stage>('review');
  const [receiptId, setReceiptId] = useState<string | null>(null);

  const charges = attempt.chargeIds.map((id) => ledger.charges.find((c) => c.id === id)!).filter(Boolean);
  const receipt = receiptId ? ledger.receipts.find((r) => r.id === receiptId) : undefined;
  const remaining = memberSummary(ledger, attempt.memberId).outstandingKobo;

  function finish(outcome: 'success' | 'pending' | 'failed') {
    const result = actions.simulateOutcome(attempt.id, outcome);
    if (result === undefined) return setStage('review');
    if (result === 'pending') return setStage('pending');
    if (result.outcome === 'recorded') {
      setReceiptId(result.receipt!.id);
      setStage('success');
    } else if (result.outcome === 'attempt-failed') setStage('failed');
    else setStage('held');
  }

  function simulate(outcome: 'success' | 'pending' | 'failed') {
    setStage('processing');
    // A short, honest wait while the simulated provider "confirms". No success is shown before confirmation.
    window.setTimeout(() => finish(outcome), reducedMotion() ? 50 : 1100);
  }

  function retry() {
    const next = actions.startPayment(attempt.chargeIds);
    if (next) {
      setAttempt(next);
      setStage('review');
    }
  }

  const title =
    stage === 'success' ? 'Payment received' : stage === 'pending' ? 'Payment being checked' : stage === 'failed' ? 'Payment didn’t go through' : 'Pay your dues';

  return (
    <Modal open onClose={onClose} title={title} className="pay-sheet" hideTitle={stage === 'success'}>
      {stage === 'review' && (
        <div className="pay-body">
          <p className="pay-kicker">You’re paying</p>
          <p className="pay-amount">{formatNaira(attempt.amountKobo)}</p>
          <ul className="pay-lines">
            {charges.map((c) => (
              <li key={c.id}>
                <span>{c.title}</span>
              </li>
            ))}
          </ul>
          <p className="pay-ref">
            Payment reference <span className="mono">{attempt.reference}</span>
          </p>
          <div className="sim-box">
            <p className="sim-box-title">
              <IconInfo /> Simulated checkout
            </p>
            <p>No card details are collected here and no money moves. Choose how this demo payment ends.</p>
            <button type="button" className="btn btn-primary btn-block" onClick={() => simulate('success')} autoFocus>
              Simulate payment <IconArrow />
            </button>
            <div className="sim-alt">
              <button type="button" className="btn btn-ghost" onClick={() => simulate('pending')}>
                Simulate a pending payment
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => simulate('failed')}>
                Simulate a failed payment
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === 'processing' && (
        <div className="pay-body pay-processing" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <p className="pay-status-title">Waiting for the payment to be confirmed…</p>
          <p className="muted">The simulator is sending a confirmation to the processing step.</p>
        </div>
      )}

      {stage === 'success' && receipt && (
        <div className="pay-success" role="status" aria-live="polite">
          <div className="pay-success-art">
            <Sculpture compact className="pay-success-svg" />
            <span className="success-badge">
              <IconCheck size={44} strokeWidth={3} />
            </span>
          </div>
          <div className="pay-body pay-success-body">
            <h2 className="pay-success-title">Payment received</h2>
            <p className="pay-amount pay-amount-blue">{formatNaira(receipt.amountKobo)}</p>
            <p className="pay-for">{receipt.lines.map((l) => l.title).join(', ')}</p>
            {receipt.unappliedKobo > 0 && (
              <p className="notice notice-info">
                <IconInfo /> {formatNaira(receipt.unappliedKobo)} was more than you owed. It’s kept as credit and an officer will review it.
              </p>
            )}
            <div className="remaining-row">
              <span>Remaining dues</span>
              <strong>{formatNaira(remaining)}</strong>
            </div>
            <button type="button" className="btn btn-primary btn-block" onClick={() => onViewReceipt(receipt.id)}>
              View receipt
            </button>
            <p className="fine center">Simulated payment · No real money moved</p>
          </div>
        </div>
      )}

      {stage === 'pending' && (
        <div className="pay-body pay-state" role="status" aria-live="polite">
          <span className="state-icon state-icon-pending">
            <IconClock size={32} />
          </span>
          <p className="pay-status-title">We’re still checking this payment</p>
          <p>
            Nothing has been taken off your balance yet. Reminders for these dues pause for up to 48 hours while it’s checked, then
            resume if it’s still unconfirmed.
          </p>
          <button type="button" className="btn btn-primary btn-block" onClick={onClose}>
            Done
          </button>
        </div>
      )}

      {stage === 'failed' && (
        <div className="pay-body pay-state" role="status" aria-live="polite">
          <span className="state-icon state-icon-failed">
            <IconAlert size={32} />
          </span>
          <p className="pay-status-title">This payment didn’t go through</p>
          <p>Your balance hasn’t changed. You can try again.</p>
          <button type="button" className="btn btn-primary btn-block" onClick={retry}>
            Try again
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={onClose}>
            Close
          </button>
        </div>
      )}

      {stage === 'held' && (
        <div className="pay-body pay-state" role="status" aria-live="polite">
          <span className="state-icon state-icon-failed">
            <IconAlert size={32} />
          </span>
          <p className="pay-status-title">This payment needs checking</p>
          <p>Something about it didn’t match, so it wasn’t applied. An officer will look at it.</p>
          <button type="button" className="btn btn-primary btn-block" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </Modal>
  );
}
