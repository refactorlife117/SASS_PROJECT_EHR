import type { Tx } from '../../db/client';
import type { AuditActorType } from '../../generated/prisma/client';

export interface AuditEntry {
  actorType: AuditActorType;
  actorId?: string | null;
  /** Dotted verb, e.g. `auth.login.succeeded`. Never include PHI. */
  action: string;
  entity?: string | null;
  entityId?: string | null;
  ip?: string | null;
}

/** Append to the tenant's audit log. Runs inside the caller's tenant transaction (`tx`). */
export async function recordAudit(tx: Tx, tenantId: string, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      entity: entry.entity ?? null,
      entityId: entry.entityId ?? null,
      ip: entry.ip ?? null,
    },
  });
}
