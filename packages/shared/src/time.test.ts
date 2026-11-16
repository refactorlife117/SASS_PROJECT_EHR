import { describe, expect, it } from 'vitest';
import { addDays, toDateKey, toTimeKey, weekdayOf, zonedTimeToUtc } from './time';

const NY = 'America/New_York';
const CHI = 'America/Chicago';

describe('zonedTimeToUtc', () => {
  it('converts winter (EST, UTC-5) and summer (EDT, UTC-4) times', () => {
    expect(zonedTimeToUtc('2026-01-15', '09:00', NY).toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-07-15', '09:00', NY).toISOString()).toBe(
      '2026-07-15T13:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-07-15', '09:00', CHI).toISOString()).toBe(
      '2026-07-15T14:00:00.000Z',
    );
  });

  it('handles the spring-forward day on both sides of the jump', () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT in New York.
    expect(zonedTimeToUtc('2026-03-08', '01:30', NY).toISOString()).toBe(
      '2026-03-08T06:30:00.000Z',
    );
    expect(zonedTimeToUtc('2026-03-08', '09:00', NY).toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
  });

  it('shifts a non-existent (skipped) time forward', () => {
    expect(zonedTimeToUtc('2026-03-08', '02:30', NY).toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('picks the earlier instant for a repeated (fall-back) time', () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST; 01:30 happens twice.
    expect(zonedTimeToUtc('2026-11-01', '01:30', NY).toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(zonedTimeToUtc('2026-11-01', '09:00', NY).toISOString()).toBe(
      '2026-11-01T14:00:00.000Z',
    );
  });

  it('round-trips with toDateKey/toTimeKey', () => {
    const instant = zonedTimeToUtc('2026-12-31', '23:45', CHI);
    expect(toDateKey(instant, CHI)).toBe('2026-12-31');
    expect(toTimeKey(instant, CHI)).toBe('23:45');
    expect(toDateKey(instant, 'UTC')).toBe('2027-01-01');
  });

  it('rejects malformed input', () => {
    expect(() => zonedTimeToUtc('2026-1-5', '09:00', NY)).toThrow();
    expect(() => zonedTimeToUtc('2026-01-05', '24:00', NY)).toThrow();
  });
});

describe('date keys', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('gives the weekday', () => {
    expect(weekdayOf('2026-11-16')).toBe(1); // Monday
    expect(weekdayOf('2026-11-22')).toBe(0); // Sunday
  });
});
