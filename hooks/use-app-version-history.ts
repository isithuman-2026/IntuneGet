import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMicrosoftAuth } from './useMicrosoftAuth';

export interface AppVersion {
  id: string;
  version: string;
  status: string;
  completed_at: string | null;
}

export function useAppVersionHistory(intuneAppId: string | null) {
  const { getAccessToken } = useMicrosoftAuth();
  return useQuery<{ versions: AppVersion[] }>({
    queryKey: ['inventory', 'app-versions', intuneAppId],
    enabled: !!intuneAppId,
    queryFn: async () => {
      const token = await getAccessToken();
      const response = await fetch(`/api/intune/apps/${intuneAppId}/versions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Failed to load version history');
      return response.json();
    },
  });
}

export function useRollbackApp(intuneAppId: string) {
  const { getAccessToken } = useMicrosoftAuth();
  const queryClient = useQueryClient();
  return useMutation<{ packagingJobId: string }, Error, { packagingJobId: string }>({
    mutationFn: async ({ packagingJobId }) => {
      const token = await getAccessToken();
      const response = await fetch(`/api/intune/apps/${intuneAppId}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ packagingJobId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Rollback failed');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory', 'app', intuneAppId] });
    },
  });
}
