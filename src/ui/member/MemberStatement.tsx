import { useEffect, useState } from 'react';
import { formatNaira } from '../../domain/money';
import { formatDateTime, formatDayYear, formatInstantDay } from '../../domain/time';
import { memberName } from '../../domain/ledger';
import { memberStatement } from '../../domain/reports';
import type { LedgerState } from '../../domain/types';
import { brand } from '../../config/brand';
import { appMode } from '../../config/mode';
import { actions, notify, track } from '../../state/store';
import { EmptyState } from '../common/bits';
import { modeLabels } from '../../config/mode';
import { Logo } from '../common/Artwork';
import { IconCheckCircle, IconFlag, IconPrint, IconReceipt } from '../common/Icons';

const showDate = (d: string) => (d.includes('T') ? formatInstantDay(d) : formatDayYear(d));

export function MemberStatement({
  ledger,
  memberId,
  onViewReceipt,
}: {
  ledger: LedgerState;
  memberId: string;
  onViewReceipt: (id: string) => void;
}) {
  const st = memberStatement(ledger, memberId);
  const [reporting, setReporting] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    track('statement viewed', 'member', memberId);
  }, [memberId]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Statement</h1>
        <button type="button" className="btn btn-ghost no-print" onClick={() => window.print()}>
          <IconPrint /> Print or save as PDF
        </button>
      </div>

      <article className="card statement print-area" aria-labelledby="stmt-h">
        <header className="statement-head">
          <div className="brand-row">
            <Logo />
            <span>{brand.name}</span>
          </div>
          <div>
            <h2 id="stmt-h">{memberName(ledger, memberId)}</h2>
            <p className="muted">As of {formatDateTime(ledger.now)} · {modeLabels.recordsLabel}</p>
          </div>
        </header>

        <dl className="stat-row">
          <div>
            <dt>Charged</dt>
            <dd>{formatNaira(st.summary.assessedKobo)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>{formatNaira(st.summary.paidKobo)}</dd>
          </div>
          <div>
            <dt>Overdue</dt>
            <dd>{formatNaira(st.summary.overdueKobo)}</dd>
          </div>
          <div>
            <dt>Still to pay</dt>
            <dd className="strong">{formatNaira(st.summary.outstandingKobo)}</dd>
          </div>
        </dl>

        {st.lines.length === 0 ? (
          <EmptyState title="Nothing on your statement yet" icon={<IconReceipt size={28} />} />
        ) : (
          <div className="table-wrap">
            <table className="table stmt-table">
              <caption className="visually-hidden">Statement entries in date order</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Details</th>
                  <th scope="col" className="num">Charged</th>
                  <th scope="col" className="num">Paid</th>
                  <th scope="col" className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {st.lines.map((l, i) => (
                  <tr key={i}>
                    <td data-label="Date">{showDate(l.date)}</td>
                    <td data-label="Details">
                      {l.description}
                      {l.receiptId && (
                        <button type="button" className="link-btn no-print" onClick={() => onViewReceipt(l.receiptId!)}>
                          View receipt
                        </button>
                      )}
                    </td>
                    <td data-label="Charged" className="num">{l.chargedKobo ? formatNaira(l.chargedKobo) : '–'}</td>
                    <td data-label="Paid" className="num">{l.paidKobo ? formatNaira(l.paidKobo) : '–'}</td>
                    <td data-label="Balance" className="num strong">{formatNaira(l.balanceKobo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {st.credits.length > 0 && (
          <p className="notice notice-info">
            Credit held for review:{' '}
            {st.credits.map((c) => `${formatNaira(c.amountKobo)} (${c.providerRef})`).join(', ')}. It is not counted against your dues
            until an officer decides what to do with it.
          </p>
        )}

        <p className="fine">
          {st.agrees ? (
            <>
              <IconCheckCircle size={16} /> Closing balance matches your account total.
            </>
          ) : (
            'Closing balance does not match your account total. Please report this.'
          )}{' '}
          Payment confirmation is not the same as bank settlement. Times are in West Africa Time (Lagos).
        </p>
      </article>

      <section className="card no-print" aria-labelledby="problem-h">
        <h2 id="problem-h">Something look wrong?</h2>
        {!reporting ? (
          <button type="button" className="btn btn-ghost" onClick={() => setReporting(true)}>
            <IconFlag /> Report a problem
          </button>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await actions.reportDiscrepancy(message)) {
                setMessage('');
                setReporting(false);
                if (appMode === 'demo') notify('Thanks. An officer will look at it. (Demo: nobody is contacted.)', 'good');
              }
            }}
          >
            <label htmlFor="problem-text" className="field-label">
              What looks wrong?
            </label>
            <textarea id="problem-text" className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
            <div className="btn-row">
              <button type="submit" className="btn btn-primary">
                Send to officers
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setReporting(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
