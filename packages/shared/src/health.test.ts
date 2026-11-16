import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health';

describe('healthResponseSchema', () => {
  it('accepts a well-formed health response', () => {
    const parsed = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'api',
      time: new Date().toISOString(),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-ok status', () => {
    const parsed = healthResponseSchema.safeParse({
      status: 'down',
      service: 'api',
      time: new Date().toISOString(),
    });
    expect(parsed.success).toBe(false);
  });
});
