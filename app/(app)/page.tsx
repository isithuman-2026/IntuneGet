'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { AuthShellSpinner } from '@/components/auth/AuthShell';

/** Front door: signed-in users go to the dashboard, everyone else to sign-in. */
export default function FrontDoor() {
  const { inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const router = useRouter();

  useEffect(() => {
    if (inProgress !== InteractionStatus.None) return;
    router.replace(isAuthenticated ? '/dashboard' : '/auth/signin');
  }, [inProgress, isAuthenticated, router]);

  return <AuthShellSpinner />;
}
