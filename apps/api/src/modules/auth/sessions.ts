import type { Database, Tx } from '../../db/client';
import type { UserRole } from '../../generated/prisma/client';
import { hmacSha256, randomToken } from '../../lib/crypto';

export const SESSION_COOKIE = 'sf_session';
export const IDLE_TIMEOUT_MS = 15 * 60_000;
export const ABSOLUTE_TTL_MS = 12 * 60 * 60_000;
/** A password-only session must complete MFA within this window. */
export const PENDING_MFA_TTL_MS = 10 * 60_000;
/** Skip the last_seen_at write when the previous one is this recent. */
const TOUCH_INTERVAL_MS = 60_000;

export interface FoundSession {
  sessionId: string;
  tenantId: string;
  userId: string;
  role: UserRole;
  mfaEnabled: boolean;
  mfaVerifiedAt: Date | null;
  lastSeenAt: Date;
  expiresAt: Date;
}

interface FoundSessionRow {
  session_id: string;
  tenant_id: string;
  user_id: string;
  role: UserRole;
  mfa_enabled: boolean;
  mfa_verified_at: Date | null;
  last_seen_at: Date;
  expires_at: Date;
}

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly secret: string,
  ) {}

  private hash(token: string): string {
    return hmacSha256(this.secret, token);
  }

  /** Creates a session and returns the raw token for the cookie. Only its HMAC is stored. */
  async create(
    tx: Tx,
    input: { tenantId: string; userId: string; mfaVerified: boolean; now?: Date },
  ): Promise<string> {
    const now = input.now ?? new Date();
    const token = randomToken();
    await tx.session.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        tokenHash: this.hash(token),
        mfaVerifiedAt: input.mfaVerified ? now : null,
        lastSeenAt: now,
        expiresAt: new Date(
          now.getTime() + (input.mfaVerified ? ABSOLUTE_TTL_MS : PENDING_MFA_TTL_MS),
        ),
      },
    });
    return token;
  }

  /** Pre-tenant lookup via the SECURITY DEFINER function; the tenant isn't known until this returns. */
  async find(token: string): Promise<FoundSession | null> {
    const rows = await this.db.unscoped.$queryRaw<FoundSessionRow[]>`
      SELECT * FROM auth_find_session(${this.hash(token)})`;
    const row = rows[0];
    if (!row) return null;
    return {
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role,
      mfaEnabled: row.mfa_enabled,
      mfaVerifiedAt: row.mfa_verified_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
    };
  }

  static isExpired(session: FoundSession, now: Date): boolean {
    return (
      session.expiresAt.getTime() <= now.getTime() ||
      now.getTime() - session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS
    );
  }

  static needsTouch(session: FoundSession, now: Date): boolean {
    return now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS;
  }
}
