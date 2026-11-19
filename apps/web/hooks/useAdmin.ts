import {
  adminClinicDetailSchema,
  adminClinicListResponseSchema,
  adminCreateClinicResponseSchema,
  teamMemberSchema,
  type AdminCreateClinicRequest,
  type AdminUpdateClinicRequest,
  type InviteUserRequest,
} from '@slotfill/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost, apiPostNoContent } from '@/lib/api';

const CLINICS_KEY = ['admin', 'clinics'] as const;

export function useAdminClinics() {
  return useQuery({
    queryKey: CLINICS_KEY,
    queryFn: () => apiGet('/admin/clinics', adminClinicListResponseSchema),
  });
}

export function useAdminClinic(id: string) {
  return useQuery({
    queryKey: [...CLINICS_KEY, id],
    queryFn: () => apiGet(`/admin/clinics/${id}`, adminClinicDetailSchema),
  });
}

function useAdminMutation<T, R>(mutationFn: (input: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CLINICS_KEY }),
  });
}

export const useCreateClinic = () =>
  useAdminMutation((body: AdminCreateClinicRequest) =>
    apiPost('/admin/clinics', adminCreateClinicResponseSchema, body),
  );

export const useUpdateClinic = (id: string) =>
  useAdminMutation((body: AdminUpdateClinicRequest) =>
    apiPatch(`/admin/clinics/${id}`, adminClinicDetailSchema, body),
  );

export const useAdminInviteUser = (clinicId: string) =>
  useAdminMutation((body: InviteUserRequest) =>
    apiPost(`/admin/clinics/${clinicId}/users`, teamMemberSchema, body),
  );

export const useAdminResendInvite = (clinicId: string) =>
  useAdminMutation((userId: string) =>
    apiPostNoContent(`/admin/clinics/${clinicId}/users/${userId}/resend-invite`),
  );
