// Platform admin console: SlotFill's own operators onboard clinics. They work only with operational
// data (clinic name, time zone, texting number, staff accounts, EHR connection status), never with
// patients, appointments or messages. Every change is audited in the clinic's own audit log.
import { randomUUID } from 'node:crypto';
import type {
  AdminClinicDetail,
  AdminClinicSummary,
  ClinicRole,
  TeamMember,
} from '@slotfill/shared';
import type { Database, Tx } from '../../db/client';
import type { Tenant } from '../../generated/prisma/client';
import type { Clock } from '../../lib/clock';
import type { EmailSender } from '../../lib/email';
import { AppError } from '../../lib/errors';
import type { SmsProviderRegistry } from '../../providers/sms';
import { recordAudit } from '../audit/audit';
import type { AuthContext } from '../auth/middleware';
import {
  createInvitedUser,
  renewInvite,
  sendInviteEmail,
  toTeamMember,
  withUniqueEmail,
} from '../users/invites';

interface ClinicRow {
  tenant_id: string;
  name: string;
  timezone: string;
  sms_number: string | null;
  created_at: Date;
  active_users: bigint;
  invited_users: bigint;
  ehr_type: string | null;
  ehr_status: string | null;
  ehr_last_synced_at: Date | null;
}

export interface CreateClinicInput {
  name: string;
  timezone: string;
  contactPhone?: string | null | undefined;
  smsNumber?: string | null | undefined;
  ownerEmail: string;
}

export interface UpdateClinicInput {
  name?: string | undefined;
  timezone?: string | undefined;
  contactPhone?: string | null | undefined;
  smsNumber?: string | null | undefined;
  smsProvider?: 'dev' | 'aws' | 'twilio' | null | undefined;
}

export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly deps: {
      email: EmailSender;
      appBaseUrl: string;
      clock: Clock;
      sms: SmsProviderRegistry;
    },
  ) {}

  /** Cross-clinic list through the admin_list_clinics() SECURITY DEFINER function. */
  async listClinics(): Promise<AdminClinicSummary[]> {
    const rows = await this.db.unscoped.$queryRaw<ClinicRow[]>`SELECT * FROM admin_list_clinics()`;
    return rows.map((row) => ({
      id: row.tenant_id,
      name: row.name,
      timezone: row.timezone,
      smsNumber: row.sms_number,
      createdAt: row.created_at.toISOString(),
      activeUsers: Number(row.active_users),
      invitedUsers: Number(row.invited_users),
      ehr:
        row.ehr_type && row.ehr_status
          ? {
              type: row.ehr_type,
              status: row.ehr_status,
              lastSyncedAt: row.ehr_last_synced_at?.toISOString() ?? null,
            }
          : null,
    }));
  }

  /**
   * Creates the clinic (tenant + default settings) and its first owner, then emails the owner an
   * invite. The tenant row is inserted inside withTenant(<new id>), so RLS still checks the write.
   */
  async createClinic(
    admin: AuthContext,
    input: CreateClinicInput,
    ip: string | undefined,
  ): Promise<{ clinicId: string }> {
    if (input.smsNumber) await this.assertSmsNumberFree(input.smsNumber, null);
    const clinicId = randomUUID();
    const now = this.deps.clock.now();
    const { user, token } = await withUniqueEmail(() =>
      this.db.withTenant(clinicId, async (tx) => {
        await tx.tenant.create({
          data: {
            id: clinicId,
            name: input.name,
            timezone: input.timezone,
            contactPhone: input.contactPhone ?? null,
            smsNumber: input.smsNumber ?? null,
          },
        });
        await tx.tenantSettings.create({ data: { tenantId: clinicId } });
        const owner = await createInvitedUser(tx, {
          tenantId: clinicId,
          email: input.ownerEmail,
          role: 'owner',
          now,
        });
        await this.audit(tx, clinicId, admin, 'platform.clinic_created', 'tenant', clinicId, ip);
        await this.audit(tx, clinicId, admin, 'platform.user_invited', 'user', owner.user.id, ip);
        return owner;
      }),
    );
    await sendInviteEmail(this.deps.email, {
      to: user.email,
      token,
      role: user.role,
      organization: input.name,
      appBaseUrl: this.deps.appBaseUrl,
    });
    return { clinicId };
  }

  async getClinic(admin: AuthContext, clinicId: string): Promise<AdminClinicDetail> {
    return this.db.withTenant(clinicId, async (tx) => {
      const clinic = await findClinic(tx, clinicId);
      return this.detail(tx, clinic, admin);
    });
  }

  async updateClinic(
    admin: AuthContext,
    clinicId: string,
    input: UpdateClinicInput,
    ip: string | undefined,
  ): Promise<AdminClinicDetail> {
    if (input.smsProvider && !this.deps.sms.get(input.smsProvider)) {
      throw new AppError(400, 'sms_provider_unavailable', 'That SMS provider is not configured');
    }
    if (input.smsNumber) await this.assertSmsNumberFree(input.smsNumber, clinicId);
    return this.db.withTenant(clinicId, async (tx) => {
      await findClinic(tx, clinicId);
      const clinic = await tx.tenant.update({
        where: { id: clinicId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
          ...(input.smsNumber !== undefined ? { smsNumber: input.smsNumber } : {}),
          ...(input.smsProvider !== undefined ? { smsProvider: input.smsProvider } : {}),
        },
      });
      await this.audit(tx, clinicId, admin, 'platform.clinic_updated', 'tenant', clinicId, ip);
      return this.detail(tx, clinic, admin);
    });
  }

  /** Add a user to a clinic, e.g. a replacement owner when the original one has left. */
  async inviteUser(
    admin: AuthContext,
    clinicId: string,
    input: { email: string; role: ClinicRole },
    ip: string | undefined,
  ): Promise<TeamMember> {
    const now = this.deps.clock.now();
    const { user, token, clinicName } = await withUniqueEmail(() =>
      this.db.withTenant(clinicId, async (tx) => {
        const clinic = await findClinic(tx, clinicId);
        const created = await createInvitedUser(tx, {
          tenantId: clinicId,
          email: input.email,
          role: input.role,
          now,
        });
        await this.audit(tx, clinicId, admin, 'platform.user_invited', 'user', created.user.id, ip);
        return { ...created, clinicName: clinic.name };
      }),
    );
    await sendInviteEmail(this.deps.email, {
      to: user.email,
      token,
      role: user.role,
      organization: clinicName,
      appBaseUrl: this.deps.appBaseUrl,
    });
    return toTeamMember(user, now, null);
  }

  async resendInvite(
    admin: AuthContext,
    clinicId: string,
    userId: string,
    ip: string | undefined,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const { user, token, clinicName } = await this.db.withTenant(clinicId, async (tx) => {
      const clinic = await findClinic(tx, clinicId);
      const target = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const renewed = await renewInvite(tx, target, now);
      await this.audit(tx, clinicId, admin, 'platform.invite_resent', 'user', target.id, ip);
      return { user: target, token: renewed, clinicName: clinic.name };
    });
    await sendInviteEmail(this.deps.email, {
      to: user.email,
      token,
      role: user.role,
      organization: clinicName,
      appBaseUrl: this.deps.appBaseUrl,
    });
  }

  private async detail(tx: Tx, clinic: Tenant, admin: AuthContext): Promise<AdminClinicDetail> {
    const now = this.deps.clock.now();
    const [users, ehr] = await Promise.all([
      tx.user.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      tx.ehrConnection.findUnique({ where: { tenantId: clinic.id } }),
    ]);
    return {
      clinic: {
        id: clinic.id,
        name: clinic.name,
        timezone: clinic.timezone,
        smsNumber: clinic.smsNumber,
        contactPhone: clinic.contactPhone,
        smsProvider: clinic.smsProvider,
        createdAt: clinic.createdAt.toISOString(),
      },
      ehr: ehr
        ? {
            type: ehr.ehrType,
            status: ehr.status,
            lastSyncedAt: ehr.lastSyncedAt?.toISOString() ?? null,
          }
        : null,
      users: users.map((user) => toTeamMember(user, now, admin.userId)),
      defaultSmsProvider: this.deps.sms.defaultName,
      availableSmsProviders: this.deps.sms.names(),
    };
  }

  /** A texting number routes inbound replies to exactly one clinic. */
  private async assertSmsNumberFree(smsNumber: string, clinicId: string | null): Promise<void> {
    const owners = await this.db.unscoped.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id::text FROM sms_tenant_by_number(${smsNumber})`;
    if (owners.some((row) => row.tenant_id !== clinicId)) {
      throw new AppError(409, 'sms_number_taken', 'That texting number belongs to another clinic');
    }
  }

  private audit(
    tx: Tx,
    clinicId: string,
    admin: AuthContext,
    action: string,
    entity: string,
    entityId: string,
    ip: string | undefined,
  ) {
    return recordAudit(tx, clinicId, {
      actorType: 'user',
      actorId: admin.userId,
      action,
      entity,
      entityId,
      ip,
    });
  }
}

/** The clinic, or 404. The platform tenant is not a clinic and is never shown here. */
async function findClinic(tx: Tx, clinicId: string): Promise<Tenant> {
  const clinic = await tx.tenant.findFirst({ where: { id: clinicId, isPlatform: false } });
  if (!clinic) throw new AppError(404, 'not_found', 'Not found');
  return clinic;
}
