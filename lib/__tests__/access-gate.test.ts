import { describe, expect, it } from 'vitest';
import { decideGate } from '../access-gate';

const base = { msalReady: true, isAuthenticated: true, isSigningOut: false, accessStatus: null, fetchFailed: false };

describe('decideGate', () => {
  it('waits while MSAL is not ready', () => {
    expect(decideGate({ ...base, msalReady: false, isAuthenticated: false })).toBe('loading');
  });
  it('sends signed-out users to sign-in', () => {
    expect(decideGate({ ...base, isAuthenticated: false })).toBe('signin');
  });
  it('waits while signing out', () => {
    expect(decideGate({ ...base, isAuthenticated: false, isSigningOut: true })).toBe('loading');
  });
  it('waits for the access check', () => {
    expect(decideGate(base)).toBe('loading');
  });
  it('allows on 200', () => {
    expect(decideGate({ ...base, accessStatus: 200 })).toBe('allowed');
  });
  it('denies on 403 instead of redirecting to sign-in', () => {
    expect(decideGate({ ...base, accessStatus: 403 })).toBe('denied');
  });
  it('shows a retryable error on 401 while MSAL is signed in (sign-in page would bounce straight back)', () => {
    expect(decideGate({ ...base, accessStatus: 401 })).toBe('error');
  });
  it('shows an error on 5xx', () => {
    expect(decideGate({ ...base, accessStatus: 500 })).toBe('error');
  });
  it('shows an error when the request fails', () => {
    expect(decideGate({ ...base, fetchFailed: true })).toBe('error');
  });
});
