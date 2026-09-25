import { useQuery } from '@tanstack/react-query';
import type { StatsResponse } from '@el/shared';
import { api } from '../../lib/api';

// ---------- query keys ----------

export const statsKeys = {
  all: ['stats'] as const,
};

// ---------- 请求函数（契约：packages/shared/src/schemas/api/stats.ts，已冻结）----------

export function fetchStats(): Promise<StatsResponse> {
  return api<StatsResponse>('/api/stats');
}

// ---------- hooks ----------

export function useStats() {
  return useQuery({ queryKey: ['stats'], queryFn: fetchStats });
}
