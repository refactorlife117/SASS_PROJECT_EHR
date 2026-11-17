import {
  patientSearchQuerySchema,
  waitlistCreateSchema,
  waitlistListQuerySchema,
  waitlistUpdateSchema,
  type PatientSearchResponse,
  type WaitlistListResponse,
} from '@slotfill/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/client';
import type { Clock } from '../../lib/clock';
import { recordAudit } from '../audit/audit';
import { authOf, requireAuth } from '../auth/middleware';
import type { WaitlistService } from './service';

const idParam = z.object({ id: z.uuid() });

export function waitlistRoutes(deps: {
  db: Database;
  waitlist: WaitlistService;
  clock: Clock;
}): Router {
  // Per-route guards: mounted at the /api/v1 root (see apps/api/CLAUDE.md).
  const router = Router();
  const { db, waitlist } = deps;

  router.get('/waitlist', requireAuth, async (req, res) => {
    const { status } = waitlistListQuerySchema.parse(req.query);
    const auth = authOf(req);
    const response: WaitlistListResponse = await db.withTenant(auth.tenantId, async (tx) => {
      const entries = await waitlist.list(tx, status);
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'waitlist.list',
        entity: 'waitlist_entry',
        ip: req.ip,
      });
      return { entries };
    });
    res.json(response);
  });

  router.post('/waitlist', requireAuth, async (req, res) => {
    const body = waitlistCreateSchema.parse(req.body);
    const auth = authOf(req);
    const entry = await db.withTenant(auth.tenantId, async (tx) => {
      const created = await waitlist.create(tx, auth.tenantId, body);
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'waitlist.add',
        entity: 'waitlist_entry',
        entityId: created.id,
        ip: req.ip,
      });
      return created;
    });
    res.status(201).json(entry);
  });

  router.patch('/waitlist/:id', requireAuth, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = waitlistUpdateSchema.parse(req.body);
    const auth = authOf(req);
    const entry = await db.withTenant(auth.tenantId, async (tx) => {
      const updated = await waitlist.update(tx, id, body);
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'waitlist.update',
        entity: 'waitlist_entry',
        entityId: id,
        ip: req.ip,
      });
      return updated;
    });
    res.json(entry);
  });

  /** Soft remove (status = removed); entries are kept for history and metrics. */
  router.delete('/waitlist/:id', requireAuth, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const auth = authOf(req);
    await db.withTenant(auth.tenantId, async (tx) => {
      await waitlist.update(tx, id, { status: 'removed' });
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'waitlist.remove',
        entity: 'waitlist_entry',
        entityId: id,
        ip: req.ip,
      });
    });
    res.status(204).end();
  });

  /** Patient search for the "add to waitlist" form, with their upcoming appointments. */
  router.get('/patients', requireAuth, async (req, res) => {
    const { search } = patientSearchQuerySchema.parse(req.query);
    const auth = authOf(req);
    const terms = search.split(/\s+/).slice(0, 3);
    const response: PatientSearchResponse = await db.withTenant(auth.tenantId, async (tx) => {
      const patients = await tx.patient.findMany({
        where: {
          AND: terms.map((t) => ({
            OR: [
              { firstName: { contains: t, mode: 'insensitive' as const } },
              { lastName: { contains: t, mode: 'insensitive' as const } },
            ],
          })),
        },
        include: {
          appointments: {
            where: { startsAt: { gt: deps.clock.now() }, status: { in: ['booked', 'confirmed'] } },
            include: { provider: true, visitType: true },
            orderBy: { startsAt: 'asc' },
            take: 5,
          },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: 20,
      });
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'patient.search',
        entity: 'patient',
        ip: req.ip,
      });
      return {
        patients: patients.map((p) => ({
          id: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          mobileLast4: p.mobileE164 ? p.mobileE164.slice(-4) : null,
          upcomingAppointments: p.appointments.map((a) => ({
            id: a.id,
            startsAt: a.startsAt.toISOString(),
            providerId: a.providerId,
            providerName: a.provider.displayName,
            visitTypeId: a.visitTypeId,
            visitTypeName: a.visitType.name,
          })),
        })),
      };
    });
    res.json(response);
  });

  return router;
}
