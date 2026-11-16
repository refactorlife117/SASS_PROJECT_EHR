import {
  loginResponseSchema,
  meResponseSchema,
  mfaSetupResponseSchema,
  type LoginRequest,
  type MfaVerifyRequest,
} from '@slotfill/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost, apiPostNoContent } from '@/lib/api';

const ME_KEY = ['auth', 'me'] as const;

/** The signed-in user, or null when not (fully) signed in. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await apiGet('/auth/me', meResponseSchema);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export function useLogin() {
  return useMutation({
    mutationFn: (body: LoginRequest) => apiPost('/auth/login', loginResponseSchema, body),
  });
}

export function useMfaSetup() {
  return useMutation({
    mutationFn: () => apiPost('/auth/mfa/setup', mfaSetupResponseSchema),
  });
}

export function useMfaVerify() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MfaVerifyRequest) => apiPost('/auth/mfa/verify', meResponseSchema, body),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_KEY, me);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPostNoContent('/auth/logout'),
    onSettled: () => {
      // Drop every cached resource; the next user must not see the previous user's data.
      queryClient.clear();
    },
  });
}
