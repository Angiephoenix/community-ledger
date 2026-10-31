import { useState } from 'react';
import { formatNaira, parseNairaInput } from '../../domain/money';
import { formatDay, formatDayYear } from '../../domain/time';
import { memberName, today } from '../../domain/ledger';
import { validateLevy } from '../../domain/assessment';
import type { LedgerState } from '../../domain/types';
import { actions } from '../../state/store';
import { SimLabel } from '../common/bits';
import { IconLoop } from '../common/Icons';

export function Dues({ ledger }: { ledger: LedgerState }) {
  return (
    <div className="page">
      <h1>Dues</h1>
      <section className="card" aria-labelledby="rules-h">
        <div className="section-head">
          <h2 id="rules-h">Recurring dues</h2>
          <button type="button" className="btn btn-primary btn-small" onClick={actions.runAssessment}>
            <IconLoop /> Run recurring dues now
          </button>
        </div>
        <p className="muted">
          Each period is charged once per eligible member. Running the job again never adds a second charge. Amounts are fictional
          until the group confirms its rules.
        </p>
        <ul className="rows">
          {ledger.rules.map((r) => {
            const charged = ledger.charges.filter((c) => c.source.type === 'rule' && c.source.ruleId === r.id);
            const periods = [...new Set(charged.map((c) => (c.source.type === 'rule' ? c.source.period : '')))];
            return (
              <li key={r.id} className="row">
                <span className="row-main">
                  <strong>{r.name}</strong>
                  <span className="muted">
                    {formatNaira(r.amountKobo)} · {r.frequency === 'annual' ? `Yearly, due ${formatDay(`2000-${r.dueDay}`)}` : `Monthly, due on day ${r.dueDay}`} · from{' '}
                    {r.firstPeriod}
                  </span>
                  <span className="muted">
                    {periods.length ? `Charged for ${periods.join(', ')} · ${charged.length} charge${charged.length === 1 ? '' : 's'}` : 'Not charged yet'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card" aria-labelledby="levies-h">
        <h2 id="levies-h">Special levies</h2>
        <ul className="rows">
          {ledger.levies.map((l) => (
            <li key={l.id} className="row">
              <span className="row-main">
                <strong>{l.name}</strong>
                <span className="muted">
                  {formatNaira(l.amountKobo)} · due {formatDayYear(l.dueDate)} · {l.targetMemberIds.map((id) => memberName(ledger, id)).join(', ')}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <LevyForm ledger={ledger} />
      </section>
    </div>
  );
}

function LevyForm({ ledger }: { ledger: LedgerState }) {
  const active = ledger.members.filter((m) => m.status === 'active');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [issueDate, setIssueDate] = useState(today(ledger));
  const [dueDate, setDueDate] = useState('');
  const [targets, setTargets] = useState<Set<string>>(() => new Set(active.map((m) => m.id)));
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [errors, setErrors] = useState<string[]>([]);

  const input = {
    name,
    amountKobo: parseNairaInput(amount) ?? 0,
    issueDate,
    dueDate,
    targetMemberIds: active.filter((m) => targets.has(m.id)).map((m) => m.id),
  };

  function review(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateLevy(ledger, input);
    setErrors(errs);
    if (!errs.length) setStep('review');
  }

  async function publish() {
    // Demo returns the levy; the connected system returns a promise of success.
    if (await actions.publishLevy(input)) {
      setName('');
      setAmount('');
      setDueDate('');
      setStep('edit');
    }
  }

  if (step === 'review') {
    return (
      <div className="levy-review" aria-live="polite">
        <h3>Check before publishing</h3>
        <p>
          <strong>{input.name}</strong> of <strong>{formatNaira(input.amountKobo)}</strong>, due {formatDayYear(input.dueDate)}, will be
          added for {input.targetMemberIds.length} member{input.targetMemberIds.length === 1 ? '' : 's'}:
        </p>
        <ul className="pill-list">
          {input.targetMemberIds.map((id) => (
            <li key={id}>{memberName(ledger, id)}</li>
          ))}
        </ul>
        <p className="muted">Each member gets a notice preview in the outbox. Nothing is sent.</p>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={publish}>
            Publish levy
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setStep('edit')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="levy-form" onSubmit={review} noValidate>
      <div className="section-head">
        <h3>New levy</h3>
        <SimLabel>Fictional data only</SimLabel>
      </div>
      {errors.length > 0 && (
        <ul className="form-errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="field-grid">
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hall repair levy" />
        </label>
        <label className="field">
          <span className="field-label">Amount (₦)</span>
          <input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5,000" />
        </label>
        <label className="field">
          <span className="field-label">Starts</span>
          <input className="input" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Due</span>
          <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
      </div>
      <fieldset className="field">
        <legend className="field-label">Who pays</legend>
        <div className="check-grid">
          {active.map((m) => (
            <label key={m.id} className="check">
              <input
                type="checkbox"
                checked={targets.has(m.id)}
                onChange={() =>
                  setTargets((prev) => {
                    const next = new Set(prev);
                    if (next.has(m.id)) next.delete(m.id);
                    else next.add(m.id);
                    return next;
                  })
                }
              />
              {m.displayName}
            </label>
          ))}
        </div>
      </fieldset>
      <button type="submit" className="btn btn-primary">
        Review levy
      </button>
    </form>
  );
}
