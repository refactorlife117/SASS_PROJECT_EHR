import {
  messageListQuerySchema,
  type MessageDto,
  type MessageListResponse,
} from '@slotfill/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Database, Tx } from '../../db/client';
import type { Message } from '../../generated/prisma/client';
import { recordAudit } from '../audit/audit';
import { authOf, requireAuth } from '../auth/middleware';

const idParam = z.object({ id: z.uuid() });

/** Attach the patient(s) behind each number. Several patients may share one mobile. */
async function toDtos(tx: Tx, messages: Message[]): Promise<MessageDto[]> {
  const mobiles = [...new Set(messages.map((m) => m.mobileE164))];
  const patients = await tx.patient.findMany({
    where: { mobileE164: { in: mobiles } },
    select: { id: true, firstName: true, lastName: true, mobileE164: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  const byMobile = new Map<string, MessageDto['patients']>();
  for (const { mobileE164, ...patient } of patients) {
    if (mobileE164) byMobile.set(mobileE164, [...(byMobile.get(mobileE164) ?? []), patient]);
  }
  return messages.map((m) => ({
    id: m.id,
    direction: m.direction,
    mobileE164: m.mobileE164,
    body: m.body,
    contextType: m.contextType,
    contextId: m.contextId,
    status: m.status,
    needsAttention: m.needsAttention,
    failureReason: m.failureReason,
    createdAt: m.createdAt.toISOString(),
    patients: byMobile.get(m.mobileE164) ?? [],
  }));
}

export function messageRoutes(db: Database): Router {
  // Per-route guards: mounted at the /api/v1 root (see apps/api/CLAUDE.md).
  const router = Router();

  router.get('/messages', requireAuth, async (req, res) => {
    const query = messageListQuerySchema.parse(req.query);
    const auth = authOf(req);
    const response: MessageListResponse = await db.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.message.findMany({
        where: {
          ...(query.mobile ? { mobileE164: query.mobile } : {}),
          ...(query.context ? { contextType: query.context } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
      });
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'message.list',
        entity: 'message',
        ip: req.ip,
      });
      return { messages: await toDtos(tx, rows) };
    });
    res.json(response);
  });

  router.get('/messages/needs-attention', requireAuth, async (req, res) => {
    const auth = authOf(req);
    const response: MessageListResponse = await db.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.message.findMany({
        where: { needsAttention: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
      });
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'message.list_needs_attention',
        entity: 'message',
        ip: req.ip,
      });
      return { messages: await toDtos(tx, rows) };
    });
    res.json(response);
  });

  router.post('/messages/:id/resolve', requireAuth, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const auth = authOf(req);
    await db.withTenant(auth.tenantId, async (tx) => {
      await tx.message.update({ where: { id }, data: { needsAttention: false } });
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'message.resolve',
        entity: 'message',
        entityId: id,
        ip: req.ip,
      });
    });
    res.status(204).end();
  });

  return router;
}
