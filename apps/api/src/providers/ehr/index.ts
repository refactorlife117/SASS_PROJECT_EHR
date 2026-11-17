import type { Database } from '../../db/client';
import type { EhrType } from '../../generated/prisma/client';
import type { FieldCipher } from '../../lib/crypto';
import {
  DrChronoAdapter,
  DrChronoClient,
  drChronoCredentialsSchema,
  type CredentialStore,
  type DrChronoConfig,
} from './drchrono';
import { MockEhr } from './mock';
import type { EhrAdapter } from './types';

export interface EhrConnectionRef {
  tenantId: string;
  ehrType: EhrType;
}

export type EhrAdapterFactory = (connection: EhrConnectionRef) => EhrAdapter;

export interface EhrFactoryDeps {
  db: Database;
  cipher: FieldCipher;
  /** Present only when DrChrono client credentials are configured. */
  drchrono?: DrChronoConfig | undefined;
  fetchImpl?: typeof fetch;
}

/** The tenant's encrypted OAuth tokens in ehr_connections.credentials_enc. */
export function connectionCredentialStore(
  db: Database,
  cipher: FieldCipher,
  tenantId: string,
): CredentialStore {
  return {
    load: () =>
      db.withTenant(tenantId, async (tx) => {
        const connection = await tx.ehrConnection.findUniqueOrThrow({ where: { tenantId } });
        if (!connection.credentialsEnc) throw new Error('EHR connection has no credentials');
        return drChronoCredentialsSchema.parse(
          JSON.parse(cipher.decrypt(connection.credentialsEnc)),
        );
      }),
    save: async (credentials) => {
      await db.withTenant(tenantId, (tx) =>
        tx.ehrConnection.update({
          where: { tenantId },
          data: { credentialsEnc: cipher.encrypt(JSON.stringify(credentials)) },
        }),
      );
    },
  };
}

export function createEhrAdapterFactory(deps: EhrFactoryDeps): EhrAdapterFactory {
  // A Record over the EhrType enum: adding an EHR type fails to compile until it has an adapter.
  const adapters: Record<EhrType, (connection: EhrConnectionRef) => EhrAdapter> = {
    mock: (connection) => new MockEhr(deps.db, connection.tenantId),
    drchrono: (connection) => {
      if (!deps.drchrono) throw new Error('DrChrono is not configured (DRCHRONO_CLIENT_ID/SECRET)');
      const client = new DrChronoClient(
        deps.drchrono,
        connectionCredentialStore(deps.db, deps.cipher, connection.tenantId),
        deps.fetchImpl,
      );
      let timezone: Promise<string> | undefined;
      return new DrChronoAdapter(client, () => {
        timezone ??= deps.db.withTenant(
          connection.tenantId,
          async (tx) =>
            (await tx.tenant.findUniqueOrThrow({ where: { id: connection.tenantId } })).timezone,
        );
        return timezone;
      });
    },
  };
  return (connection) => adapters[connection.ehrType](connection);
}

export * from './types';

/** DrChrono config from env, or undefined when the integration isn't configured. */
export function drChronoConfigFromEnv(env: {
  DRCHRONO_BASE_URL: string;
  DRCHRONO_CLIENT_ID?: string | undefined;
  DRCHRONO_CLIENT_SECRET?: string | undefined;
}): DrChronoConfig | undefined {
  return env.DRCHRONO_CLIENT_ID && env.DRCHRONO_CLIENT_SECRET
    ? {
        baseUrl: env.DRCHRONO_BASE_URL,
        clientId: env.DRCHRONO_CLIENT_ID,
        clientSecret: env.DRCHRONO_CLIENT_SECRET,
      }
    : undefined;
}
