import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Settings } from '@el/shared';
import { api } from '../../lib/api';

/** 会话探针：GET /api/settings，401 即未登录 */
export const sessionKeys = {
  all: ['session'] as const,
};

export function useSession() {
  return useQuery({
    queryKey: sessionKeys.all,
    queryFn: () => api<Settings>('/api/settings'),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) =>
      api<{ ok: true }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.all });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      qc.clear();
    },
  });
}
