import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError } from '../../lib/errors';
import type { SmsProviderRegistry } from '../../providers/sms';
import type { MessagingService } from './service';

/**
 * Provider webhooks: no session auth; authenticity comes from the provider's signature check.
 * Always answers 200 once the message is stored (or recognized as a duplicate) so the provider
 * doesn't retry; signature failures get 403.
 */
export function smsWebhookRoutes(deps: {
  messaging: MessagingService;
  sms: SmsProviderRegistry;
  rateLimit: number;
}): Router {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: deps.rateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    },
  });

  router.post(
    '/sms/:provider',
    limiter,
    // Providers post JSON, form-encoded (Twilio) or text/plain JSON (AWS SNS).
    express.urlencoded({ extended: false, limit: '64kb' }),
    express.text({ type: 'text/plain', limit: '64kb' }),
    async (req, res) => {
      const provider = deps.sms.get(String(req.params.provider));
      if (!provider) throw new AppError(404, 'not_found', 'Unknown provider');
      if (!(await provider.verifyInbound(req))) {
        throw new AppError(403, 'invalid_signature', 'Webhook signature check failed');
      }
      const inbound = await provider.parseInbound(req);
      const outcome = inbound
        ? await deps.messaging.handleInbound(inbound, provider.name)
        : 'ignored';
      if (provider.ackResponse) {
        res.status(200).type(provider.ackResponse.contentType).send(provider.ackResponse.body);
        return;
      }
      res.status(200).json({ ok: true, outcome });
    },
  );

  return router;
}
