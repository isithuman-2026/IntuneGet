'use client';

import { useQuery } from '@tanstack/react-query';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { useMicrosoftAuth } from '@/hooks/useMicrosoftAuth';
import { decideGate, type GateState } from '@/lib/access-gate';

interface AccessResult {
  status: number;
  upn: string | null;
  reason: 'tenant' | null;
}

export function useAccessCheck(): {
  state: GateState;
  upn: string | null;
  reason: 'tenant' | 'not_assigned' | null;
  retry: () => void;
} {
  const { inProgress } = useMsal();
  const { isAuthenticated, isSigningOut, getAccessToken } = useMicrosoftAuth();
  const msalReady = inProgress === InteractionStatus.None;

  const query = useQuery<AccessResult>({
    queryKey: ['auth', 'access'],
    enabled: msalReady && isAuthenticated && !isSigningOut,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return { status: 401, upn: null, reason: null };
      const res = await fetch('/api/auth/access', { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      return {
        status: res.status,
        upn: typeof body.upn === 'string' ? body.upn : null,
        reason: body.reason === 'tenant' ? 'tenant' : null,
      };
    },
  });

  const state = decideGate({
    msalReady,
    isAuthenticated,
    isSigningOut,
    accessStatus: query.data?.status ?? null,
    fetchFailed: query.isError,
  });

  return {
    state,
    upn: query.data?.upn ?? null,
    reason: query.data?.reason ?? null,
    retry: () => {
      void query.refetch();
    },
  };
}
