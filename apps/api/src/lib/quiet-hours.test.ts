import { zonedTimeToUtc } from '@slotfill/shared';
import { describe, expect, it } from 'vitest';
import { nextSendableTime, quietHoursEndAt } from './quiet-hours';

const NY = 'America/New_York';
const overnight = { start: '21:00', end: '08:00', timezone: NY };
const at = (date: string, time: string) => zonedTimeToUtc(date, time, NY);

describe('quietHoursEndAt (overnight 21:00–08:00, New York)', () => {
  it('is null during the day', () => {
    expect(quietHoursEndAt(at('2026-11-17', '08:00'), overnight)).toBeNull();
    expect(quietHoursEndAt(at('2026-11-17', '20:59'), overnight)).toBeNull();
  });

  it('ends at 08:00 the next day when it is late evening', () => {
    expect(quietHoursEndAt(at('2026-11-17', '21:00'), overnight)).toEqual(
      at('2026-11-18', '08:00'),
    );
    expect(quietHoursEndAt(at('2026-11-17', '23:30'), overnight)).toEqual(
      at('2026-11-18', '08:00'),
    );
  });

  it('ends at 08:00 the same day in the early morning', () => {
    expect(quietHoursEndAt(at('2026-11-18', '06:15'), overnight)).toEqual(
      at('2026-11-18', '08:00'),
    );
  });
});

describe('same-day window and disabled quiet hours', () => {
  const lunch = { start: '12:00', end: '13:00', timezone: NY };
  it('handles a window that does not cross midnight', () => {
    expect(quietHoursEndAt(at('2026-11-17', '12:30'), lunch)).toEqual(at('2026-11-17', '13:00'));
    expect(quietHoursEndAt(at('2026-11-17', '13:00'), lunch)).toBeNull();
  });

  it('treats start === end as no quiet hours', () => {
    expect(
      quietHoursEndAt(at('2026-11-17', '23:00'), { start: '00:00', end: '00:00', timezone: NY }),
    ).toBeNull();
  });

  it('nextSendableTime returns the input outside quiet hours', () => {
    const noon = at('2026-11-17', '12:00');
    expect(nextSendableTime(noon, overnight)).toEqual(noon);
  });
});
