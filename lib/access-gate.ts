export type GateState = 'loading' | 'signin' | 'denied' | 'error' | 'allowed';

/** Decides what the app area shows, from MSAL state and the /api/auth/access result. */
export function decideGate(input: {
  msalReady: boolean;
  isAuthenticated: boolean;
  isSigningOut: boolean;
  accessStatus: number | null;
  fetchFailed: boolean;
}): GateState {
  if (!input.msalReady || input.isSigningOut) return 'loading';
  if (!input.isAuthenticated) return 'signin';
  if (input.fetchFailed) return 'error';
  if (input.accessStatus === null) return 'loading';
  if (input.accessStatus === 200) return 'allowed';
  // 403 must never become 'signin': a signed-in but disallowed user would loop.
  if (input.accessStatus === 403) return 'denied';
  // 401 while MSAL is signed in: the sign-in page would send the user straight back here,
  // so show the retry/sign-out screen instead of looping.
  return 'error';
}
