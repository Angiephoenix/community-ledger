import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../src/domain/fixtures';
import { pendingFor, readableDetail } from '../src/domain/ledger';
import type { LedgerState } from '../src/domain/types';

const withIds = (): LedgerState => {
  const s = buildFixtures();
  // Connected records use UUIDs for members; give two fixture members UUID-like ids.
  s.members[0].id = '00000000-0000-4000-8000-00000000000a';
  return s;
};

describe('readableDetail', () => {
  it('names members instead of showing their ids', () => {
    const s = withIds();
    const name = s.members[0].displayName;
    expect(readableDetail(s, 'Member 00000000-0000-4000-8000-00000000000a linked to a sign-in account')).toBe(`${name} linked to a sign-in account`);
    expect(readableDetail(s, 'Linked 00000000-0000-4000-8000-00000000000a')).toBe(`Linked ${name}`);
  });
  it('leaves unknown ids alone', () => {
    const s = withIds();
    expect(readableDetail(s, 'Member 11111111-0000-4000-8000-000000000000 linked')).toBe('Member 11111111-0000-4000-8000-000000000000 linked');
  });
  it('reads the stored pause interval as hours', () => {
    const s = withIds();
    expect(readableDetail(s, 'has not been confirmed after 48:00:00. Nothing was credited')).toBe('has not been confirmed after 48 hours. Nothing was credited');
    expect(readableDetail(s, 'after 1:00:00.')).toBe('after 1 hour.');
    expect(readableDetail(s, 'paid at 10:00:00')).toBe('paid at 10:00:00');
  });
});

describe('pendingFor', () => {
  it('splits submitted payments by the 48-hour pause', () => {
    const s = buildFixtures();
    const charge = s.charges[0];
    const base = { memberId: charge.memberId, amountKobo: charge.amountKobo, chargeIds: [charge.id], status: 'pending' as const };
    s.attempts = [
      { ...s.attempts[0], ...base, id: 'recent', reference: 'CL-RECENT', createdAt: new Date(Date.parse(s.now) - 47 * 3600_000).toISOString() },
      { ...s.attempts[0], ...base, id: 'old', reference: 'CL-OLD', createdAt: new Date(Date.parse(s.now) - 48 * 3600_000).toISOString() },
      { ...s.attempts[0], ...base, id: 'started', reference: 'CL-STARTED', status: 'started', createdAt: s.now },
    ];
    const r = pendingFor(s, [charge.id]);
    expect(r.checking.map((a) => a.id)).toEqual(['recent']);
    expect(r.unconfirmed.map((a) => a.id)).toEqual(['old']);
    expect(pendingFor(s, ['other']).checking).toHaveLength(0);
  });
});
