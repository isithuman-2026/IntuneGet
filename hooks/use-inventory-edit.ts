import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMicrosoftAuth } from './useMicrosoftAuth';
import type { Win32LobAppAssignment } from '@/types/intune';
import type { UpdatePolicyType } from '@/types/update-policies';

export interface EditAppInstantFields {
  assignments?: Win32LobAppAssignment[];
  categories?: { id: string }[];
  policyType?: UpdatePolicyType;
  delayDays?: number;
}

export interface EditAppResult {
  results: Record<string, 'ok' | { error: string }>;
}

export function useEditApp(intuneAppId: string) {
  const { getAccessToken } = useMicrosoftAuth();
  const queryClient = useQueryClient();

  return useMutation<EditAppResult, Error, EditAppInstantFields>({
    mutationFn: async (fields) => {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      const response = await fetch(`/api/intune/apps/${intuneAppId}/edit`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to save changes');
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory', 'app', intuneAppId] });
    },
  });
}
