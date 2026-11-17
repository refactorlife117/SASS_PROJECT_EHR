// EHR webhooks. DrChrono: GET verification (HMAC-SHA256 of `msg` with the secret token) and POST
// deliveries whose X-drchrono-signature header carries the secret token itself (per DrChrono docs).
// A delivery only triggers an incremental sync for the clinic(s) owning that doctor; the sync reads
// the authoritative data from the API, so webhook bodies are never trusted for content.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/client';
import type { JobQueue } from '../../jobs/queues';
import { AppError } from '../../lib/errors';

const deliverySchema = z.object({
  object: z.object({ doctor: z.union([z.number(), z.string()]).transform(String) }).loose(),
});

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function ehrWebhookRoutes(deps: {
  db: Database;
  jobs: JobQueue;
  drchronoSecret?: string | undefined;
}): Router {
  const router = Router();

  router.get('/ehr/drchrono', (req, res) => {
    const msg = z.object({ msg: z.string().min(1).max(500) }).safeParse(req.query);
    if (!deps.drchronoSecret || !msg.success) throw new AppError(404, 'not_found', 'Not found');
    res.json({
      secret_token: createHmac('sha256', deps.drchronoSecret).update(msg.data.msg).digest('hex'),
    });
  });

  router.post('/ehr/drchrono', async (req, res) => {
    const signature = req.get('x-drchrono-signature') ?? '';
    if (!deps.drchronoSecret || !sameSecret(signature, deps.drchronoSecret)) {
      throw new AppError(403, 'invalid_signature', 'Webhook signature check failed');
    }
    const event = req.get('x-drchrono-event') ?? '';
    if (!event.startsWith('APPOINTMENT_')) {
      res.status(200).json({ ok: true, outcome: 'ignored' }); // PING and other events
      return;
    }
    const delivery = deliverySchema.safeParse(req.body);
    if (!delivery.success) {
      res.status(200).json({ ok: true, outcome: 'ignored' });
      return;
    }
    // Pre-tenant lookup: which clinic(s) have this DrChrono doctor.
    const tenants = await deps.db.unscoped.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM ehr_tenants_by_provider('drchrono', ${delivery.data.object.doctor})`;
    for (const { tenant_id: tenantId } of tenants) {
      await deps.jobs.send(
        'ehr.sync',
        { tenantId, mode: 'incremental' },
        { singletonKey: tenantId },
      );
    }
    res
      .status(200)
      .json({ ok: true, outcome: tenants.length > 0 ? 'sync_queued' : 'unknown_doctor' });
  });

  return router;
}
