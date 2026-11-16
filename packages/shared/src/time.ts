// Time-zone helpers built on Intl (no dependencies). Instants are UTC `Date`s; tenant-local
// wall-clock values are plain strings: date keys "YYYY-MM-DD" and times "HH:MM".

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock parts of an instant in a time zone. */
export function toZonedParts(instant: Date, timeZone: string): ZonedParts & { second: number } {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
}

/** Offset of the zone from UTC at an instant, in milliseconds (e.g. New York in winter = -5h). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = toZonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (instant.getTime() - instant.getMilliseconds());
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The UTC instant of a tenant-local wall-clock time. For a time skipped by a DST jump the result
 * is shifted forward by the jump; for a repeated time the earlier instant is returned.
 */
export function zonedTimeToUtc(dateKey: string, time: string, timeZone: string): Date {
  const d = DATE_KEY.exec(dateKey);
  const t = TIME.exec(time);
  if (!d || !t) throw new Error(`Invalid local date/time: ${dateKey} ${time}`);
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const wallAsUtc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hour, minute);

  // The zone's offsets well before and after this wall time cover any single DST transition.
  const HALF_DAY = 12 * 3_600_000;
  const offsetBefore = zoneOffsetMs(new Date(wallAsUtc - HALF_DAY), timeZone);
  const offsetAfter = zoneOffsetMs(new Date(wallAsUtc + HALF_DAY), timeZone);

  const valid = [wallAsUtc - offsetBefore, wallAsUtc - offsetAfter].filter((candidate) => {
    const p = toZonedParts(new Date(candidate), timeZone);
    return p.hour === hour && p.minute === minute;
  });
  // Repeated time (fall back): the earlier instant. Skipped time (spring forward): applying the
  // pre-jump offset lands just after the jump, i.e. the time shifted forward.
  return new Date(valid.length > 0 ? Math.min(...valid) : wallAsUtc - offsetBefore);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of an instant in a time zone. */
export function toDateKey(instant: Date, timeZone: string): string {
  const p = toZonedParts(instant, timeZone);
  return `${String(p.year)}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:MM" (24 h) of an instant in a time zone. */
export function toTimeKey(instant: Date, timeZone: string): string {
  const p = toZonedParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Calendar arithmetic on a date key (no time zone involved). */
export function addDays(dateKey: string, days: number): string {
  const d = DATE_KEY.exec(dateKey);
  if (!d) throw new Error(`Invalid date key: ${dateKey}`);
  const date = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + days));
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 0 = Sunday ... 6 = Saturday, for a date key. */
export function weekdayOf(dateKey: string): number {
  const d = DATE_KEY.exec(dateKey);
  if (!d) throw new Error(`Invalid date key: ${dateKey}`);
  return new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))).getUTCDay();
}

/** Human formatting in a tenant's zone, e.g. "Tue, Nov 17" / "9:30 AM". */
export function formatDateInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(instant);
}

export function formatTimeInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    instant,
  );
}
