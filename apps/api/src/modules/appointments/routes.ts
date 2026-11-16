import {
  appointmentListQuerySchema,
  type AppointmentListResponse,
  type ProviderListResponse,
} from '@slotfill/shared';
import { Router } from 'express';
import type { Database } from '../../db/client';
import { recordAudit } from '../audit/audit';
import { authOf, requireAuth } from '../auth/middleware';

export function appointmentRoutes(db: Database): Router {
  // Guards are per-route: this router is mounted at the /api/v1 root, where a router-level guard
  // would also catch unrelated paths (turning 404s into 401s).
  const router = Router();

  router.get('/appointments', requireAuth, async (req, res) => {
    const query = appointmentListQuerySchema.parse(req.query);
    const auth = authOf(req);

    const response: AppointmentListResponse = await db.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.appointment.findMany({
        where: {
          startsAt: { gte: new Date(query.from), lt: new Date(query.to) },
          ...(query.providerId ? { providerId: query.providerId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          startsAt: true,
          durationMin: true,
          status: true,
          source: true,
          patient: { select: { id: true, firstName: true, lastName: true } },
          provider: { select: { id: true, displayName: true } },
          visitType: { select: { id: true, name: true } },
        },
      });
      // PHI list view.
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'appointment.list',
        entity: 'appointment',
        ip: req.ip,
      });
      return {
        appointments: rows.map((row) => ({ ...row, startsAt: row.startsAt.toISOString() })),
      };
    });

    res.json(response);
  });

  router.get('/providers', requireAuth, async (req, res) => {
    const auth = authOf(req);
    const providers = await db.withTenant(auth.tenantId, (tx) =>
      tx.provider.findMany({
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
      }),
    );
    const response: ProviderListResponse = { providers };
    res.json(response);
  });

  return router;
}
