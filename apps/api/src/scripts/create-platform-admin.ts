/* eslint-disable no-console -- CLI script output */
// Creates a SlotFill platform admin (the /admin console) and emails them an invite link.
//   pnpm --filter @slotfill/api admin:create-platform-admin you@yourcompany.com
// Runs with the API's own environment (app database role, email settings), e.g. as a one-off ECS
// task from the API task definition. The invite link goes only to the inbox, never to the logs.
// The first run also creates the platform tenant (the internal home of platform admins).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDatabase } from '../db/client';
import { createEmailSender } from '../lib/email';
import { loadServerEnv } from '../lib/env';
import { AppError } from '../lib/errors';
import { createInvitedUser, sendInviteEmail, withUniqueEmail } from '../modules/users/invites';

const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase())
  .parse(process.argv[2]);

const env = loadServerEnv();
const db = createDatabase(env.DATABASE_URL);

try {
  const [existing] = await db.unscoped.$queryRaw<{ id: string | null }[]>`
    SELECT platform_tenant_id()::text AS id`;
  const platformId = existing?.id ?? randomUUID();
  const now = new Date();

  const { token } = await withUniqueEmail(() =>
    db.withTenant(platformId, async (tx) => {
      if (!existing?.id) {
        await tx.tenant.create({
          data: { id: platformId, name: 'SlotFill', timezone: 'UTC', isPlatform: true },
        });
      }
      return createInvitedUser(tx, { tenantId: platformId, email, role: 'platform_admin', now });
    }),
  );
  await sendInviteEmail(createEmailSender(env), {
    to: email,
    token,
    role: 'platform_admin',
    organization: 'SlotFill',
    appBaseUrl: env.APP_BASE_URL,
  });
  console.log('Platform admin created. The invite link was emailed to them (valid 7 days).');
} catch (err) {
  // Expected failures (e.g. the email already has an account) get a plain message, not a stack.
  if (!(err instanceof AppError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.disconnect();
}
// The SMTP transport keeps pooled connections open; end the one-off process explicitly.
process.exit(process.exitCode ?? 0);
