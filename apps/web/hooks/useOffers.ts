import {
  offerDetailResponseSchema,
  offerListResponseSchema,
  type OfferStatus,
} from '@slotfill/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPostNoContent } from '@/lib/api';

/** Offers move fast (first YES wins): poll every 10 s. */
const OFFERS_REFRESH_MS = 10_000;

export function useOffers(status: OfferStatus | undefined) {
  return useQuery({
    queryKey: ['offers', status ?? 'all'],
    queryFn: () => apiGet(`/offers${status ? `?status=${status}` : ''}`, offerListResponseSchema),
    refetchInterval: OFFERS_REFRESH_MS,
  });
}

export function useOffer(id: string | null) {
  return useQuery({
    queryKey: ['offers', 'detail', id],
    queryFn: () => apiGet(`/offers/${id ?? ''}`, offerDetailResponseSchema),
    enabled: id !== null,
    refetchInterval: OFFERS_REFRESH_MS,
  });
}

export function useCancelOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPostNoContent(`/offers/${id}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['offers'] }),
  });
}
