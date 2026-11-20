import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, allowedMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  allowedMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  verifyTokenIdentity: verifyMock,
  isTenantAllowed: allowedMock,
}));

import { GET } from '@/app/api/auth/access/route';

function req(): Request {
  return new Request('http://localhost/api/auth/access', { headers: { Authorization: 'Bearer a.b.c' } });
}

const identity = { userId: 'u1', userEmail: 'neo@example.com', tenantId: 't1', userName: 'Neo' };

describe('GET /api/auth/access', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without a verified identity', async () => {
    verifyMock.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authentication required' });
  });

  it('returns 200 for an allowed tenant', async () => {
    verifyMock.mockResolvedValue(identity);
    allowedMock.mockReturnValue(true);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true, displayName: 'Neo', upn: 'neo@example.com' });
  });

  it('returns 403 with reason tenant for another tenant', async () => {
    verifyMock.mockResolvedValue(identity);
    allowedMock.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ allowed: false, reason: 'tenant', upn: 'neo@example.com' });
    expect(allowedMock).toHaveBeenCalledWith('t1');
  });
});
