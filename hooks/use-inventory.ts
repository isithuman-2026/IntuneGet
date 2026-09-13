'use client';

import { useQuery } from '@tanstack/react-query';
import { useMicrosoftAuth } from './useMicrosoftAuth';
import { useMspOptional } from './useMspOptional';
import type { IntuneWin32App, IntuneAppWithAssignments } from '@/types/inventory';

interface InventoryResponse {
  apps: IntuneWin32App[];
  count: number;
}

interface AppDetailsResponse {
  app: IntuneAppWithAssignments;
  hasUploadHistory: boolean;
}

export function useInventoryApps() {
  const { getAccessToken, isAuthenticated } = useMicrosoftAuth();
  const { isMspUser, selectedTenantId } = useMspOptional();

  return useQuery<InventoryResponse>({
    queryKey: ['inventory', 'apps', isMspUser ? selectedTenantId || 'primary' : 'self'],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch('/api/intune/apps', {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(isMspUser && selectedTenantId ? { 'X-MSP-Tenant-Id': selectedTenantId } : {}),
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch inventory');
      }

      return response.json();
    },
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useAppDetails(appId: string | null) {
  const { getAccessToken, isAuthenticated } = useMicrosoftAuth();
  const { isMspUser, selectedTenantId } = useMspOptional();

  return useQuery<AppDetailsResponse>({
    queryKey: ['inventory', 'app', appId, isMspUser ? selectedTenantId || 'primary' : 'self'],
    queryFn: async () => {
      if (!appId) {
        throw new Error('No app ID provided');
      }

      const token = await getAccessToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(`/api/intune/apps/${appId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(isMspUser && selectedTenantId ? { 'X-MSP-Tenant-Id': selectedTenantId } : {}),
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch app details');
      }

      return response.json();
    },
    enabled: isAuthenticated && !!appId,
    staleTime: 2 * 60 * 1000, // 2 minutes
  });
}
