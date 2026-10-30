import { useState } from 'react';
import { formatNaira } from '../../domain/money';
import { formatDateTime } from '../../domain/time';
import { memberName } from '../../domain/ledger';
import { collectionReport, openTasks } from '../../domain/reports';
import type { LedgerState, OutboxMessage } from '../../domain/types';
import { actions } from '../../state/store';
import { EmptyState, SimLabel } from '../common/bits';
import { IconArrow, IconBell, IconCheckCircle, IconLoop, IconMinus } from '../common/Icons';

export function OfficerOverview({ ledger, onGo }: { ledger: LedgerState; onGo: (page: string) => void }) {
  const rep = collectionReport(ledger);
  const tasks = openTasks(ledger);
  const recentJobs = [...ledger.jobRuns].reverse().slice(0, 4);

  return (
    <div className="page">
      <h1>Overview</h1>
      <section className="kpis" aria-label="Collection figures">
        <Kpi label="Received" value={formatNaira(rep.collectedKobo)} note={`${ledger.payments.length} payments`} tone="blue" />
        <Kpi label="Still to collect" value={formatNaira(rep.outstandingKobo)} note={`${formatNaira(rep.outstandingKobo - rep.overdueKobo)} not yet due`} />
        <Kpi label="Overdue" value={formatNaira(rep.overdueKobo)} note="Past the due date" tone="coral" />
        <button type="button" className="kpi kpi-btn" onClick={() => onGo('attention')}>
          <span className="kpi-label">Needs attention</span>
          <span className="kpi-value">{tasks.length}</span>
          <span className="kpi-note">
            Open items <IconArrow size={16} />
          </span>
        </button>
      </section>

      <section className="card" aria-labelledby="auto-h">
        <div className="section-head">
          <h2 id="auto-h">Automation</h2>
          <SimLabel>Run now · Demo</SimLabel>
        </div>
        <p className="muted">
          In the connected version these run on a schedule. Here you can run them yourself against the demo clock.
        </p>
        <div className="job-buttons">
          <button type="button" className="btn btn-primary" onClick={actions.runAssessment}>
            <IconLoop /> Run recurring dues
          </button>
          <button type="button" className="btn btn-secondary" onClick={actions.runReminders}>
            <IconBell /> Run reminders
          </button>
          <button type="button" className="btn btn-secondary" onClick={actions.deliverPreviews}>
            Prepare message previews
          </button>
        </div>
        <ul className="rows jobs">
          {recentJobs.map((j) => (
            <li key={j.id} className="row">
              <span className="row-main">
                <strong>{jobName(j.type)}</strong>
                <span className="muted">
                  {formatDateTime(j.ranAt)} · {j.summary}
                </span>
                {j.details.length > 0 && (
                  <details>
                    <summary>Details</summary>
                    <ul className="plain">
                      {j.details.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Outbox ledger={ledger} />
    </div>
  );
}

function jobName(type: string) {
  return (
    { assessment: 'Recurring dues', reminders: 'Reminders', 'reminder-delivery': 'Message previews (simulated delivery)', 'levy-publish': 'Levy published' } as Record<
      string,
      string
    >
  )[type];
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'blue' | 'coral' }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-note">{note}</span>
    </div>
  );
}

const statusLabel: Record<OutboxMessage['status'], string> = {
  scheduled: 'Waiting · not sent',
  previewed: 'Preview only · not sent',
  cancelled: 'Cancelled',
};

export function Outbox({ ledger }: { ledger: LedgerState }) {
  const [filter, setFilter] = useState<'all' | OutboxMessage['status']>('all');
  const msgs = [...ledger.outbox].reverse().filter((m) => filter === 'all' || m.status === filter);
  return (
    <section className="card" aria-labelledby="outbox-h">
      <div className="section-head">
        <h2 id="outbox-h">Message outbox</h2>
        <SimLabel>Preview only</SimLabel>
      </div>
      <p className="muted">No WhatsApp or email service is connected. These are previews of what would be sent.</p>
      <div className="seg" role="group" aria-label="Filter messages">
        {(['all', 'scheduled', 'previewed', 'cancelled'] as const).map((f) => (
          <button key={f} type="button" className={`seg-btn ${filter === f ? 'is-on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'scheduled' ? 'Waiting' : f === 'previewed' ? 'Previewed' : 'Cancelled'}
          </button>
        ))}
      </div>
      {msgs.length === 0 ? (
        <EmptyState title="No messages here" />
      ) : (
        <ul className="rows outbox">
          {msgs.map((m) => (
            <li key={m.id} className={`row msg msg-${m.status}`}>
              <span className={`state-dot ${m.status === 'cancelled' ? 'is-muted' : 'is-pending'}`}>
                {m.status === 'cancelled' ? <IconMinus size={18} /> : m.status === 'previewed' ? <IconCheckCircle size={18} /> : <IconBell size={18} />}
              </span>
              <span className="row-main">
                <strong>
                  {memberName(ledger, m.memberId)} · {m.channel === 'whatsapp' ? 'WhatsApp' : 'Email'} ·{' '}
                  {m.kind === 'new-charge' ? 'New charge' : m.kind === 'reminder-overdue' ? 'Overdue reminder' : 'Due soon reminder'}
                </strong>
                <span className="msg-body">“{m.body}”</span>
                <span className="muted">
                  {statusLabel[m.status]}
                  {m.statusReason && m.status === 'cancelled' ? `: ${m.statusReason}` : ''} · {formatDateTime(m.updatedAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
