import { useEffect, useRef } from 'react';
import { formatNaira } from '../../domain/money';
import { formatDateTime, lagosInstant } from '../../domain/time';
import { memberName } from '../../domain/ledger';
import type { LedgerState } from '../../domain/types';
import { DEFAULT_CLOCK } from '../../domain/fixtures';
import { actions, useAnalyticsEvents, type ViewState } from '../../state/store';
import { IconClose } from '../common/Icons';

// Technical demo controls, kept apart from the product UI. The view switch is
// not sign-in and grants nothing: there is no authentication in milestone 1.
export function DemoDrawer({ ledger, view, open, onClose }: { ledger: LedgerState; view: ViewState; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const events = useAnalyticsEvents();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const openAttempts = ledger.attempts.filter((a) => a.status === 'pending' || a.status === 'started');
  const lastRecorded = [...ledger.inbound].reverse().find((e) => e.outcome === 'recorded');

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="drawer-h"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="drawer-inner">
          <div className="drawer-head">
            <div>
              <h2 id="drawer-h">Demo controls</h2>
              <p className="muted">For testing the demo only. Not part of the product.</p>
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close demo controls">
              <IconClose />
            </button>
          </div>

          <section className="drawer-sec">
            <h3>View as</h3>
            <p className="fine">This switch is not a sign-in and gives no real access. Accounts and permissions come in milestone 2.</p>
            <div className="seg seg-wrap" role="group" aria-label="View as">
              {ledger.members.map((m) => {
                const on = view.role === 'member' && view.memberId === m.id;
                return (
                  <button key={m.id} type="button" className={`seg-btn ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => actions.setView({ role: 'member', memberId: m.id })}>
                    {m.displayName}
                  </button>
                );
              })}
              <button type="button" className={`seg-btn ${view.role === 'officer' ? 'is-on' : ''}`} aria-pressed={view.role === 'officer'} onClick={() => actions.setView({ role: 'officer' })}>
                Officer
              </button>
            </div>
          </section>

          <section className="drawer-sec">
            <h3>Demo clock</h3>
            <p>
              <strong>{formatDateTime(ledger.now)}</strong>
              {ledger.now === DEFAULT_CLOCK && <span className="fine"> (default)</span>}
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn-secondary btn-small" onClick={() => actions.advanceClock(24)}>
                +1 day
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => actions.advanceClock(24 * 7)}>
                +1 week
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => actions.setClock(lagosInstant('2026-12-01', 10))}>
                1 Dec, 10:00
              </button>
              <button type="button" className="btn btn-ghost btn-small" onClick={actions.resetClock}>
                Back to 24 Nov
              </button>
            </div>
          </section>

          <section className="drawer-sec">
            <h3>Jobs</h3>
            <div className="btn-row">
              <button type="button" className="btn btn-secondary btn-small" onClick={actions.runAssessment}>
                Run recurring dues
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={actions.runReminders}>
                Run reminders
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={actions.deliverPreviews}>
                Simulate message delivery
              </button>
            </div>
          </section>

          <section className="drawer-sec">
            <h3>Payment events</h3>
            <p className="fine">The simulator stands in for a payment provider. It is not Paystack test mode or a real webhook.</p>
            <div className="btn-row">
              <button type="button" className="btn btn-secondary btn-small" onClick={actions.replayLastConfirmation} disabled={!lastRecorded}>
                Deliver last confirmation again
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={actions.simulateConcurrentPayments} disabled={view.role !== 'member'}>
                Two payments for one charge ({view.role === 'member' ? memberName(ledger, view.memberId) : 'pick a member'})
              </button>
            </div>
            {lastRecorded && (
              <p className="fine">
                Last confirmation: <span className="mono">{lastRecorded.providerRef}</span>
              </p>
            )}
            {openAttempts.length > 0 && (
              <ul className="rows">
                {openAttempts.map((a) => (
                  <li key={a.id} className="row drawer-attempt">
                    <span className="row-main">
                      <strong>
                        {memberName(ledger, a.memberId)} · {formatNaira(a.amountKobo)} · {a.status}
                      </strong>
                      <span className="fine">
                        {a.reference} · {a.verificationChecks} check{a.verificationChecks === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="btn-row">
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => actions.simulateOutcome(a.id, 'success')}>
                        Confirm
                      </button>
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => actions.checkPending(a.id)}>
                        Check (stays unconfirmed)
                      </button>
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => actions.simulateOutcome(a.id, 'failed')}>
                        Fail
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary>Event log ({ledger.inbound.length})</summary>
              <ul className="plain log">
                {[...ledger.inbound].reverse().map((e) => (
                  <li key={e.id}>
                    <span className="mono">{e.providerRef}</span> · {e.outcome} · {e.note}
                  </li>
                ))}
              </ul>
            </details>
          </section>

          <section className="drawer-sec">
            <h3>Analytics events</h3>
            <p className="fine">Stored in this browser only. Nothing is sent to PostHog or anywhere else.</p>
            {events.length === 0 ? (
              <p className="fine">No events yet in this session.</p>
            ) : (
              <ul className="plain log">
                {events.slice(0, 12).map((e) => (
                  <li key={e.id}>
                    <strong>{e.name}</strong>
                    <pre className="payload">{JSON.stringify({ distinct_id: e.distinctId, properties: e.properties }, null, 1)}</pre>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="drawer-sec">
            <h3>Reset</h3>
            <button
              type="button"
              className="btn btn-danger btn-small"
              onClick={() => {
                if (window.confirm('Reset the demo to the original fictional records?')) actions.resetDemo();
              }}
            >
              Reset demo
            </button>
          </section>
        </div>
      )}
    </dialog>
  );
}
