import { formatNaira } from '../../domain/money';
import { formatDateTime } from '../../domain/time';
import { memberName, readableDetail } from '../../domain/ledger';
import { modeLabels } from '../../config/mode';
import { collectionReport } from '../../domain/reports';
import type { LedgerState } from '../../domain/types';
import { brand } from '../../config/brand';
import { IconAlert, IconCheckCircle, IconPrint } from '../common/Icons';

export function Reports({ ledger, serverChecks }: { ledger: LedgerState; serverChecks?: { label: string; ok: boolean }[] }) {
  const rep = collectionReport(ledger);
  return (
    <div className="page">
      <div className="page-head">
        <h1>Reports</h1>
        <button type="button" className="btn btn-ghost no-print" onClick={() => window.print()}>
          <IconPrint /> Print or save as PDF
        </button>
      </div>

      <article className="card print-area" aria-labelledby="rep-h">
        <h2 id="rep-h">Collection report</h2>
        <p className="muted">
          {brand.groupName} · As of {formatDateTime(rep.asOf)} · {modeLabels.recordsLabel}
        </p>
        <dl className="stat-row">
          <div>
            <dt>Charged</dt>
            <dd>{formatNaira(rep.assessedKobo)}</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>{formatNaira(rep.collectedKobo)}</dd>
          </div>
          <div>
            <dt>Applied to dues</dt>
            <dd>{formatNaira(rep.allocatedKobo)}</dd>
          </div>
          <div>
            <dt>Credit to review</dt>
            <dd>{formatNaira(rep.unappliedKobo)}</dd>
          </div>
          <div>
            <dt>Still to collect</dt>
            <dd className="strong">{formatNaira(rep.outstandingKobo)}</dd>
          </div>
          <div>
            <dt>Overdue</dt>
            <dd>{formatNaira(rep.overdueKobo)}</dd>
          </div>
        </dl>

        <h3>By charge</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Charge</th>
                <th scope="col" className="num">Members</th>
                <th scope="col" className="num">Charged</th>
                <th scope="col" className="num">Paid</th>
                <th scope="col" className="num">Still owed</th>
                <th scope="col" className="num">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {rep.groups.map((g) => (
                <tr key={g.title}>
                  <td data-label="Charge">{g.title}</td>
                  <td data-label="Members" className="num">{g.members}</td>
                  <td data-label="Charged" className="num">{formatNaira(g.assessedKobo)}</td>
                  <td data-label="Paid" className="num">{formatNaira(g.allocatedKobo)}</td>
                  <td data-label="Still owed" className="num strong">{formatNaira(g.outstandingKobo)}</td>
                  <td data-label="Overdue" className="num">{formatNaira(g.overdueKobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>By member</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col" className="num">Charged</th>
                <th scope="col" className="num">Paid</th>
                <th scope="col" className="num">Still owed</th>
                <th scope="col" className="num">Overdue</th>
                <th scope="col" className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rep.members.map((m) => (
                <tr key={m.memberId}>
                  <td data-label="Member">{memberName(ledger, m.memberId)}</td>
                  <td data-label="Charged" className="num">{formatNaira(m.assessedKobo)}</td>
                  <td data-label="Paid" className="num">{formatNaira(m.paidKobo)}</td>
                  <td data-label="Still owed" className="num strong">{formatNaira(m.outstandingKobo)}</td>
                  <td data-label="Overdue" className="num">{formatNaira(m.overdueKobo)}</td>
                  <td data-label="Credit" className="num">{formatNaira(m.creditKobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>Checks</h3>
        <ul className="checks">
          {rep.checks.map((c) => (
            <li key={c.label} className={c.ok ? 'ok' : 'bad'}>
              {c.ok ? <IconCheckCircle size={18} /> : <IconAlert size={18} />} {c.ok ? 'Agrees' : 'Does not agree'}: {c.label}
            </li>
          ))}
        </ul>
        {serverChecks && (
          <>
            <h3>Database checks</h3>
            <ul className="checks">
              {serverChecks.map((c) => (
                <li key={c.label} className={c.ok ? 'ok' : 'bad'}>
                  {c.ok ? <IconCheckCircle size={18} /> : <IconAlert size={18} />} {c.ok ? 'Agrees' : 'Does not agree'}: {c.label}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="fine">
          {rep.pendingAttempts} unconfirmed payment attempt{rep.pendingAttempts === 1 ? '' : 's'} ({formatNaira(rep.pendingAttemptsKobo)}){' '}
          {rep.pendingAttempts === 1 ? 'is' : 'are'} not counted as received. Bank settlement and provider fees are not tracked in {modeLabels.trackingScope}, so this report is not a bank
          reconciliation.
        </p>
      </article>

      <section className="card no-print" aria-labelledby="audit-h">
        <h2 id="audit-h">Activity record</h2>
        <p className="muted">Every change to financial records is logged here. Nothing is edited or deleted silently.</p>
        <ul className="rows audit">
          {[...ledger.audit].reverse().slice(0, 40).map((a) => (
            <li key={a.id} className="row">
              <span className="row-main">
                <strong>{a.action}</strong>
                <span className="muted">
                  {formatDateTime(a.at)} · {a.actor} · {readableDetail(ledger, a.detail)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
