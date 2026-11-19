import {
  adminCreateClinicSchema,
  adminUpdateClinicSchema,
  inviteUserSchema,
  type AdminClinicDetail,
  type AdminClinicListResponse,
  type TeamMember,
} from '@slotfill/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authOf, requireAuth, requireRole } from '../auth/middleware';
import type { AdminService } from './service';

const clinicParam = z.object({ id: z.uuid() });
const clinicUserParam = z.object({ id: z.uuid(), userId: z.uuid() });

/** SlotFill operators only (role platform_admin, password + MFA). Mounted at /api/v1/admin. */
export function adminRoutes(admin: AdminService): Router {
  const router = Router();
  router.use(requireAuth, requireRole('platform_admin'));

  router.get('/clinics', async (_req, res) => {
    const response: AdminClinicListResponse = { clinics: await admin.listClinics() };
    res.json(response);
  });

  router.post('/clinics', async (req, res) => {
    const body = adminCreateClinicSchema.parse(req.body);
    res.status(201).json(await admin.createClinic(authOf(req), body, req.ip));
  });

  router.get('/clinics/:id', async (req, res) => {
    const { id } = clinicParam.parse(req.params);
    const response: AdminClinicDetail = await admin.getClinic(authOf(req), id);
    res.json(response);
  });

  router.patch('/clinics/:id', async (req, res) => {
    const { id } = clinicParam.parse(req.params);
    const body = adminUpdateClinicSchema.parse(req.body);
    const response: AdminClinicDetail = await admin.updateClinic(authOf(req), id, body, req.ip);
    res.json(response);
  });

  router.post('/clinics/:id/users', async (req, res) => {
    const { id } = clinicParam.parse(req.params);
    const body = inviteUserSchema.parse(req.body);
    const response: TeamMember = await admin.inviteUser(authOf(req), id, body, req.ip);
    res.status(201).json(response);
  });

  router.post('/clinics/:id/users/:userId/resend-invite', async (req, res) => {
    const { id, userId } = clinicUserParam.parse(req.params);
    await admin.resendInvite(authOf(req), id, userId, req.ip);
    res.status(204).end();
  });

  return router;
}
