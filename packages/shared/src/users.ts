import { z } from 'zod';
import { clinicRoleSchema, userRoleSchema } from './auth';

/**
 * - `invited`: the invite link was sent and hasn't been used yet.
 * - `invite_expired`: same, but the link has expired; resend it.
 * - `disabled`: deactivated; can't sign in.
 */
export const userStatusSchema = z.enum(['active', 'invited', 'invite_expired', 'disabled']);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const teamMemberSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: userRoleSchema,
  status: userStatusSchema,
  mfaEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
  /** The signed-in user's own row (can't change their own role or deactivate themselves). */
  isYou: z.boolean(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

export const teamListResponseSchema = z.object({ users: z.array(teamMemberSchema) });
export type TeamListResponse = z.infer<typeof teamListResponseSchema>;

const emailSchema = z
  .email()
  .max(254)
  .transform((email) => email.toLowerCase());

export const inviteUserSchema = z.object({ email: emailSchema, role: clinicRoleSchema });
export type InviteUserRequest = z.input<typeof inviteUserSchema>;

export const updateUserRoleSchema = z.object({ role: clinicRoleSchema });
export type UpdateUserRoleRequest = z.infer<typeof updateUserRoleSchema>;
