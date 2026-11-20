'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAccessCheck } from '@/hooks/useAccessCheck';
import { useMicrosoftAuth } from '@/hooks/useMicrosoftAuth';
import { AuthShell, AuthShellSpinner } from './AuthShell';
import { NotAuthorised } from './NotAuthorised';

/** Renders children only once the server confirms this account may use the app. */
export function AccessGate({ children }: { children: React.ReactNode }) {
  const { state, upn, reason, retry } = useAccessCheck();
  const { signOut } = useMicrosoftAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (state === 'signin') {
      router.replace('/auth/signin?callbackUrl=' + encodeURIComponent(pathname || '/dashboard'));
    }
  }, [state, router, pathname]);

  if (state === 'allowed') return <>{children}</>;
  if (state === 'denied') return <NotAuthorised upn={upn} reason={reason ?? 'tenant'} />;
  if (state === 'error') {
    return (
      <AuthShell subtitle="Internal deployment console">
        <p className="text-sm text-[#475569]" role="alert">
          Couldn&apos;t check your access. Try again.
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-6 h-11 w-full rounded-md bg-[#0e7490] px-4 text-sm font-medium text-white hover:bg-[#0c6680] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0e7490] focus-visible:ring-offset-2"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-3 h-11 w-full rounded-md border border-[#e2e8f0] bg-white px-4 text-sm font-medium text-[#0f172a] hover:bg-[#f4f6f8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0e7490] focus-visible:ring-offset-2"
        >
          Sign out
        </button>
      </AuthShell>
    );
  }
  return <AuthShellSpinner />;
}
