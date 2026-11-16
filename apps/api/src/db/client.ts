import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';

export type Tx = Prisma.TransactionClient;

export interface TenantTxOptions {
  /** Transaction timeout in ms (Prisma default 5000). Raise only for bulk work such as EHR sync. */
  timeoutMs?: number;
}

export interface Database {
  /**
   * Run `fn` in a transaction scoped to one tenant. RLS reads the tenant from the transaction-local
   * `app.tenant_id` setting, so every query inside MUST use `tx`.
   */
  withTenant<T>(
    tenantId: string,
    fn: (tx: Tx) => Promise<T>,
    options?: TenantTxOptions,
  ): Promise<T>;
  /**
   * Unscoped client. RLS denies it every tenant row, so it is only useful for the SECURITY DEFINER
   * pre-tenant lookups (see docs/tenancy.md). Never use it for tenant data.
   */
  unscoped: PrismaClient;
  disconnect(): Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  return {
    withTenant: (tenantId, fn, options) =>
      prisma.$transaction(
        async (tx) => {
          // set_config(..., true) is transaction-local, like SET LOCAL but parameterizable.
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          return fn(tx);
        },
        options?.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
      ),
    unscoped: prisma,
    disconnect: () => prisma.$disconnect(),
  };
}
