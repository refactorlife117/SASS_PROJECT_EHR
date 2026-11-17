// DEV ONLY. Controls for the mock EHR behind /dev/ehr. Mounted only when devRoutes is enabled
// (NODE_ENV=development). Every change "notifies" SlotFill the way a real EHR webhook would: by
// enqueueing an incremental ehr.sync for the tenant.
import {
  addDays,
  devEhrCreateAppointmentSchema,
  devEhrMoveAppointmentSchema,
  toDateKey,
  zonedTimeToUtc,
  type DevEhrState,
} from '@slotfill/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/client';
import type { JobQueue } from '../../jobs/queues';
import { AppError } from '../../lib/errors';
import { MockEhr } from '../../providers/ehr/mock';
import { EhrSlotUnavailableError } from '../../providers/ehr/types';
import { authOf, requireAuth } from '../auth/middleware';
import type { ReminderService } from '../reminders/service';

const SNAPSHOT_DAYS = 14;
const idParam = z.object({ id: z.uuid() });

export function devEhrRoutes(deps: {
  db: Database;
  jobs: JobQueue;
  reminders: ReminderService;
}): Router {
  const router = Router();
  router.use(requireAuth);

  const tenantContext = async (tenantId: string) =>
    deps.db.withTenant(tenantId, async (tx) => ({
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      connection: await tx.ehrConnection.findUnique({ where: { tenantId } }),
    }));

  const notifySlotFill = (tenantId: string) =>
    deps.jobs.send('ehr.sync', { tenantId, mode: 'incremental' }, { singletonKey: tenantId });

  const slotErrors = (err: unknown): never => {
    if (err instanceof EhrSlotUnavailableError) {
      throw new AppError(409, 'slot_unavailable', 'That time overlaps another appointment');
    }
    throw err;
  };

  router.get('/state', async (req, res) => {
    const { tenantId } = authOf(req);
    const { tenant, connection } = await tenantContext(tenantId);
    const today = toDateKey(new Date(), tenant.timezone);
    const snapshot = await new MockEhr(deps.db, tenantId).snapshot({
      from: zonedTimeToUtc(today, '00:00', tenant.timezone),
      to: zonedTimeToUtc(addDays(today, SNAPSHOT_DAYS), '00:00', tenant.timezone),
    });
    const patientNames = new Map(
      snapshot.patients.map((p) => [p.id, `${p.firstName} ${p.lastName}`]),
    );

    const response: DevEhrState = {
      timezone: tenant.timezone,
      connection: connection && {
        status: connection.status,
        lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
        lastError: connection.lastError,
      },
      providers: snapshot.providers.map((p) => ({ id: p.id, displayName: p.displayName })),
      visitTypes: snapshot.visitTypes.map((v) => ({
        code: v.code,
        name: v.name,
        durationMin: v.durationMin,
      })),
      patients: snapshot.patients.map((p) => ({
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
      })),
      appointments: snapshot.appointments.map((a) => ({
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        durationMin: a.durationMin,
        status: a.status,
        patientName: patientNames.get(a.patientId) ?? 'Unknown',
        providerId: a.providerId,
        visitTypeCode: a.visitTypeCode,
        updatedAt: a.updatedAt.toISOString(),
      })),
    };
    res.json(response);
  });

  router.post('/appointments', async (req, res) => {
    const body = devEhrCreateAppointmentSchema.parse(req.body);
    const { tenantId } = authOf(req);
    const { tenant } = await tenantContext(tenantId);
    const mock = new MockEhr(deps.db, tenantId);
    const visitType = (await mock.listVisitTypes()).find((v) => v.code === body.visitTypeCode);
    if (!visitType) throw new AppError(400, 'unknown_visit_type', 'Unknown visit type');

    const { ehrAppointmentId } = await mock
      .bookAppointment({
        ehrPatientId: body.patientId,
        ehrProviderId: body.providerId,
        startsAt: zonedTimeToUtc(body.date, body.time, tenant.timezone),
        durationMin: visitType.durationMin,
        visitType: visitType.code,
      })
      .catch(slotErrors);
    await notifySlotFill(tenantId);
    res.status(201).json({ id: ehrAppointmentId });
  });

  router.post('/appointments/:id/cancel', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { tenantId } = authOf(req);
    await new MockEhr(deps.db, tenantId).cancelAppointment(id, 'cancelled from /dev/ehr');
    await notifySlotFill(tenantId);
    res.status(204).end();
  });

  router.post('/appointments/:id/move', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = devEhrMoveAppointmentSchema.parse(req.body);
    const { tenantId } = authOf(req);
    const { tenant } = await tenantContext(tenantId);
    await new MockEhr(deps.db, tenantId)
      .moveAppointment(id, zonedTimeToUtc(body.date, body.time, tenant.timezone))
      .catch(slotErrors);
    await notifySlotFill(tenantId);
    res.status(204).end();
  });

  router.post('/sync', async (req, res) => {
    await notifySlotFill(authOf(req).tenantId);
    res.status(202).end();
  });

  /** Send the reminder text for a (mock EHR) appointment right now, ignoring its schedule and quiet hours. */
  router.post('/appointments/:id/remind-now', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { tenantId } = authOf(req);
    const appt = await deps.db.withTenant(tenantId, (tx) =>
      tx.appointment.findUnique({
        where: { tenantId_ehrAppointmentId: { tenantId, ehrAppointmentId: id } },
      }),
    );
    if (!appt)
      throw new AppError(
        409,
        'not_synced',
        'Not synced into SlotFill yet; wait a moment and retry',
      );
    res.json({ outcome: await deps.reminders.sendNow(tenantId, appt.id) });
  });

  /** (Re)plan reminders for every upcoming appointment, e.g. ones synced before reminders existed. */
  router.post('/reminders/replan', async (req, res) => {
    res.json({ appointments: await deps.reminders.replanTenant(authOf(req).tenantId) });
  });

  return router;
}
