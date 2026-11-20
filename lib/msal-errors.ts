/** True when Entra refused sign-in because the user isn't assigned to the app (AADSTS50105). */
export function isNotAssignedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { errorCode?: unknown; subError?: unknown; message?: unknown };
  return [e.errorCode, e.subError, e.message].some((v) => typeof v === 'string' && v.includes('AADSTS50105'));
}
