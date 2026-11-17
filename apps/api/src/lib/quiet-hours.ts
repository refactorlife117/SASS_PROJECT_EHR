import { addDays, toDateKey, toTimeKey, zonedTimeToUtc } from '@slotfill/shared';

export interface QuietHours {
  /** Tenant-local "HH:MM". A window with start > end runs overnight (e.g. 21:00–08:00). */
  start: string;
  end: string;
  timezone: string;
}

/**
 * If `now` is inside the tenant's quiet hours, the instant they end; otherwise null.
 * start === end means "no quiet hours".
 */
export function quietHoursEndAt(now: Date, quiet: QuietHours): Date | null {
  const { start, end, timezone } = quiet;
  if (start === end) return null;
  const local = toTimeKey(now, timezone); // "HH:MM" compares correctly as a string
  const today = toDateKey(now, timezone);

  if (start > end) {
    // Overnight window.
    if (local >= start) return zonedTimeToUtc(addDays(today, 1), end, timezone);
    if (local < end) return zonedTimeToUtc(today, end, timezone);
    return null;
  }
  return local >= start && local < end ? zonedTimeToUtc(today, end, timezone) : null;
}

/** The earliest moment at or after `at` that is outside quiet hours. */
export function nextSendableTime(at: Date, quiet: QuietHours): Date {
  return quietHoursEndAt(at, quiet) ?? at;
}
