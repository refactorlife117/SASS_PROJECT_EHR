import type { CookieOptions, RequestHandler } from 'express';
import type { Database } from '../../db/client';
import type { UserRole } from '../../generated/prisma/client';
import { AppError } from '../../lib/errors';
import { SESSION_COOKIE, SessionStore } from './sessions';

export interface AuthContext {
  sessionId: string;
  tenantId: string;
  userId: string;
  role: UserRole;
  mfaEnabled: boolean;
  mfaVerified: boolean;
}

export function sessionCookieOptions(secure: boolean): CookieOptions {
  // No maxAge: a browser-session cookie. Expiry is enforced server-side (idle + absolute).
  return { httpOnly: true, secure, sameSite: 'strict', path: '/' };
}

/** Resolves the session cookie (if any) into `req.auth`. Never rejects; guards below do that. */
export function loadSession(deps: {
  db: Database;
  sessions: SessionStore;
  cookieSecure: boolean;
}): RequestHandler {
  return async (req, res, next) => {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const token = cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) {
      next();
      return;
    }

    const session = await deps.sessions.find(token);
    if (!session) {
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions(deps.cookieSecure));
      next();
      return;
    }

    const now = new Date();
    if (SessionStore.isExpired(session, now)) {
      await deps.db.withTenant(session.tenantId, (tx) =>
        tx.session.deleteMany({ where: { id: session.sessionId } }),
      );
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions(deps.cookieSecure));
      next();
      return;
    }

    if (SessionStore.needsTouch(session, now)) {
      await deps.db.withTenant(session.tenantId, (tx) =>
        tx.session.update({ where: { id: session.sessionId }, data: { lastSeenAt: now } }),
      );
    }

    req.auth = {
      sessionId: session.sessionId,
      tenantId: session.tenantId,
      userId: session.userId,
      role: session.role,
      mfaEnabled: session.mfaEnabled,
      mfaVerified: session.mfaVerifiedAt !== null,
    };
    next();
  };
}

/** Fully authenticated (password + MFA). Required for everything that touches tenant data. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw new AppError(401, 'unauthenticated', 'Sign in required');
  if (!req.auth.mfaVerified) throw new AppError(401, 'mfa_required', 'MFA required');
  next();
};

/** Signed in with a password but MFA not yet completed (the MFA setup/verify steps). */
export const requirePendingMfa: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw new AppError(401, 'unauthenticated', 'Sign in required');
  if (req.auth.mfaVerified) throw new AppError(409, 'mfa_already_verified', 'MFA already verified');
  next();
};

/** Any session, pending or verified (e.g. logout). */
export const requireSession: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw new AppError(401, 'unauthenticated', 'Sign in required');
  next();
};

/** RBAC. Use after requireAuth. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw new AppError(401, 'unauthenticated', 'Sign in required');
    if (!roles.includes(req.auth.role)) throw new AppError(403, 'forbidden', 'Insufficient role');
    next();
  };
}

/** Returns the auth context or throws; for handlers mounted behind a guard. */
export function authOf(req: { auth?: AuthContext | undefined }): AuthContext {
  if (!req.auth) throw new AppError(401, 'unauthenticated', 'Sign in required');
  return req.auth;
}
