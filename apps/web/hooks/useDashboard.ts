import {
  dashboardSummarySchema,
  settingsResponseSchema,
  visitTypeSchema,
  type SettingsUpdate,
} from '@slotfill/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPatchNoContent } from '@/lib/api';

export function useDashboard(range: { from: Date; to: Date }) {
  const params = new URLSearchParams({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
  });
  return useQuery({
    queryKey: ['dashboard', params.toString()],
    queryFn: () => apiGet(`/dashboard/summary?${params.toString()}`, dashboardSummarySchema),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => apiGet('/settings', settingsResponseSchema),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsUpdate) => apiPatchNoContent('/settings', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
}

export function useUpdateVisitTypeValue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, estimatedValueCents }: { id: string; estimatedValueCents: number }) =>
      apiPatch(`/visit-types/${id}`, visitTypeSchema, { estimatedValueCents }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['visit-types'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
