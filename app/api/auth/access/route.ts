import { NextResponse } from 'next/server';
import { isTenantAllowed, verifyTokenIdentity } from '@/lib/auth-utils';

export const dynamic = 'force-dynamic';

/** Tells the client whether the signed-in account may use the app. */
export async function GET(request: Request) {
  const identity = await verifyTokenIdentity(request.headers.get('authorization'));
  if (!identity) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const upn = identity.userEmail || null;
  if (!isTenantAllowed(identity.tenantId)) {
    return NextResponse.json({ allowed: false, reason: 'tenant', upn }, { status: 403 });
  }

  return NextResponse.json({ allowed: true, displayName: identity.userName, upn });
}
