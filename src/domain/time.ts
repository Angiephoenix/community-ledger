// Human-facing dates use Africa/Lagos. Nigeria stays on UTC+1 all year (no
// daylight saving), so a fixed offset gives exact day boundaries; formatting
// still goes through Intl with the named zone.
export const TIME_ZONE = 'Africa/Lagos';
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** A calendar date in Africa/Lagos, formatted YYYY-MM-DD. */
export type LocalDate = string;
/** A UTC instant as an ISO string. */
export type Instant = string;

function parseLocalDate(date: LocalDate): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isValidLocalDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Milliseconds for 00:00 Lagos time on the given date. */
export function startOfLagosDay(date: LocalDate): number {
  const [y, mo, d] = parseLocalDate(date);
  return Date.UTC(y, mo - 1, d) - LAGOS_OFFSET_MS;
}

/**
 * Deadline cutoff rule (demo): a charge due on a date can be paid until the end
 * of that day in Lagos. It becomes overdue at 00:00 Lagos on the next day.
 */
export function dueCutoff(dueDate: LocalDate): number {
  return startOfLagosDay(dueDate) + DAY_MS;
}

export function lagosInstant(date: LocalDate, hh = 0, mm = 0): Instant {
  return new Date(startOfLagosDay(date) + (hh * 60 + mm) * 60_000).toISOString();
}

export function lagosDateOf(instant: Instant | number): LocalDate {
  const ms = typeof instant === 'number' ? instant : Date.parse(instant);
  const d = new Date(ms + LAGOS_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return lagosDateOf(startOfLagosDay(date) + days * DAY_MS + 12 * 60 * 60 * 1000);
}

export function addMs(instant: Instant, ms: number): Instant {
  return new Date(Date.parse(instant) + ms).toISOString();
}

const dayMonth = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: 'numeric', month: 'long' });
const dayMonthYear = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: 'numeric', hour12: false });

// Dates without a time are pinned to midday Lagos so formatting never slips a day.
const middayOf = (date: LocalDate) => new Date(startOfLagosDay(date) + 12 * 60 * 60 * 1000);

export const formatDay = (date: LocalDate) => dayMonth.format(middayOf(date));
export const formatDayYear = (date: LocalDate) => dayMonthYear.format(middayOf(date));
export const formatDateTime = (instant: Instant) => `${dateTime.format(new Date(instant))} WAT`;
export const formatInstantDay = (instant: Instant) => dayMonthYear.format(new Date(instant));
export const lagosHour = (instant: Instant) => Number(hourFmt.format(new Date(instant)));
