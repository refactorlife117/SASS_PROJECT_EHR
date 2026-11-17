import {
  dashboardQuerySchema,
  settingsUpdateSchema,
  visitTypeUpdateSchema,
  type DashboardSummary,
  type SettingsResponse,
  type VisitTypeDto,
} from '@slotfill/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/client';
import type { JobQueue } from '../../jobs/queues';
import { AppError } from '../../lib/errors';
import type { SmsProviderRegistry } from '../../providers/sms';
import { recordAudit } from '../audit/audit';
import { authOf, requireAuth, requireRole } from '../auth/middleware';
import { dashboardSummary } from '../dashboard/service';

const idParam = z.object({ id: z.uuid() });

export function settingsRoutes(deps: {
  db: Database;
  jobs: JobQueue;
  sms: SmsProviderRegistry;
}): Router {
  // Per-route guards: mounted at the /api/v1 root (see apps/api/CLAUDE.md).
  const router = Router();
  const { db } = deps;

  router.get('/dashboard/summary', requireAuth, async (req, res) => {
    const query = dashboardQuerySchema.parse(req.query);
    const auth = authOf(req);
    const summary: DashboardSummary = await db.withTenant(auth.tenantId, (tx) =>
      dashboardSummary(tx, new Date(query.from), new Date(query.to)),
    );
    res.json(summary);
  });

  router.get('/settings', requireAuth, async (req, res) => {
    const auth = authOf(req);
    const response: SettingsResponse = await db.withTenant(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        include: { settings: true },
      });
      const s =
        tenant.settings ?? (await tx.tenantSettings.create({ data: { tenantId: auth.tenantId } }));
      return {
        clinic: {
          name: tenant.name,
          timezone: tenant.timezone,
          smsNumber: tenant.smsNumber,
          contactPhone: tenant.contactPhone,
          smsProvider: tenant.smsProvider,
          defaultSmsProvider: deps.sms.defaultName,
          availableSmsProviders: deps.sms.names(),
        },
        settings: {
          reminderHoursBefore: s.reminderHoursBefore,
          offerBatchSize: s.offerBatchSize,
          offerBatchTimeoutMin: s.offerBatchTimeoutMin,
          minNoticeMin: s.minNoticeMin,
          backfillHorizonDays: s.backfillHorizonDays,
          quietHoursStart: s.quietHoursStart,
          quietHoursEnd: s.quietHoursEnd,
          autoWaitlistInvite: s.autoWaitlistInvite,
          autoWaitlistMinDaysOut: s.autoWaitlistMinDaysOut,
        },
        canEdit: auth.role === 'owner',
      };
    });
    res.json(response);
  });

  /** Owners only. Changing reminder offsets re-plans every upcoming appointment's reminders. */
  router.patch('/settings', requireAuth, requireRole('owner'), async (req, res) => {
    const { contactPhone, smsProvider, ...settings } = settingsUpdateSchema.parse(req.body);
    if (smsProvider && !deps.sms.get(smsProvider)) {
      throw new AppError(400, 'sms_provider_unavailable', 'That SMS provider is not configured');
    }
    const auth = authOf(req);
    await db.withTenant(auth.tenantId, async (tx) => {
      const before = await tx.tenantSettings.findUniqueOrThrow({
        where: { tenantId: auth.tenantId },
      });
      if (contactPhone !== undefined || smsProvider !== undefined) {
        await tx.tenant.update({
          where: { id: auth.tenantId },
          data: {
            ...(contactPhone !== undefined ? { contactPhone: contactPhone || null } : {}),
            ...(smsProvider !== undefined ? { smsProvider } : {}),
          },
        });
      }
      const after = await tx.tenantSettings.update({
        where: { tenantId: auth.tenantId },
        data: settings,
      });
      const offsetsChanged =
        [...before.reminderHoursBefore].sort().join(',') !==
        [...after.reminderHoursBefore].sort().join(',');
      if (offsetsChanged) {
        await deps.jobs.send('reminder.replan-tenant', { tenantId: auth.tenantId }, undefined, tx);
      }
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'settings.update',
        entity: 'tenant_settings',
        entityId: auth.tenantId,
        ip: req.ip,
      });
    });
    res.status(204).end();
  });

  router.get('/visit-types', requireAuth, async (req, res) => {
    const auth = authOf(req);
    const visitTypes: VisitTypeDto[] = await db.withTenant(auth.tenantId, (tx) =>
      tx.visitType.findMany({
        select: { id: true, code: true, name: true, durationMin: true, estimatedValueCents: true },
        orderBy: { name: 'asc' },
      }),
    );
    res.json({ visitTypes });
  });

  /** Owners set what a visit is worth; drives "revenue recovered". */
  router.patch('/visit-types/:id', requireAuth, requireRole('owner'), async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { estimatedValueCents } = visitTypeUpdateSchema.parse(req.body);
    const auth = authOf(req);
    const updated: VisitTypeDto = await db.withTenant(auth.tenantId, async (tx) => {
      const row = await tx.visitType.update({
        where: { id },
        data: { estimatedValueCents },
        select: { id: true, code: true, name: true, durationMin: true, estimatedValueCents: true },
      });
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'visit_type.update_value',
        entity: 'visit_type',
        entityId: id,
        ip: req.ip,
      });
      return row;
    });
    res.json(updated);
  });

  return router;
}
