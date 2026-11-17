import {
  offerListQuerySchema,
  type OfferDetail,
  type OfferListResponse,
  type OfferSummary,
} from '@slotfill/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/client';
import type { Prisma } from '../../generated/prisma/client';
import { AppError } from '../../lib/errors';
import { recordAudit } from '../audit/audit';
import { authOf, requireAuth } from '../auth/middleware';
import type { OfferService } from './service';

const idParam = z.object({ id: z.uuid() });

const summaryInclude = {
  provider: true,
  visitType: true,
  filledByPatient: true,
  _count: { select: { recipients: true } },
} satisfies Prisma.SlotOfferInclude;
type SummaryRow = Prisma.SlotOfferGetPayload<{ include: typeof summaryInclude }>;

function toSummary(o: SummaryRow): OfferSummary {
  return {
    id: o.id,
    status: o.status,
    cancelReason: o.cancelReason,
    startsAt: o.startsAt.toISOString(),
    durationMin: o.durationMin,
    expiresAt: o.expiresAt.toISOString(),
    createdAt: o.createdAt.toISOString(),
    filledAt: o.filledAt?.toISOString() ?? null,
    provider: { id: o.provider.id, displayName: o.provider.displayName },
    visitType: { id: o.visitType.id, name: o.visitType.name },
    recipientCount: o._count.recipients,
    filledBy: o.filledByPatient
      ? {
          id: o.filledByPatient.id,
          firstName: o.filledByPatient.firstName,
          lastName: o.filledByPatient.lastName,
        }
      : null,
  };
}

export function offerRoutes(deps: { db: Database; offers: OfferService }): Router {
  // Per-route guards: mounted at the /api/v1 root (see apps/api/CLAUDE.md).
  const router = Router();
  const { db } = deps;

  router.get('/offers', requireAuth, async (req, res) => {
    const query = offerListQuerySchema.parse(req.query);
    const auth = authOf(req);
    const response: OfferListResponse = await db.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.slotOffer.findMany({
        where: query.status ? { status: query.status } : {},
        include: summaryInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
      });
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'offer.list',
        entity: 'slot_offer',
        ip: req.ip,
      });
      return { offers: rows.map(toSummary) };
    });
    res.json(response);
  });

  router.get('/offers/:id', requireAuth, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const auth = authOf(req);
    const response: OfferDetail = await db.withTenant(auth.tenantId, async (tx) => {
      const offer = await tx.slotOffer.findUnique({
        where: { id },
        include: {
          ...summaryInclude,
          recipients: {
            include: { patient: true },
            orderBy: [{ batchNo: 'asc' }, { createdAt: 'asc' }],
          },
        },
      });
      if (!offer) throw new AppError(404, 'not_found', 'Not found');
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'offer.view',
        entity: 'slot_offer',
        entityId: id,
        ip: req.ip,
      });
      return {
        ...toSummary(offer),
        recipients: offer.recipients.map((r) => ({
          id: r.id,
          batchNo: r.batchNo,
          sentAt: r.sentAt?.toISOString() ?? null,
          reply: r.reply,
          repliedAt: r.repliedAt?.toISOString() ?? null,
          outcome: r.outcome,
          patient: {
            id: r.patient.id,
            firstName: r.patient.firstName,
            lastName: r.patient.lastName,
          },
        })),
      };
    });
    res.json(response);
  });

  router.post('/offers/:id/cancel', requireAuth, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const auth = authOf(req);
    const cancelled = await deps.offers.cancelByStaff(auth.tenantId, id, auth.userId);
    if (!cancelled) throw new AppError(409, 'not_open', 'Only open offers can be cancelled');
    res.status(204).end();
  });

  return router;
}
