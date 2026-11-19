// Invites: a new user gets an unguessable random password and a single-use "set your password" link.
// The link is a password reset token (same table columns, same /reset-password page and endpoint),
// valid for INVITE_TTL_MS. Using it clears `invited_at`. "Forgot password" also works for an invitee.
import type { TeamMember, UserRole as SharedUserRole } from '@slotfill/shared';
import type { Tx } from '../../db/client';
import type { User, UserRole } from '../../generated/prisma/client';
import { randomToken, sha256Hex } from '../../lib/crypto';
import type { EmailSender } from '../../lib/email';
import { AppError, isUniqueViolation } from '../../lib/errors';
import { hashPassword } from '../auth/passwords';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Creates an invited user in the caller's tenant transaction. Returns the raw link token. */
export async function createInvitedUser(
  tx: Tx,
  input: { tenantId: string; email: string; role: UserRole; now: Date },
): Promise<{ user: User; token: string }> {
  const token = randomToken();
  const user = await tx.user.create({
    data: {
      tenantId: input.tenantId,
      email: input.email,
      role: input.role,
      // Nobody knows this password; the user sets their own through the invite link.
      passwordHash: await hashPassword(randomToken()),
      invitedAt: input.now,
      resetTokenHash: sha256Hex(token),
      resetExpiresAt: new Date(input.now.getTime() + INVITE_TTL_MS),
    },
  });
  return { user, token };
}

/** A fresh link for a pending invite (the old link stops working). */
export async function renewInvite(tx: Tx, user: User, now: Date): Promise<string> {
  if (user.disabledAt) throw new AppError(409, 'user_disabled', 'Reactivate this user first');
  if (!user.invitedAt) throw new AppError(409, 'not_invited', 'This user already set a password');
  const token = randomToken();
  await tx.user.update({
    where: { id: user.id },
    data: {
      resetTokenHash: sha256Hex(token),
      resetExpiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    },
  });
  return token;
}

/** Runs `write`; a duplicate email (in any clinic) becomes a 409 instead of a 500. */
export async function withUniqueEmail<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'email_taken', 'That email address already has a SlotFill account');
    }
    throw err;
  }
}

const ROLE_LABEL: Record<UserRole, string> = {
  owner: 'an owner',
  staff: 'a staff member',
  platform_admin: 'a platform administrator',
};

/** Send after the transaction commits. No PHI: the clinic name and role only. */
export async function sendInviteEmail(
  email: EmailSender,
  input: { to: string; token: string; role: UserRole; organization: string; appBaseUrl: string },
): Promise<void> {
  const link = `${input.appBaseUrl}/reset-password?invite=1&token=${encodeURIComponent(input.token)}`;
  await email.send({
    to: input.to,
    subject: "You're invited to SlotFill",
    text:
      (input.role === 'platform_admin'
        ? `You've been made a SlotFill platform administrator.\n\n`
        : `You've been added to ${input.organization} on SlotFill as ${ROLE_LABEL[input.role]}.\n\n`) +
      `Choose your password here (link valid for 7 days, works once):\n${link}\n\n` +
      `Then sign in and set up two-factor authentication with an authenticator app ` +
      `(Google Authenticator, Microsoft Authenticator, Authy, 1Password…).\n\n` +
      `If you weren't expecting this, you can ignore this email.`,
  });
}

/** API shape of a user row, with its status derived from the invite/disable markers. */
export function toTeamMember(user: User, now: Date, selfId: string | null): TeamMember {
  const status: TeamMember['status'] = user.disabledAt
    ? 'disabled'
    : user.invitedAt
      ? user.resetExpiresAt && user.resetExpiresAt > now
        ? 'invited'
        : 'invite_expired'
      : 'active';
  return {
    id: user.id,
    email: user.email,
    role: user.role satisfies SharedUserRole,
    status,
    mfaEnabled: user.mfaEnabled,
    createdAt: user.createdAt.toISOString(),
    isYou: user.id === selfId,
  };
}
