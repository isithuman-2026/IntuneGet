'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, Suspense, useCallback } from 'react';
import Link from 'next/link';
import { useReducedMotion } from 'framer-motion';
import { Loader2, AlertTriangle, Lock } from 'lucide-react';
import dynamic from 'next/dynamic';
import { T, Var } from "gt-next";
import { VerificationSceneFallback } from '@/components/auth/verification-scene/VerificationSceneFallback';
import { Button } from '@/components/ui/button';
import { useMicrosoftAuth } from '@/hooks/useMicrosoftAuth';
import { markOnboardingComplete, clearOnboardingCache } from '@/lib/onboarding-utils';
import { trackSigninClick } from '@/hooks/useLandingStats';
import { AuthShell } from '@/components/auth/AuthShell';
import { NotAuthorised } from '@/components/auth/NotAuthorised';
import { isNotAssignedError } from '@/lib/msal-errors';
import { version } from '../../../../package.json';
import {
  getSafeInternalRedirect,
  rememberPostAuthRedirect,
} from '@/lib/auth/post-auth-redirect';

const VerificationScene = dynamic(
  () => import('@/components/auth/verification-scene/VerificationScene').then(m => m.VerificationScene),
  { ssr: false, loading: () => <VerificationSceneFallback /> }
);

// Microsoft logo SVG component -- colors per official brand spec
function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 21 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

function SignInContent() {
  const { isAuthenticated, signIn, signInError, signOut, getAccessToken } = useMicrosoftAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const shouldReduceMotion = useReducedMotion();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isVerifyingConsent, setIsVerifyingConsent] = useState(false);
  const [verifyFailed, setVerifyFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callbackUrl = getSafeInternalRedirect(searchParams.get('callbackUrl'));
  /**
   * Verify consent status via API (server-side check). Returns the structured
   * result so the caller can distinguish a real consent gap (route to
   * onboarding, wipe cache) from a transient failure (keep cache, retry on
   * the dashboard).
   */
  type VerifyOutcome =
    | { kind: 'verified' }
    | { kind: 'consent_missing' }
    | { kind: 'transient' };

  const verifyConsentStatus = useCallback(async (): Promise<VerifyOutcome> => {
    try {
      const token = await getAccessToken();
      if (!token) return { kind: 'transient' };

      const response = await fetch('/api/auth/verify-consent', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) return { kind: 'transient' };

      const result = await response.json();
      if (result.verified === true) return { kind: 'verified' };

      // Only treat explicit consent-side failures as a reason to wipe the
      // cache and route to onboarding. Network/propagation/missing-credentials
      // are transient and must not invalidate a known-good local cache.
      if (
        result.error === 'consent_not_granted' ||
        result.error === 'insufficient_intune_permissions'
      ) {
        return { kind: 'consent_missing' };
      }
      return { kind: 'transient' };
    } catch {
      return { kind: 'transient' };
    }
  }, [getAccessToken]);

  // Run consent verification with a hard timeout so a hung token/popup
  // acquisition can never leave the user stuck on the loading animation.
  const runVerification = useCallback(() => {
    setVerifyFailed(false);
    setIsVerifyingConsent(true);

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Verification hung (commonly a blocked or backgrounded sign-in popup).
      // Surface a retry path instead of spinning forever.
      setIsVerifyingConsent(false);
      setVerifyFailed(true);
    }, 15000);

    verifyConsentStatus()
      .then((outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (outcome.kind === 'verified') {
          markOnboardingComplete();
          router.push(callbackUrl);
        } else if (outcome.kind === 'consent_missing') {
          clearOnboardingCache();
          rememberPostAuthRedirect(callbackUrl);
          router.push(`/onboarding?callbackUrl=${encodeURIComponent(callbackUrl)}`);
        } else {
          // Transient failure: don't wipe the cache and don't strand the user
          // on /onboarding. Send them to the dashboard, where the in-page
          // retry banner can re-verify against the live API.
          router.push(callbackUrl);
        }
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        setIsVerifyingConsent(false);
        setVerifyFailed(true);
      });
  }, [verifyConsentStatus, router, callbackUrl]);

  // Redirect based on ACTUAL consent status (server-verified, not localStorage)
  // This ensures users with revoked/incomplete consent are sent to onboarding
  useEffect(() => {
    if (isAuthenticated && !isVerifyingConsent && !verifyFailed) {
      runVerification();
    }
  }, [isAuthenticated, isVerifyingConsent, verifyFailed, runVerification]);

  const handleSignIn = async () => {
    // Track signin click (fire-and-forget)
    trackSigninClick();

    setIsSigningIn(true);
    setError(null);
    try {
      const success = await signIn();
      if (!success) {
        setError('Sign in was cancelled or failed. Please try again.');
      }
    } catch (err) {
      console.error('Sign in failed:', err);
      setError('An error occurred during sign in. Please try again.');
    } finally {
      setIsSigningIn(false);
    }
  };

  if (isNotAssignedError(signInError)) {
    return <NotAuthorised reason="not_assigned" upn={null} />;
  }

  // Verification hung or failed -- never leave the user on an endless animation.
  if (verifyFailed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-deepest px-4">
        <div className="w-full max-w-md rounded-2xl border border-overlay/[0.08] bg-bg-elevated/95 p-8 text-center shadow-soft-lg">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10">
            <AlertTriangle className="h-7 w-7 text-amber-500" />
          </div>
          <h2 className="text-xl font-bold text-text-primary">
            <T>Sign-in is taking longer than expected</T>
          </h2>
          <p className="mt-2 text-sm text-text-muted">
            <T>We couldn&apos;t finish verifying your session. This can happen when a sign-in popup is blocked or closed before it completes.</T>
          </p>
          <div className="mt-6 flex flex-col gap-3">
            <Button onClick={runVerification} size="lg" className="w-full">
              <T>Try again</T>
            </Button>
            <Button
              onClick={() => { void signOut(); }}
              variant="outline"
              size="lg"
              className="w-full border-overlay/15 text-text-secondary"
            >
              <T>Sign out and start over</T>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Show loading state while checking auth or verifying consent
  if (isAuthenticated || isVerifyingConsent) {
    const statusText = isVerifyingConsent ? 'Verifying permissions...' : 'Redirecting to your dashboard...';
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-deepest">
        {shouldReduceMotion ? (
          <VerificationSceneFallback statusText={statusText} />
        ) : (
          <VerificationScene statusText={statusText} />
        )}
      </div>
    );
  }

  return (
    <AuthShell subtitle="Internal deployment console">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-3 text-sm leading-6 text-[#475569]">
        Use your work account. Access is limited to approved administrators in your organisation.
      </p>
      {error && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handleSignIn}
        disabled={isSigningIn}
        className="mt-6 flex h-11 w-full items-center justify-center gap-3 rounded-md bg-[#0e7490] px-4 text-sm font-medium text-white hover:bg-[#0c6680] disabled:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0e7490] focus-visible:ring-offset-2"
      >
        {isSigningIn ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MicrosoftLogo className="h-4 w-4" />}
        Sign in with Microsoft
      </button>
      <p className="mt-5 flex items-start gap-2 text-xs leading-5 text-[#475569]">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Sign-in is handled by Microsoft Entra ID. IntuneGet never sees your password.
      </p>
      <div className="mt-6 flex justify-between border-t border-[#e2e8f0] pt-4 text-xs text-[#475569]">
        <Link href="/about" className="hover:text-[#0e7490]">
          About
        </Link>
        <span>v{version}</span>
      </div>
    </AuthShell>
  );
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-bg-deepest">
          <Loader2 className="h-8 w-8 animate-spin text-accent-cyan" />
        </div>
      }
    >
      <SignInContent />
    </Suspense>
  );
}
