// DEV ONLY: hooks for the mock EHR controls.
import {
  devEhrStateResponseSchema,
  type DevEhrCreateAppointment,
  type DevEhrMoveAppointment,
} from '@slotfill/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet, apiPost, apiPostNoContent } from '@/lib/api';

const STATE_KEY = ['dev-ehr', 'state'] as const;

export function useDevEhrState() {
  return useQuery({
    queryKey: STATE_KEY,
    queryFn: () => apiGet('/dev/ehr/state', devEhrStateResponseSchema),
    refetchInterval: 5_000,
  });
}

/** After a mock-EHR change, refresh the mock view now and SlotFill's appointments soon after. */
function useInvalidateAfterChange() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: STATE_KEY });
    // The simulated webhook enqueues a sync; give the worker a moment before refetching.
    setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
    }, 2_000);
  };
}

export function useDevEhrCancel() {
  const onSuccess = useInvalidateAfterChange();
  return useMutation({
    mutationFn: (id: string) => apiPostNoContent(`/dev/ehr/appointments/${id}/cancel`),
    onSuccess,
  });
}

export function useDevEhrMove() {
  const onSuccess = useInvalidateAfterChange();
  return useMutation({
    mutationFn: ({ id, ...body }: DevEhrMoveAppointment & { id: string }) =>
      apiPostNoContent(`/dev/ehr/appointments/${id}/move`, body),
    onSuccess,
  });
}

export function useDevEhrCreate() {
  const onSuccess = useInvalidateAfterChange();
  return useMutation({
    mutationFn: (body: DevEhrCreateAppointment) =>
      apiPost('/dev/ehr/appointments', z.object({ id: z.uuid() }), body),
    onSuccess,
  });
}

export function useDevEhrSyncNow() {
  const onSuccess = useInvalidateAfterChange();
  return useMutation({ mutationFn: () => apiPostNoContent('/dev/ehr/sync'), onSuccess });
}
