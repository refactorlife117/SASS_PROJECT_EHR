import { messageListResponseSchema } from '@slotfill/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPostNoContent } from '@/lib/api';

/** Message pages poll so replies show up without a reload. */
const MESSAGES_REFRESH_MS = 10_000;

export function useMessages(filters: { mobile?: string | undefined } = {}) {
  const params = new URLSearchParams({ limit: '300' });
  if (filters.mobile) params.set('mobile', filters.mobile);
  return useQuery({
    queryKey: ['messages', params.toString()],
    queryFn: () => apiGet(`/messages?${params.toString()}`, messageListResponseSchema),
    refetchInterval: MESSAGES_REFRESH_MS,
  });
}

export function useNeedsAttention() {
  return useQuery({
    queryKey: ['messages', 'needs-attention'],
    queryFn: () => apiGet('/messages/needs-attention', messageListResponseSchema),
    refetchInterval: MESSAGES_REFRESH_MS,
  });
}

export function useResolveMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPostNoContent(`/messages/${id}/resolve`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages'] }),
  });
}
