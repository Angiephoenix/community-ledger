import { useMemo, useState } from 'react';
import { formatNaira, sumKobo } from '../../domain/money';
import { formatDay, lagosHour } from '../../domain/time';
import { attemptChargesSettled, memberName, memberSummary, type ChargeView } from '../../domain/ledger';
import type { LedgerState, PaymentAttempt } from '../../domain/types';
import { actions } from '../../state/store';
import { EmptyState, StatusChip } from '../common/bits';
import { Sculpture } from '../common/Artwork';
import { IconAlert, IconArrow, IconCalendar, IconCheck, IconCheckCircle, IconClock, IconInfo } from '../common/Icons';
import { PaymentSheet } from './PaymentSheet';

function greeting(now: string) {
  const h = lagosHour(now);
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function MemberOverview({
  ledger,
  memberId,
  onViewReceipt,
  onGo,
}: {
  ledger: LedgerState;
  memberId: string;
  onViewReceipt: (id: string) => void;
  onGo: (page: string) => void;
}) {
  const summary = memberSummary(ledger, memberId);
  const unpaid = summary.charges.filter((c) => c.outstandingKobo > 0);
  const paid = summary.charges.filter((c) => c.outstandingKobo === 0);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(unpaid.filter((c) => c.status === 'overdue').map((c) => c.charge.id)),
  );
  const [attempt, setAttempt] = useState<PaymentAttempt | null>(null);

  // Drop any selection that has since been paid (e.g. from another view).
  const selected = useMemo(() => unpaid.filter((c) => picked.has(c.charge.id)), [unpaid, picked]);
  const selectedTotal = sumKobo(selected.map((c) => c.outstandingKobo));
  const allSelected = unpaid.length > 0 && selected.length === unpaid.length;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const name = memberName(ledger, memberId);
  const lastReceipt = [...ledger.receipts].reverse().find((r) => r.memberId === memberId);

  function pay() {
    const a = actions.startPayment(selected.map((c) => c.charge.id));
    if (a) setAttempt(a);
  }

  return (
    <div className="page member-home">
      <h1 className="greeting">
        {greeting(ledger.now)}, {name}
      </h1>

      <section className="hero" aria-labelledby="dues-heading">
        <div className="hero-text">
          <h2 id="dues-heading" className="hero-label">
            Your dues
          </h2>
          <p className="hero-amount">{formatNaira(summary.outstandingKobo)}</p>
          {summary.charges.length === 0 ? (
            <p className="hero-note">Nothing has been added to your account yet.</p>
          ) : summary.outstandingKobo === 0 ? (
            <p className="hero-note">
              <IconCheckCircle /> You’re all paid up.
            </p>
          ) : (
            <div className="hero-split">
              <div>
                <span className="hero-split-label">
                  <IconAlert size={18} /> Overdue
                </span>
                <span className="hero-split-value hero-overdue">{formatNaira(summary.overdueKobo)}</span>
              </div>
              <div>
                <span className="hero-split-label">
                  <IconCalendar size={18} /> Upcoming
                </span>
                <span className="hero-split-value">{formatNaira(summary.upcomingKobo)}</span>
              </div>
            </div>
          )}
          {unpaid.length > 0 ? (
            <a className="btn btn-light hero-choose" href="#choose">
              Choose what to pay <IconArrow />
            </a>
          ) : lastReceipt ? (
            <button type="button" className="btn btn-light" onClick={() => onViewReceipt(lastReceipt.id)}>
              View latest receipt <IconArrow />
            </button>
          ) : null}
        </div>
        <div className="hero-art">
          <Sculpture />
        </div>
        <aside className="next-due" aria-label="Next due">
          <span className="next-due-icon">
            <IconCalendar />
          </span>
          {summary.nextDue ? (
            <>
              <span className="next-due-label">Next due</span>
              <span className="next-due-date">{formatDay(summary.nextDue.date)}</span>
              <span className="next-due-amount">{formatNaira(summary.nextDue.amountKobo)}</span>
            </>
          ) : summary.overdueKobo > 0 ? (
            <>
              <span className="next-due-label">Next due</span>
              <span className="next-due-date next-due-small">Only overdue dues are left</span>
            </>
          ) : (
            <>
              <span className="next-due-label">Next due</span>
              <span className="next-due-date next-due-small">Nothing due</span>
            </>
          )}
        </aside>
      </section>

      {summary.pendingAttempts.map((a) =>
        attemptChargesSettled(ledger, a) ? (
          <p key={a.id} className="notice notice-info" role="status">
            <IconInfo /> The dues in an earlier payment of {formatNaira(a.amountKobo)} ({a.reference}) are now paid. That earlier payment is
            still unconfirmed. If it goes through, it will be kept as credit and an officer will review it.
          </p>
        ) : (
          <p key={a.id} className="notice notice-pending" role="status">
            <IconClock /> We’re checking a payment of {formatNaira(a.amountKobo)} ({a.reference}). Your balance won’t change until it’s
            confirmed.
          </p>
        ),
      )}
      {summary.creditKobo > 0 && (
        <p className="notice notice-info">
          <IconInfo /> {formatNaira(summary.creditKobo)} you paid is more than you owed. It’s kept as credit while an officer reviews
          it.
        </p>
      )}

      {summary.charges.length === 0 ? (
        <EmptyState title="No dues yet" icon={<IconCalendar size={28} />}>
          When the group adds dues or a levy for you, it will show up here with its due date.
        </EmptyState>
      ) : (
        <section id="choose" className="choose" aria-labelledby="choose-heading">
          <div className="section-head">
            <h2 id="choose-heading">{unpaid.length ? 'Choose what to pay' : 'Your dues this year'}</h2>
            {unpaid.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => setPicked(allSelected ? new Set() : new Set(unpaid.map((c) => c.charge.id)))}
              >
                {allSelected ? 'Clear selection' : 'Pay all outstanding'}
              </button>
            )}
          </div>

          {unpaid.length === 0 && (
            <EmptyState title="All paid" icon={<IconCheckCircle size={28} />}>
              Every charge on your account is paid. Your receipts are under Payments.
            </EmptyState>
          )}

          <ul className="charge-list">
            {unpaid.map((c) => (
              <ChargeRow key={c.charge.id} view={c} checked={picked.has(c.charge.id)} onToggle={() => toggle(c.charge.id)} />
            ))}
          </ul>

          {unpaid.length > 0 && (
            <div className="pay-bar">
              <button type="button" className="btn btn-primary btn-pay" disabled={selected.length === 0} onClick={pay}>
                {selected.length === 0 ? 'Choose dues to pay' : `Pay ${formatNaira(selectedTotal)}`}
                {selected.length > 0 && <IconArrow />}
              </button>
              <span className="fine">Demo · No real payments</span>
            </div>
          )}

          {paid.length > 0 && (
            <>
              <h3 className="subhead">Paid</h3>
              <ul className="charge-list charge-list-paid">
                {paid.map((c) => (
                  <ChargeRow key={c.charge.id} view={c} />
                ))}
              </ul>
              <button type="button" className="btn btn-ghost" onClick={() => onGo('payments')}>
                Payment history and receipts <IconArrow />
              </button>
            </>
          )}
        </section>
      )}

      {attempt && (
        <PaymentSheet
          key={attempt.id}
          ledger={ledger}
          attempt={attempt}
          onClose={() => setAttempt(null)}
          onViewReceipt={(id) => {
            setAttempt(null);
            onViewReceipt(id);
          }}
        />
      )}
    </div>
  );
}

function ChargeRow({ view, checked, onToggle }: { view: ChargeView; checked?: boolean; onToggle?: () => void }) {
  const { charge, outstandingKobo, paidKobo, status, hasPendingAttempt } = view;
  const partial = paidKobo > 0 && outstandingKobo > 0;
  const inputId = `pick-${charge.id}`;
  const body = (
    <>
      <span className="charge-main">
        <span className="charge-title">{charge.title}</span>
        <span className="charge-sub">
          {status === 'paid' ? `${formatNaira(charge.amountKobo)} paid` : `Due ${formatDay(charge.dueDate)}`}
          {partial && ` · ${formatNaira(paidKobo)} of ${formatNaira(charge.amountKobo)} paid`}
          {hasPendingAttempt && (status === 'paid' ? ' · An earlier payment is still unconfirmed' : ' · Payment being checked')}
        </span>
        {partial && (
          <span className="progress" aria-hidden="true">
            <span style={{ width: `${(paidKobo / charge.amountKobo) * 100}%` }} />
          </span>
        )}
      </span>
      <span className="charge-amount">{formatNaira(status === 'paid' ? charge.amountKobo : outstandingKobo)}</span>
      <span className="charge-status">
        <StatusChip status={status} />
      </span>
    </>
  );
  if (!onToggle) return <li className="charge-row charge-row-static">{body}</li>;
  return (
    <li className={`charge-row ${checked ? 'is-checked' : ''}`}>
      <input id={inputId} type="checkbox" className="visually-hidden-input" checked={checked} onChange={onToggle} />
      <label htmlFor={inputId} className="charge-label">
        <span className="checkbox" aria-hidden="true">
          {checked && <IconCheck size={18} strokeWidth={3} />}
        </span>
        {body}
      </label>
    </li>
  );
}
