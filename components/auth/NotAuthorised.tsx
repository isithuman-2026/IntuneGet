'use client';

import { useMicrosoftAuth } from '@/hooks/useMicrosoftAuth';
import { AuthShell } from './AuthShell';

export function NotAuthorised({ upn }: { upn: string | null; reason: 'tenant' | 'not_assigned' }) {
  const { signInSelectAccount, signOut } = useMicrosoftAuth();

  return (
    <AuthShell subtitle="Internal deployment console">
      <h1 className="text-xl font-semibold">You don&apos;t have access</h1>
      <p className="mt-3 text-sm leading-6 text-[#475569]">
        You&apos;re signed in as {upn ?? 'this account'}, but this account isn&apos;t approved to use IntuneGet. Ask an
        administrator to add you to the IntuneGet admins group.
      </p>
      <div className="mt-6 flex flex-col gap-3">
        <button
          type="button"
          onClick={async () => {
            if (await signInSelectAccount()) window.location.reload();
          }}
          className="h-11 rounded-md bg-[#0e7490] px-4 text-sm font-medium text-white hover:bg-[#0c6680] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0e7490] focus-visible:ring-offset-2"
        >
          Sign in with a different account
        </button>
        <button
          type="button"
          onClick={() => void signOut()}
          className="h-11 rounded-md border border-[#e2e8f0] bg-white px-4 text-sm font-medium text-[#0f172a] hover:bg-[#f4f6f8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0e7490] focus-visible:ring-offset-2"
        >
          Sign out
        </button>
      </div>
    </AuthShell>
  );
}
