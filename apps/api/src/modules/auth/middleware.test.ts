import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../lib/errors';
import { requireAuth, requireRole, type AuthContext } from './middleware';

const auth = (overrides: Partial<AuthContext> = {}): AuthContext => ({
  sessionId: 's',
  tenantId: 't',
  userId: 'u',
  role: 'staff',
  mfaEnabled: true,
  mfaVerified: true,
  ...overrides,
});

function run(handler: ReturnType<typeof requireRole>, ctx: AuthContext | undefined) {
  const next = vi.fn();
  const nextFn: NextFunction = () => {
    next();
  };
  const req = { auth: ctx } as Request;
  try {
    void handler(req, {} as Response, nextFn);
    return { next, error: undefined };
  } catch (error) {
    return { next, error: error as AppError };
  }
}

describe('requireRole', () => {
  it('allows a listed role', () => {
    expect(run(requireRole('owner'), auth({ role: 'owner' })).next).toHaveBeenCalledOnce();
  });

  it('forbids an unlisted role with 403', () => {
    const { next, error } = run(requireRole('owner'), auth({ role: 'staff' }));
    expect(next).not.toHaveBeenCalled();
    expect(error?.status).toBe(403);
  });

  it('rejects an anonymous request with 401', () => {
    expect(run(requireRole('owner', 'staff'), undefined).error?.status).toBe(401);
  });
});

describe('requireAuth', () => {
  it('rejects a session that has not completed MFA', () => {
    const { error } = run(requireAuth, auth({ mfaVerified: false }));
    expect(error?.code).toBe('mfa_required');
  });
});
