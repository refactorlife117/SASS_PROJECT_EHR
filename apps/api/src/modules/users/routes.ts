import {
  inviteUserSchema,
  updateUserRoleSchema,
  type TeamListResponse,
  type TeamMember,
} from '@slotfill/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authOf, requireAuth, requireRole } from '../auth/middleware';
import type { UserService } from './service';

const idParam = z.object({ id: z.uuid() });

/** Team management for clinic owners. Staff emails aren't PHI, but it's still owners-only. */
export function userRoutes(users: UserService): Router {
  // Per-route guards: mounted at the /api/v1 root (see apps/api/CLAUDE.md).
  const router = Router();
  const owner = [requireAuth, requireRole('owner')];

  router.get('/users', ...owner, async (req, res) => {
    const response: TeamListResponse = { users: await users.list(authOf(req)) };
    res.json(response);
  });

  router.post('/users', ...owner, async (req, res) => {
    const body = inviteUserSchema.parse(req.body);
    const response: TeamMember = await users.invite(authOf(req), body, req.ip);
    res.status(201).json(response);
  });

  router.patch('/users/:id', ...owner, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { role } = updateUserRoleSchema.parse(req.body);
    const response: TeamMember = await users.changeRole(authOf(req), id, role, req.ip);
    res.json(response);
  });

  router.post('/users/:id/deactivate', ...owner, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const response: TeamMember = await users.deactivate(authOf(req), id, req.ip);
    res.json(response);
  });

  router.post('/users/:id/reactivate', ...owner, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const response: TeamMember = await users.reactivate(authOf(req), id, req.ip);
    res.json(response);
  });

  router.post('/users/:id/reset-mfa', ...owner, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const response: TeamMember = await users.resetMfa(authOf(req), id, req.ip);
    res.json(response);
  });

  router.post('/users/:id/resend-invite', ...owner, async (req, res) => {
    const { id } = idParam.parse(req.params);
    await users.resendInvite(authOf(req), id, req.ip);
    res.status(204).end();
  });

  return router;
}
