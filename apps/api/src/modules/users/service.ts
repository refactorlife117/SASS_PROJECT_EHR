import type { ClinicRole, TeamMember } from '@slotfill/shared';
import type { Database, Tx } from '../../db/client';
import type { User } from '../../generated/prisma/client';
import type { Clock } from '../../lib/clock';
import type { EmailSender } from '../../lib/email';
import { AppError } from '../../lib/errors';
import { recordAudit } from '../audit/audit';
import type { AuthContext } from '../auth/middleware';
import {
  createInvitedUser,
  renewInvite,
  sendInviteEmail,
  toTeamMember,
  withUniqueEmail,
} from './invites';

/**
 * A clinic owner manages their own team: invite, change roles, deactivate/reactivate, resend an
 * invite, reset someone's two-factor. Owners can't change their own role or deactivate themselves,
 * so every clinic keeps at least one active owner (the one acting).
 */
export class UserService {
  constructor(
    private readonly db: Database,
    private readonly deps: { email: EmailSender; appBaseUrl: string; clock: Clock },
  ) {}

  async list(auth: AuthContext): Promise<TeamMember[]> {
    const now = this.deps.clock.now();
    const users = await this.db.withTenant(auth.tenantId, (tx) =>
      tx.user.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    );
    return users.map((user) => toTeamMember(user, now, auth.userId));
  }

  async invite(
    auth: AuthContext,
    input: { email: string; role: ClinicRole },
    ip: string | undefined,
  ): Promise<TeamMember> {
    const now = this.deps.clock.now();
    const { user, token, clinicName } = await withUniqueEmail(() =>
      this.db.withTenant(auth.tenantId, async (tx) => {
        await this.lockOwnersAndCheckActor(tx, auth);
        const created = await createInvitedUser(tx, {
          tenantId: auth.tenantId,
          email: input.email,
          role: input.role,
          now,
        });
        await this.audit(tx, auth, 'user.invited', created.user.id, ip);
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
        return { ...created, clinicName: tenant.name };
      }),
    );
    await sendInviteEmail(this.deps.email, {
      to: user.email,
      token,
      role: user.role,
      organization: clinicName,
      appBaseUrl: this.deps.appBaseUrl,
    });
    return toTeamMember(user, now, auth.userId);
  }

  async resendInvite(auth: AuthContext, userId: string, ip: string | undefined): Promise<void> {
    const now = this.deps.clock.now();
    const { user, token, clinicName } = await this.db.withTenant(auth.tenantId, async (tx) => {
      await this.lockOwnersAndCheckActor(tx, auth);
      const target = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const renewed = await renewInvite(tx, target, now);
      await this.audit(tx, auth, 'user.invite_resent', target.id, ip);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
      return { user: target, token: renewed, clinicName: tenant.name };
    });
    await sendInviteEmail(this.deps.email, {
      to: user.email,
      token,
      role: user.role,
      organization: clinicName,
      appBaseUrl: this.deps.appBaseUrl,
    });
  }

  async changeRole(
    auth: AuthContext,
    userId: string,
    role: ClinicRole,
    ip: string | undefined,
  ): Promise<TeamMember> {
    return this.updateOther(auth, userId, ip, 'user.role_changed', (tx, target) =>
      target.role === role
        ? Promise.resolve(target)
        : tx.user.update({ where: { id: target.id }, data: { role } }),
    );
  }

  /** Signs them out everywhere and blocks sign-in, reset links and invites. */
  async deactivate(auth: AuthContext, userId: string, ip: string | undefined): Promise<TeamMember> {
    return this.updateOther(auth, userId, ip, 'user.deactivated', async (tx, target) => {
      if (target.disabledAt) return target;
      await tx.session.deleteMany({ where: { userId: target.id } });
      return tx.user.update({
        where: { id: target.id },
        data: {
          disabledAt: this.deps.clock.now(),
          resetTokenHash: null,
          resetExpiresAt: null,
        },
      });
    });
  }

  /** Restores access. A user who never accepted their invite needs a resent invite. */
  async reactivate(auth: AuthContext, userId: string, ip: string | undefined): Promise<TeamMember> {
    return this.updateOther(auth, userId, ip, 'user.reactivated', (tx, target) =>
      target.disabledAt
        ? tx.user.update({ where: { id: target.id }, data: { disabledAt: null } })
        : Promise.resolve(target),
    );
  }

  /** Lost phone: they enroll a new authenticator at their next sign-in. Signs them out. */
  async resetMfa(auth: AuthContext, userId: string, ip: string | undefined): Promise<TeamMember> {
    return this.updateOther(auth, userId, ip, 'user.mfa_reset', async (tx, target) => {
      await tx.session.deleteMany({ where: { userId: target.id } });
      return tx.user.update({
        where: { id: target.id },
        data: { mfaEnabled: false, mfaSecretEnc: null, mfaLastTimeStep: null },
      });
    });
  }

  /** Shared shape of every change to another user of the same clinic. */
  private async updateOther(
    auth: AuthContext,
    userId: string,
    ip: string | undefined,
    action: string,
    change: (tx: Tx, target: User) => Promise<User>,
  ): Promise<TeamMember> {
    if (userId === auth.userId) {
      throw new AppError(409, 'cannot_change_self', "You can't change your own account here");
    }
    const user = await this.db.withTenant(auth.tenantId, async (tx) => {
      await this.lockOwnersAndCheckActor(tx, auth);
      const target = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const updated = await change(tx, target);
      await this.audit(tx, auth, action, target.id, ip);
      return updated;
    });
    return toTeamMember(user, this.deps.clock.now(), auth.userId);
  }

  /**
   * Serializes team changes within a clinic (locks its owner rows) and re-checks that the actor is
   * still an active owner. Without it, two owners deactivating each other at the same moment could
   * both succeed and lock the clinic out.
   */
  private async lockOwnersAndCheckActor(tx: Tx, auth: AuthContext): Promise<void> {
    const owners = await tx.$queryRaw<{ id: string; disabled_at: Date | null }[]>`
      SELECT id::text, disabled_at FROM users
      WHERE tenant_id = ${auth.tenantId}::uuid AND role = 'owner'
      ORDER BY id FOR UPDATE`;
    const actor = owners.find((owner) => owner.id === auth.userId);
    if (!actor || actor.disabled_at) throw new AppError(403, 'forbidden', 'Insufficient role');
  }

  private audit(tx: Tx, auth: AuthContext, action: string, userId: string, ip: string | undefined) {
    return recordAudit(tx, auth.tenantId, {
      actorType: 'user',
      actorId: auth.userId,
      action,
      entity: 'user',
      entityId: userId,
      ip,
    });
  }
}
