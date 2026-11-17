/** Injected wherever "now" matters (reminders, quiet hours, offers) so tests can control time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
