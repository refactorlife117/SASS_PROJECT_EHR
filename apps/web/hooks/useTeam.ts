import {
  teamListResponseSchema,
  teamMemberSchema,
  type ClinicRole,
  type InviteUserRequest,
} from '@slotfill/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost, apiPostNoContent } from '@/lib/api';

const TEAM_KEY = ['team'] as const;

export function useTeam() {
  return useQuery({
    queryKey: TEAM_KEY,
    queryFn: () => apiGet('/users', teamListResponseSchema),
  });
}

function useTeamMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TEAM_KEY }),
  });
}

export const useInviteUser = () =>
  useTeamMutation((body: InviteUserRequest) => apiPost('/users', teamMemberSchema, body));

export const useChangeRole = () =>
  useTeamMutation(({ id, role }: { id: string; role: ClinicRole }) =>
    apiPatch(`/users/${id}`, teamMemberSchema, { role }),
  );

/** deactivate | reactivate | reset-mfa | resend-invite */
export type TeamAction = 'deactivate' | 'reactivate' | 'reset-mfa' | 'resend-invite';

export const useTeamAction = () =>
  useTeamMutation(({ id, action }: { id: string; action: TeamAction }) =>
    apiPostNoContent(`/users/${id}/${action}`),
  );
