import { healthResponseSchema } from '@slotfill/shared';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp, createTestContext } from './helpers';

const ctx = await createTestContext();
const app = buildTestApp(ctx);

afterAll(() => ctx.close());

describe('GET /api/v1/health', () => {
  it('returns a valid ok health response', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(healthResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Route not found' } });
  });
});
