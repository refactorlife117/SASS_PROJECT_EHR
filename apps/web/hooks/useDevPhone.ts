// DEV ONLY: hooks for the /dev/phone simulator.
import { devSmsConversationsResponseSchema, devSmsInboundResponseSchema } from '@slotfill/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPostNoContent } from '@/lib/api';

const KEY = ['dev-phone', 'conversations'] as const;

export function useDevConversations() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiGet('/dev/sms/conversations', devSmsConversationsResponseSchema),
    // Outbound texts are delivered by the worker a moment after they're queued.
    refetchInterval: 2_000,
  });
}

export function useDevSendReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { from: string; body: string }) =>
      apiPost('/dev/sms/inbound', devSmsInboundResponseSchema, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDevSendTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (to: string) => apiPostNoContent('/dev/sms/send-test', { to }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}
