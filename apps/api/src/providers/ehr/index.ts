import type { Database } from '../../db/client';
import type { EhrType } from '../../generated/prisma/client';
import { MockEhr } from './mock';
import type { EhrAdapter } from './types';

export interface EhrConnectionRef {
  tenantId: string;
  ehrType: EhrType;
}

export type EhrAdapterFactory = (connection: EhrConnectionRef) => EhrAdapter;

export function createEhrAdapterFactory(deps: { db: Database }): EhrAdapterFactory {
  // A Record over the EhrType enum: adding an EHR type fails to compile until it has an adapter.
  const adapters: Record<EhrType, (connection: EhrConnectionRef) => EhrAdapter> = {
    mock: (connection) => new MockEhr(deps.db, connection.tenantId),
  };
  return (connection) => adapters[connection.ehrType](connection);
}

export * from './types';
