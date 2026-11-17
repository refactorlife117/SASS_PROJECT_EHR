import {
  patientSearchResponseSchema,
  visitTypeListResponseSchema,
  waitlistEntrySchema,
  waitlistListResponseSchema,
  type WaitlistCreate,
  type WaitlistStatus,
  type WaitlistUpdate,
} from '@slotfill/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost, apiDeleteNoContent } from '@/lib/api';

export function useWaitlist(status: WaitlistStatus) {
  return useQuery({
    queryKey: ['waitlist', status],
    queryFn: () => apiGet(`/waitlist?status=${status}`, waitlistListResponseSchema),
    refetchInterval: 15_000,
  });
}

function useInvalidateWaitlist() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['waitlist'] });
}

export function useAddToWaitlist() {
  const onSuccess = useInvalidateWaitlist();
  return useMutation({
    mutationFn: (body: WaitlistCreate) => apiPost('/waitlist', waitlistEntrySchema, body),
    onSuccess,
  });
}

export function useUpdateWaitlist() {
  const onSuccess = useInvalidateWaitlist();
  return useMutation({
    mutationFn: ({ id, ...body }: WaitlistUpdate & { id: string }) =>
      apiPatch(`/waitlist/${id}`, waitlistEntrySchema, body),
    onSuccess,
  });
}

export function useRemoveFromWaitlist() {
  const onSuccess = useInvalidateWaitlist();
  return useMutation({
    mutationFn: (id: string) => apiDeleteNoContent(`/waitlist/${id}`),
    onSuccess,
  });
}

export function usePatientSearch(search: string) {
  const term = search.trim();
  return useQuery({
    queryKey: ['patients', term],
    queryFn: () =>
      apiGet(`/patients?search=${encodeURIComponent(term)}`, patientSearchResponseSchema),
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
  });
}

export function useVisitTypes() {
  return useQuery({
    queryKey: ['visit-types'],
    queryFn: () => apiGet('/visit-types', visitTypeListResponseSchema),
  });
}
