import { formatNaira } from './money';
import { addDays, isValidLocalDate, lagosDateOf, startOfLagosDay, type LocalDate } from './time';
import { audit, config, draft, nextId, memberName } from './ledger';
import { queueNotification } from './reminders';
import type { Charge, DuesRule, LedgerState, Levy, Member } from './types';

// Assessment turns a dues rule or levy into individual member charges.
// Each charge carries a unique key, so rerunning a job never duplicates one.

/** annual period 'YYYY' + 'MM-DD', monthly period 'YYYY-MM' + 'DD'. */
export function periodDates(rule: DuesRule, period: string): { issueDate: LocalDate; dueDate: LocalDate } {
  return { issueDate: `${period}-${rule.issueDay}`, dueDate: `${period}-${rule.dueDay}` };
}

function periodLabel(rule: DuesRule, period: string): string {
  if (rule.frequency === 'annual') return period;
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The current period and the next one, as period keys. */
function candidatePeriods(rule: DuesRule, today: LocalDate): string[] {
  const [y, m] = today.split('-').map(Number);
  if (rule.frequency === 'annual') return [String(y), String(y + 1)];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${y}-${String(m).padStart(2, '0')}`, next];
}

export function isEligible(member: Member, issueDate: LocalDate): boolean {
  return member.status === 'active' && member.joinedOn <= issueDate;
}

export function chargeKeyForRule(ruleId: string, period: string, memberId: string) {
  return `rule:${ruleId}:${period}:${memberId}`;
}

export function chargeKeyForLevy(levyId: string, memberId: string) {
  return `levy:${levyId}:${memberId}`;
}

function addChargeOnce(s: LedgerState, fields: Omit<Charge, 'id' | 'createdAt'>): Charge | null {
  if (s.charges.some((c) => c.key === fields.key)) return null;
  const charge: Charge = { ...fields, id: nextId(s, 'chg'), createdAt: s.now };
  s.charges.push(charge);
  return charge;
}

export interface AssessmentResult {
  state: LedgerState;
  created: Charge[];
  alreadyAssessed: number;
}

/**
 * Recurring dues job. For every rule it looks at the open period, plus the next
 * period if it opens within `assessAheadDays`, and assesses eligible members once.
 */
export function runRecurringAssessment(state: LedgerState): AssessmentResult {
  const s = draft(state);
  const today = lagosDateOf(s.now);
  const horizon = addDays(today, config.assessAheadDays);
  const created: Charge[] = [];
  let alreadyAssessed = 0;
  const details: string[] = [];

  for (const rule of s.rules) {
    for (const period of candidatePeriods(rule, today)) {
      if (period < rule.firstPeriod) continue;
      const { issueDate, dueDate } = periodDates(rule, period);
      if (!isValidLocalDate(issueDate) || !isValidLocalDate(dueDate) || dueDate < issueDate) {
        const key = `invalid-rule:${rule.id}:${period}`;
        if (!s.tasks.some((t) => t.key === key)) {
          s.tasks.push({
            id: nextId(s, 'task'),
            key,
            type: 'invalid-rule',
            refId: rule.id,
            title: `${rule.name}: dates need checking`,
            detail: `Issue ${issueDate}, due ${dueDate} for ${period}. No charges were created.`,
            createdAt: s.now,
            status: 'open',
          });
        }
        details.push(`${rule.name} ${period}: skipped, invalid dates sent to Needs attention`);
        continue;
      }
      if (issueDate > horizon) continue;
      const label = periodLabel(rule, period);
      let made = 0;
      let skipped = 0;
      const ineligible: string[] = [];
      for (const member of s.members) {
        if (!isEligible(member, issueDate)) {
          ineligible.push(member.displayName);
          continue;
        }
        const charge = addChargeOnce(s, {
          key: chargeKeyForRule(rule.id, period, member.id),
          memberId: member.id,
          source: { type: 'rule', ruleId: rule.id, period },
          title: `${rule.name} ${label}`,
          amountKobo: rule.amountKobo,
          issueDate,
          dueDate,
        });
        if (charge) {
          made += 1;
          created.push(charge);
        } else {
          skipped += 1;
        }
      }
      alreadyAssessed += skipped;
      details.push(
        `${rule.name} ${label}: ${made} new, ${skipped} already assessed` +
          (ineligible.length ? `, not eligible: ${ineligible.join(', ')}` : ''),
      );
    }
  }

  const summary = `${created.length} new charge${created.length === 1 ? '' : 's'}, ${alreadyAssessed} already assessed`;
  s.jobRuns.push({ id: nextId(s, 'job'), type: 'assessment', ranAt: s.now, summary, details });
  audit(s, 'system', 'Recurring dues job', summary);
  return { state: s, created, alreadyAssessed };
}

export interface LevyInput {
  name: string;
  amountKobo: number;
  issueDate: LocalDate;
  dueDate: LocalDate;
  targetMemberIds: string[];
}

export function validateLevy(state: LedgerState, input: LevyInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('Give the levy a name.');
  if (!Number.isSafeInteger(input.amountKobo) || input.amountKobo <= 0) errors.push('Enter an amount above ₦0.');
  if (!isValidLocalDate(input.issueDate)) errors.push('Choose a valid start date.');
  if (!isValidLocalDate(input.dueDate)) errors.push('Choose a valid due date.');
  else if (isValidLocalDate(input.issueDate) && input.dueDate < input.issueDate)
    errors.push('The due date must be on or after the start date.');
  if (input.targetMemberIds.length === 0) errors.push('Choose at least one member.');
  const unknown = input.targetMemberIds.filter((id) => !state.members.some((m) => m.id === id));
  if (unknown.length) errors.push('Some selected members no longer exist.');
  return errors;
}

/** Creates and publishes a levy: one charge per selected member, plus one notice preview each. */
export function publishLevy(state: LedgerState, input: LevyInput): { state: LedgerState; levy: Levy; created: Charge[] } {
  const errors = validateLevy(state, input);
  if (errors.length) throw new Error(errors.join(' '));
  const s = draft(state);
  const levy: Levy = {
    id: nextId(s, 'levy'),
    name: input.name.trim(),
    amountKobo: input.amountKobo,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    targetMemberIds: [...input.targetMemberIds],
    status: 'published',
    publishedAt: s.now,
  };
  s.levies.push(levy);
  const created = assessLevy(s, levy);
  return { state: s, levy, created };
}

/** Idempotent: re-assessing a published levy creates nothing new. Mutates `s`. */
export function assessLevy(s: LedgerState, levy: Levy): Charge[] {
  const created: Charge[] = [];
  for (const memberId of levy.targetMemberIds) {
    const charge = addChargeOnce(s, {
      key: chargeKeyForLevy(levy.id, memberId),
      memberId,
      source: { type: 'levy', levyId: levy.id },
      title: levy.name,
      amountKobo: levy.amountKobo,
      issueDate: levy.issueDate,
      dueDate: levy.dueDate,
    });
    if (charge) {
      created.push(charge);
      queueNotification(s, charge, 'new-charge');
    }
  }
  const summary = `${levy.name}: ${created.length} new charge${created.length === 1 ? '' : 's'} of ${formatNaira(levy.amountKobo)}`;
  s.jobRuns.push({
    id: nextId(s, 'job'),
    type: 'levy-publish',
    ranAt: s.now,
    summary,
    details: levy.targetMemberIds.map((id) => memberName(s, id)),
  });
  audit(s, 'officer (demo)', 'Levy published', summary);
  return created;
}

/** Charges are dated by Lagos calendar day; a helper for fixture timestamps. */
export const issueMoment = (date: LocalDate) => new Date(startOfLagosDay(date) + 9 * 3600_000).toISOString();
