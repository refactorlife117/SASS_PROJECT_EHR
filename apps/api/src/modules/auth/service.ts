import { createHash } from 'node:crypto';
import type { MeResponse } from '@slotfill/shared';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import type { Database } from '../../db/client';
import type { UserRole } from '../../generated/prisma/client';
import type { Clock } from '../../lib/clock';
import { randomToken, type FieldCipher } from '../../lib/crypto';
import type { EmailSender } from '../../lib/email';
import { AppError } from '../../lib/errors';
import { recordAudit } from '../audit/audit';
import type { AuthContext } from './middleware';
import { hashPassword, verifyPassword } from './passwords';
import type { SessionStore } from './sessions';

const TOTP_ISSUER = 'SlotFill';
/** Accept the previous/next 30 s step to tolerate clock drift. */
const TOTP_TOLERANCE_SECONDS = 30;

interface FoundUserRow {
  user_id: string;
  tenant_id: string;
  password_hash: string;
  role: UserRole;
  mfa_enabled: boolean;
}

const invalidCredentials = () =>
  new AppError(401, 'invalid_credentials', 'Invalid email or password');
const invalidCode = () => new AppError(401, 'invalid_mfa_code', 'Invalid code');

/** Password reset links are valid this long and work once. */
export const RESET_TOKEN_TTL_MS = 30 * 60_000;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

interface ResetTokenRow {
  user_id: string;
  tenant_id: string;
  expires_at: Date | null;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessions: SessionStore,
    private readonly cipher: FieldCipher,
    private readonly mail: { email: EmailSender; appBaseUrl: string; clock: Clock },
  ) {}

  /**
   * "Forgot password": email a single-use link if the account exists. Callers always answer the same
   * way, so the response never reveals whether an email is registered.
   */
  async requestPasswordReset(email: string, ip: string | undefined): Promise<void> {
    const rows = await this.db.unscoped.$queryRaw<FoundUserRow[]>`
      SELECT * FROM auth_find_user_by_email(${email})`;
    const user = rows[0];
    if (!user) return;
    const token = randomToken();
    await this.db.withTenant(user.tenant_id, async (tx) => {
      await tx.user.update({
        where: { id: user.user_id },
        data: {
          resetTokenHash: sha256(token),
          resetExpiresAt: new Date(this.mail.clock.now().getTime() + RESET_TOKEN_TTL_MS),
        },
      });
      await recordAudit(tx, user.tenant_id, {
        actorType: 'user',
        actorId: user.user_id,
        action: 'auth.password_reset_requested',
        entity: 'user',
        entityId: user.user_id,
        ip,
      });
    });
    const link = `${this.mail.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.mail.email.send({
      to: email,
      subject: 'Reset your SlotFill password',
      text:
        `Someone (hopefully you) asked to reset your SlotFill password.\n\n` +
        `Reset it here (link valid for 30 minutes, works once):\n${link}\n\n` +
        `If you didn't ask, you can ignore this email. Your password won't change.`,
    });
  }

  /** Set a new password with a reset token. Signs the user out everywhere; MFA stays required. */
  async resetPassword(token: string, newPassword: string, ip: string | undefined): Promise<void> {
    const rows = await this.db.unscoped.$queryRaw<ResetTokenRow[]>`
      SELECT * FROM auth_find_user_by_reset_token(${sha256(token)})`;
    const found = rows[0];
    if (!found?.expires_at || found.expires_at <= this.mail.clock.now()) {
      throw new AppError(400, 'invalid_reset_token', 'This reset link is invalid or has expired');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.db.withTenant(found.tenant_id, async (tx) => {
      await tx.user.update({
        where: { id: found.user_id },
        data: { passwordHash, resetTokenHash: null, resetExpiresAt: null },
      });
      await tx.session.deleteMany({ where: { userId: found.user_id } });
      await recordAudit(tx, found.tenant_id, {
        actorType: 'user',
        actorId: found.user_id,
        action: 'auth.password_reset',
        entity: 'user',
        entityId: found.user_id,
        ip,
      });
    });
  }

  /** Step 1: password. Returns a pending (pre-MFA) session token and the next step. */
  async login(input: { email: string; password: string; ip: string | undefined }) {
    // Pre-tenant lookup: the tenant is only known once we find the user.
    const rows = await this.db.unscoped.$queryRaw<FoundUserRow[]>`
      SELECT * FROM auth_find_user_by_email(${input.email})`;
    const user = rows[0];
    const passwordOk = await verifyPassword(user?.password_hash, input.password);
    if (!user) throw invalidCredentials();

    const audit = {
      actorType: 'user' as const,
      actorId: user.user_id,
      entity: 'user',
      entityId: user.user_id,
      ip: input.ip,
    };
    if (!passwordOk) {
      await this.db.withTenant(user.tenant_id, (tx) =>
        recordAudit(tx, user.tenant_id, { ...audit, action: 'auth.login.failed' }),
      );
      throw invalidCredentials();
    }

    const token = await this.db.withTenant(user.tenant_id, async (tx) => {
      await recordAudit(tx, user.tenant_id, { ...audit, action: 'auth.login.password_ok' });
      return this.sessions.create(tx, {
        tenantId: user.tenant_id,
        userId: user.user_id,
        mfaVerified: false,
      });
    });
    return { token, next: user.mfa_enabled ? ('mfa_verify' as const) : ('mfa_setup' as const) };
  }

  /** First-time enrollment: issue a new TOTP secret (stored encrypted, not yet enabled). */
  async setupMfa(auth: AuthContext, ip: string | undefined) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
      if (user.mfaEnabled) throw new AppError(409, 'mfa_already_enabled', 'MFA is already enabled');

      const secret = generateSecret();
      await tx.user.update({
        where: { id: user.id },
        data: { mfaSecretEnc: this.cipher.encrypt(secret), mfaLastTimeStep: null },
      });
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: user.id,
        action: 'auth.mfa.setup_started',
        entity: 'user',
        entityId: user.id,
        ip,
      });
      return {
        secret,
        otpauthUrl: generateURI({ issuer: TOTP_ISSUER, label: user.email, secret }),
      };
    });
  }

  /**
   * Step 2: verify a TOTP code. On success, enables MFA (first time) and replaces the pending
   * session with a new fully-verified one (token rotation prevents session fixation).
   */
  async verifyMfa(auth: AuthContext, code: string, ip: string | undefined) {
    const outcome = await this.db.withTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
      if (!user.mfaSecretEnc) throw new AppError(409, 'mfa_not_set_up', 'Set up MFA first');

      const result = await verifyTotp({
        secret: this.cipher.decrypt(user.mfaSecretEnc),
        token: code,
        epochTolerance: TOTP_TOLERANCE_SECONDS,
        ...(user.mfaLastTimeStep !== null ? { afterTimeStep: user.mfaLastTimeStep } : {}),
      });
      const audit = {
        actorType: 'user' as const,
        actorId: user.id,
        entity: 'user',
        entityId: user.id,
        ip,
      };

      // Failures return (not throw) so the audit entry commits.
      // otplib types TOTP and HOTP results as one union; only TOTP results carry timeStep.
      if (!result.valid || !('timeStep' in result)) {
        await recordAudit(tx, auth.tenantId, { ...audit, action: 'auth.mfa.failed' });
        return { ok: false as const };
      }

      await tx.user.update({
        where: { id: user.id },
        data: { mfaEnabled: true, mfaLastTimeStep: result.timeStep },
      });
      if (!user.mfaEnabled)
        await recordAudit(tx, auth.tenantId, { ...audit, action: 'auth.mfa.enabled' });
      await recordAudit(tx, auth.tenantId, { ...audit, action: 'auth.login.succeeded' });

      await tx.session.delete({ where: { id: auth.sessionId } });
      const token = await this.sessions.create(tx, {
        tenantId: auth.tenantId,
        userId: user.id,
        mfaVerified: true,
      });
      return { ok: true as const, token };
    });

    if (!outcome.ok) throw invalidCode();
    return { token: outcome.token };
  }

  async logout(auth: AuthContext, ip: string | undefined): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (tx) => {
      await tx.session.deleteMany({ where: { id: auth.sessionId } });
      await recordAudit(tx, auth.tenantId, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'auth.logout',
        entity: 'user',
        entityId: auth.userId,
        ip,
      });
    });
  }

  async me(auth: AuthContext): Promise<MeResponse> {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: {
          id: true,
          email: true,
          role: true,
          tenant: { select: { id: true, name: true, timezone: true } },
        },
      });
      return { user: { id: user.id, email: user.email, role: user.role }, tenant: user.tenant };
    });
  }
}
