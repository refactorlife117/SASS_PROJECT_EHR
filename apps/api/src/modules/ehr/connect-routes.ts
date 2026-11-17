// Connecting a clinic to its real EHR (DrChrono OAuth2 authorization-code flow). Owners only.
import { timingSafeEqual } from 'node:crypto';
import type { EhrConnectionResponse } from '@slotfill/shared';
import { Router, type CookieOptions } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/client';
import type { JobQueue } from '../../jobs/queues';
import { hmacSha256, randomToken, type FieldCipher } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import {
  DrChronoClient,
  exchangeToken,
  type DrChronoConfig,
  type DrChronoCredentials,
} from '../../providers/ehr/drchrono';
import { recordAudit } from '../audit/audit';
import { authOf, requireAuth, requireRole } from '../auth/middleware';

const STATE_COOKIE = 'sf_ehr_oauth';
const STATE_TTL_MS = 10 * 60_000;
/** calendar: appointments + profiles, patients: details, user: doctors/offices. */
const SCOPES = 'user:read calendar:read calendar:write patients:read settings:read';

export interface EhrConnectDeps {
  db: Database;
  jobs: JobQueue;
  cipher: FieldCipher;
  logger: Logger;
  sessionSecret: string;
  appBaseUrl: string;
  cookieSecure: boolean;
  drchrono?: DrChronoConfig | undefined;
  fetchImpl?: typeof fetch;
}

/** State cookie value: nonce.tenantId.userId.issuedAt.signature (HMAC with the session secret). */
function signState(secret: string, parts: [string, string, string, string]): string {
  return `${parts.join('.')}.${hmacSha256(secret, parts.join('.'))}`;
}

function readState(secret: string, cookie: unknown, now: number) {
  if (typeof cookie !== 'string') return null;
  const [nonce, tenantId, userId, issuedAt, signature] = cookie.split('.');
  if (!nonce || !tenantId || !userId || !issuedAt || !signature) return null;
  const expected = Buffer.from(hmacSha256(secret, [nonce, tenantId, userId, issuedAt].join('.')));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (now - Number(issuedAt) > STATE_TTL_MS) return null;
  return { nonce, tenantId, userId };
}

export function ehrConnectRoutes(deps: EhrConnectDeps): Router {
  // Per-route guards: mounted at the /api/v1 root (see apps/api/CLAUDE.md).
  const router = Router();
  const redirectUri = `${deps.appBaseUrl}/api/v1/ehr/drchrono/callback`;
  // Lax (not Strict): the callback is a top-level redirect from drchrono.com.
  const stateCookie: CookieOptions = {
    httpOnly: true,
    secure: deps.cookieSecure,
    sameSite: 'lax',
    path: '/api/v1/ehr',
    maxAge: STATE_TTL_MS,
  };

  router.get('/ehr/connection', requireAuth, async (req, res) => {
    const auth = authOf(req);
    const connection = await deps.db.withTenant(auth.tenantId, (tx) =>
      tx.ehrConnection.findUnique({ where: { tenantId: auth.tenantId } }),
    );
    const response: EhrConnectionResponse = {
      connection: connection && {
        ehrType: connection.ehrType,
        status: connection.status,
        lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
        lastError: connection.lastError,
      },
      available: deps.drchrono ? ['drchrono'] : [],
      canEdit: auth.role === 'owner',
    };
    res.json(response);
  });

  router.post('/ehr/drchrono/authorize', requireAuth, requireRole('owner'), (req, res) => {
    if (!deps.drchrono) throw new AppError(409, 'not_configured', 'DrChrono is not configured');
    const auth = authOf(req);
    const nonce = randomToken(24);
    res.cookie(
      STATE_COOKIE,
      signState(deps.sessionSecret, [nonce, auth.tenantId, auth.userId, String(Date.now())]),
      stateCookie,
    );
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      response_type: 'code',
      client_id: deps.drchrono.clientId,
      scope: SCOPES,
      state: nonce,
    });
    res.json({ authorizeUrl: `${deps.drchrono.baseUrl}/o/authorize/?${params.toString()}` });
  });

  router.get('/ehr/drchrono/callback', async (req, res) => {
    const done = (outcome: 'connected' | 'error') => {
      res.clearCookie(STATE_COOKIE, { ...stateCookie, maxAge: undefined });
      res.redirect(302, `${deps.appBaseUrl}/settings?ehr=${outcome}`);
    };
    const query = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .safeParse(req.query);
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const state = readState(deps.sessionSecret, cookies?.[STATE_COOKIE], Date.now());
    if (!deps.drchrono || !query.success || state?.nonce !== query.data.state) {
      done('error');
      return;
    }
    const config = deps.drchrono;
    try {
      const tokens = await exchangeToken(config, deps.fetchImpl ?? fetch, {
        grant_type: 'authorization_code',
        code: query.data.code,
        redirect_uri: redirectUri,
      });
      // Default office/exam room for new bookings: the practice's first office.
      let credentials: DrChronoCredentials = { ...tokens, officeId: 0, examRoom: 1 };
      const client = new DrChronoClient(
        config,
        {
          load: () => Promise.resolve(credentials),
          save: (c) => {
            credentials = c;
            return Promise.resolve();
          },
        },
        deps.fetchImpl,
      );
      const offices = z
        .array(
          z.object({
            id: z.number(),
            exam_rooms: z.array(z.object({ index: z.number() })).optional(),
          }),
        )
        .parse(await client.list('/api/offices', {}));
      const office = offices[0];
      if (!office) throw new Error('DrChrono practice has no offices');
      credentials = {
        ...credentials,
        officeId: office.id,
        examRoom: office.exam_rooms?.[0]?.index ?? 1,
      };

      await deps.db.withTenant(state.tenantId, async (tx) => {
        const credentialsEnc = deps.cipher.encrypt(JSON.stringify(credentials));
        const reset = { lastSyncedAt: null, lastFullSyncAt: null, lastError: null };
        await tx.ehrConnection.upsert({
          where: { tenantId: state.tenantId },
          create: {
            tenantId: state.tenantId,
            ehrType: 'drchrono',
            credentialsEnc,
            status: 'active',
          },
          update: { ehrType: 'drchrono', credentialsEnc, status: 'active', ...reset },
        });
        // A full backfill runs right away (never-synced connections always run full).
        await deps.jobs.send(
          'ehr.sync',
          { tenantId: state.tenantId, mode: 'full' },
          { singletonKey: state.tenantId },
          tx,
        );
        await recordAudit(tx, state.tenantId, {
          actorType: 'user',
          actorId: state.userId,
          action: 'ehr.connected',
          entity: 'ehr_connection',
          ip: req.ip,
        });
      });
      done('connected');
    } catch (err) {
      deps.logger.error({ err, tenantId: state.tenantId }, 'DrChrono connection failed');
      done('error');
    }
  });

  return router;
}
