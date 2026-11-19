import { randomUUID } from 'node:crypto';
import { meResponseSchema, teamListResponseSchema } from '@slotfill/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  admin,
  buildTestApp,
  createTenant,
  createTestContext,
  createUser,
  resetDb,
  signIn,
} from './helpers';

const ctx = await createTestContext();
const { db } = ctx;
const app = buildTestApp(ctx);
const SECRET_A = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SECRET_B = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';

afterAll(() => ctx.close());
beforeEach(resetDb);

async function twoTenants() {
  const a = await createTenant('Tenant A');
  const b = await createTenant('Tenant B');
  const userA = await createUser({ tenantId: a.id, email: 'a@a.test', mfaSecret: SECRET_A });
  const userB = await createUser({ tenantId: b.id, email: 'b@b.test', mfaSecret: SECRET_B });
  await admin.auditLog.create({
    data: { tenantId: b.id, actorType: 'system', action: 'test.seed' },
  });
  return { a, b, userA, userB };
}

describe('RLS coverage', () => {
  it('enables RLS with a policy on every table that has a tenant_id column, and on tenants', async () => {
    const rows = await admin.$queryRaw<{ table_name: string; rls: boolean; policies: bigint }[]>`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls,
             (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (c.relname = 'tenants' OR EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'))`;

    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect({ table: row.table_name, rls: row.rls }).toEqual({ table: row.table_name, rls: true });
      expect(Number(row.policies), `${row.table_name} has no policy`).toBeGreaterThan(0);
    }
  });
});

describe('withTenant (database level)', () => {
  it('only sees the current tenant’s rows', async () => {
    const { a, userA } = await twoTenants();
    const seen = await db.withTenant(a.id, async (tx) => ({
      tenants: await tx.tenant.findMany(),
      users: await tx.user.findMany(),
      settings: await tx.tenantSettings.findMany(),
      audit: await tx.auditLog.findMany(),
    }));
    expect(seen.tenants.map((t) => t.id)).toEqual([a.id]);
    expect(seen.users.map((u) => u.id)).toEqual([userA.id]);
    expect(seen.settings.map((s) => s.tenantId)).toEqual([a.id]);
    expect(seen.audit).toEqual([]);
  });

  it('cannot read another tenant’s row by id', async () => {
    const { a, userB } = await twoTenants();
    const found = await db.withTenant(a.id, (tx) =>
      tx.user.findUnique({ where: { id: userB.id } }),
    );
    expect(found).toBeNull();
  });

  it('cannot insert a row for another tenant', async () => {
    const { a, b } = await twoTenants();
    await expect(
      db.withTenant(a.id, (tx) =>
        tx.auditLog.create({ data: { tenantId: b.id, actorType: 'system', action: 'evil.write' } }),
      ),
    ).rejects.toThrow();
    expect(await admin.auditLog.count({ where: { action: 'evil.write' } })).toBe(0);
  });

  it('cannot update or delete another tenant’s rows', async () => {
    const { a, b, userB } = await twoTenants();
    const result = await db.withTenant(a.id, async (tx) => ({
      updated: await tx.user.updateMany({ where: { id: userB.id }, data: { role: 'owner' } }),
      deleted: await tx.tenantSettings
        .deleteMany({ where: { tenantId: b.id } })
        .catch(() => ({ count: -1 })),
    }));
    expect(result.updated.count).toBe(0);
    expect((await admin.user.findUniqueOrThrow({ where: { id: userB.id } })).role).toBe('staff');
    expect(await admin.tenantSettings.count({ where: { tenantId: b.id } })).toBe(1);
  });

  it('cannot move its own row into another tenant', async () => {
    const { a, b, userA } = await twoTenants();
    await expect(
      db.withTenant(a.id, (tx) =>
        tx.user.update({ where: { id: userA.id }, data: { tenantId: b.id } }),
      ),
    ).rejects.toThrow();
  });

  it('sees nothing at all outside withTenant (fails closed)', async () => {
    await twoTenants();
    expect(await db.unscoped.user.findMany()).toEqual([]);
    expect(await db.unscoped.tenant.findMany()).toEqual([]);
  });

  it('does not leak the tenant setting to the next transaction on the same pool', async () => {
    const { a } = await twoTenants();
    await db.withTenant(a.id, (tx) => tx.user.findMany());
    expect(await db.unscoped.user.findMany()).toEqual([]);
  });

  it('keeps the audit log append-only for the app role', async () => {
    const { a } = await twoTenants();
    await db.withTenant(a.id, (tx) =>
      tx.auditLog.create({ data: { tenantId: a.id, actorType: 'system', action: 'test.entry' } }),
    );
    await expect(
      db.withTenant(a.id, (tx) => tx.auditLog.updateMany({ data: { action: 'tampered' } })),
    ).rejects.toThrow(/permission denied/);
    await expect(db.withTenant(a.id, (tx) => tx.auditLog.deleteMany())).rejects.toThrow(
      /permission denied/,
    );
  });

  it('lets the app role create only the tenant its transaction is scoped to (admin onboarding)', async () => {
    const { a } = await twoTenants();
    await expect(
      db.withTenant(a.id, (tx) => tx.tenant.create({ data: { name: 'Rogue', timezone: 'UTC' } })),
    ).rejects.toThrow(/row-level security/);
    const id = randomUUID();
    await db.withTenant(id, (tx) =>
      tx.tenant.create({ data: { id, name: 'New clinic', timezone: 'UTC' } }),
    );
    expect(await admin.tenant.count({ where: { id } })).toBe(1);
  });
});

describe('isolation through the API', () => {
  it('each tenant’s user only ever sees their own tenant', async () => {
    const { a, b, userA, userB } = await twoTenants();
    const agentA = request.agent(app);
    const agentB = request.agent(app);
    await signIn(agentA, 'a@a.test', SECRET_A);
    await signIn(agentB, 'b@b.test', SECRET_B);

    const meA = meResponseSchema.parse((await agentA.get('/api/v1/auth/me')).body);
    const meB = meResponseSchema.parse((await agentB.get('/api/v1/auth/me')).body);
    expect([meA.tenant.id, meA.user.id]).toEqual([a.id, userA.id]);
    expect([meB.tenant.id, meB.user.id]).toEqual([b.id, userB.id]);
  });

  it('lets an owner see and change only their own clinic’s team', async () => {
    const { a, userA, userB } = await twoTenants();
    await admin.user.update({ where: { id: userA.id }, data: { role: 'owner' } });
    const agentA = request.agent(app);
    await signIn(agentA, 'a@a.test', SECRET_A);

    const team = teamListResponseSchema.parse((await agentA.get('/api/v1/users')).body);
    expect(team.users.map((u) => u.id)).toEqual([userA.id]);
    for (const path of ['deactivate', 'reset-mfa', 'resend-invite', 'reactivate']) {
      expect((await agentA.post(`/api/v1/users/${userB.id}/${path}`)).status).toBe(404);
    }
    expect((await agentA.patch(`/api/v1/users/${userB.id}`).send({ role: 'owner' })).status).toBe(
      404,
    );
    const b = await admin.user.findUniqueOrThrow({ where: { id: userB.id } });
    expect([b.role, b.disabledAt, b.mfaEnabled]).toEqual(['staff', null, true]);
    expect(a.id).toBe(userA.tenantId);
  });

  it('writes audit entries only into the acting user’s tenant', async () => {
    const { a, b } = await twoTenants();
    await signIn(request.agent(app), 'a@a.test', SECRET_A);
    const bActions = (await admin.auditLog.findMany({ where: { tenantId: b.id } })).map(
      (r) => r.action,
    );
    expect(bActions).toEqual(['test.seed']);
    expect(await admin.auditLog.count({ where: { tenantId: a.id } })).toBeGreaterThan(0);
  });
});
