// DEV ONLY. Backend for the /dev/phone simulator. Mounted only when devRoutes is enabled.
// Replies go through exactly the same inbound pipeline as real provider webhooks.
import {
  devSmsInboundRequestSchema,
  devSmsSendTestRequestSchema,
  type DevSmsConversations,
} from '@slotfill/shared';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Database } from '../../db/client';
import { AppError } from '../../lib/errors';
import { authOf, requireAuth } from '../auth/middleware';
import type { MessagingService } from '../messaging/service';
import { templates } from '../messaging/templates';

export function devSmsRoutes(deps: { db: Database; messaging: MessagingService }): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/conversations', async (req, res) => {
    const { tenantId } = authOf(req);
    const response: DevSmsConversations = await deps.db.withTenant(tenantId, async (tx) => {
      const [tenant, messages, patients, optedOut] = await Promise.all([
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
        tx.message.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2000 }),
        tx.patient.findMany({
          where: { mobileE164: { not: null } },
          select: { firstName: true, lastName: true, mobileE164: true },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        }),
        tx.smsConsent.findMany({ where: { status: 'opted_out' }, select: { mobileE164: true } }),
      ]);

      const phones = new Map<string, DevSmsConversations['phones'][number]>();
      const phone = (mobileE164: string) => {
        let entry = phones.get(mobileE164);
        if (!entry) {
          entry = { mobileE164, patientNames: [], optedOut: false, messages: [] };
          phones.set(mobileE164, entry);
        }
        return entry;
      };
      for (const m of messages) {
        phone(m.mobileE164).messages.push({
          id: m.id,
          direction: m.direction,
          body: m.body,
          status: m.status,
          createdAt: m.createdAt.toISOString(),
        });
      }
      for (const p of patients)
        if (p.mobileE164) phone(p.mobileE164).patientNames.push(`${p.firstName} ${p.lastName}`);
      for (const c of optedOut) phone(c.mobileE164).optedOut = true;

      const lastActivity = (e: { messages: { createdAt: string }[] }) =>
        e.messages.at(-1)?.createdAt ?? '';
      return {
        clinicNumber: tenant.smsNumber,
        phones: [...phones.values()].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a))),
      };
    });
    res.json(response);
  });

  /** A simulated patient reply to the signed-in clinic's number. */
  router.post('/inbound', async (req, res) => {
    const body = devSmsInboundRequestSchema.parse(req.body);
    const { tenantId } = authOf(req);
    const tenant = await deps.db.withTenant(tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    );
    if (!tenant.smsNumber)
      throw new AppError(409, 'no_sms_number', 'This clinic has no SMS number');
    const outcome = await deps.messaging.handleInbound(
      {
        providerMessageId: `dev-in-${randomUUID()}`,
        from: body.from,
        to: tenant.smsNumber,
        body: body.body,
      },
      'dev',
    );
    res.json({ outcome });
  });

  /** Send a harmless test text to a number (to see Mailpit + the simulator working). */
  router.post('/send-test', async (req, res) => {
    const { to } = devSmsSendTestRequestSchema.parse(req.body);
    const { tenantId } = authOf(req);
    await deps.db.withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      await deps.messaging.queueSms(tx, {
        tenantId,
        to,
        body: templates.devTest(tenant.name),
        context: { type: 'system' },
      });
    });
    res.status(202).end();
  });

  return router;
}
