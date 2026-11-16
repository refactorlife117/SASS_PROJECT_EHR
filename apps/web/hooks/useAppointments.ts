import {
  appointmentListResponseSchema,
  providerListResponseSchema,
  type AppointmentStatus,
} from '@slotfill/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface AppointmentFilters {
  from: Date;
  to: Date;
  providerId?: string | undefined;
  status?: AppointmentStatus | undefined;
}

/** Polls so EHR changes picked up by sync appear without a reload. */
const APPOINTMENTS_REFRESH_MS = 15_000;

export function useAppointments(filters: AppointmentFilters) {
  const params = new URLSearchParams({
    from: filters.from.toISOString(),
    to: filters.to.toISOString(),
  });
  if (filters.providerId) params.set('providerId', filters.providerId);
  if (filters.status) params.set('status', filters.status);

  return useQuery({
    queryKey: ['appointments', params.toString()],
    queryFn: () => apiGet(`/appointments?${params.toString()}`, appointmentListResponseSchema),
    refetchInterval: APPOINTMENTS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => apiGet('/providers', providerListResponseSchema),
  });
}
