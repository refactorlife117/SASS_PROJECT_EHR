import {
  loginRequestSchema,
  mfaVerifyRequestSchema,
  type LoginResponse,
  type MfaSetupResponse,
} from '@slotfill/shared';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  authOf,
  requireAuth,
  requirePendingMfa,
  requireSession,
  sessionCookieOptions,
} from './middleware';
import type { AuthService } from './service';
import { SESSION_COOKIE } from './sessions';

export interface AuthRoutesOptions {
  cookieSecure: boolean;
  /** Max login/MFA attempts per IP per 15 minutes. */
  authRateLimit: number;
}

export function authRoutes(service: AuthService, options: AuthRoutesOptions): Router {
  const router = Router();
  const cookie = sessionCookieOptions(options.cookieSecure);
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: options.authRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res
        .status(429)
        .json({ error: { code: 'rate_limited', message: 'Too many attempts, try again later' } });
    },
  });

  router.post('/login', limiter, async (req, res) => {
    const body = loginRequestSchema.parse(req.body);
    const result = await service.login({ ...body, ip: req.ip });
    res.cookie(SESSION_COOKIE, result.token, cookie);
    const response: LoginResponse = { next: result.next };
    res.json(response);
  });

  router.post('/mfa/setup', requirePendingMfa, async (req, res) => {
    const response: MfaSetupResponse = await service.setupMfa(authOf(req), req.ip);
    res.json(response);
  });

  router.post('/mfa/verify', limiter, requirePendingMfa, async (req, res) => {
    const { code } = mfaVerifyRequestSchema.parse(req.body);
    const auth = authOf(req);
    const { token } = await service.verifyMfa(auth, code, req.ip);
    res.cookie(SESSION_COOKIE, token, cookie);
    res.json(await service.me(auth));
  });

  router.post('/logout', requireSession, async (req, res) => {
    await service.logout(authOf(req), req.ip);
    res.clearCookie(SESSION_COOKIE, cookie);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    res.json(await service.me(authOf(req)));
  });

  return router;
}
