const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = 24 * 60 * 60 * 1000;

/** True for a real `YYYY-MM-DD` calendar date such as `2026-02-28`. */
export function isCalendarDate(value: string): boolean {
  if (!calendarDatePattern.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * True when a calendar date is after "today". Expense dates are local dates, so
 * one day past the UTC date is allowed for users in time zones ahead of UTC.
 */
export function isFutureCalendarDate(value: string, now: string): boolean {
  const latestAllowed = new Date(Date.parse(now) + dayMs)
    .toISOString()
    .slice(0, 10);
  return value > latestAllowed;
}
