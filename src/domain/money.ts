// Money is always stored as integer kobo (₦1 = 100 kobo). Never use
// floating-point values for amounts.
export type Kobo = number;

export const KOBO_PER_NAIRA = 100;

export function assertKobo(value: number, label = 'amount'): Kobo {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a whole number of kobo, got ${value}`);
  }
  return value;
}

export function naira(whole: number): Kobo {
  if (!Number.isSafeInteger(whole)) throw new Error('Naira input must be a whole number');
  return whole * KOBO_PER_NAIRA;
}

export function sumKobo(values: readonly Kobo[]): Kobo {
  let total = 0;
  for (const v of values) total += assertKobo(v);
  return total;
}

const nairaFormatter = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 });
const nairaFormatterWithKobo = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats kobo as "₦15,000" (or "₦15,000.50" when kobo are present). */
export function formatNaira(kobo: Kobo): string {
  assertKobo(kobo);
  const sign = kobo < 0 ? '−' : '';
  const abs = Math.abs(kobo);
  const whole = Math.trunc(abs / KOBO_PER_NAIRA);
  const rest = abs % KOBO_PER_NAIRA;
  const body =
    rest === 0
      ? nairaFormatter.format(whole)
      : nairaFormatterWithKobo.format(whole + rest / KOBO_PER_NAIRA);
  return `${sign}₦${body}`;
}

/** Parses a whole-naira form input such as "10,000" into kobo. Returns null if invalid. */
export function parseNairaInput(input: string): Kobo | null {
  const cleaned = input.replace(/[₦,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const whole = Number(cleaned);
  if (!Number.isSafeInteger(whole) || whole <= 0) return null;
  return naira(whole);
}
