import { NextRequest } from 'next/server';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { parseAccessTokenMock, getServerClientOrNullMock, acquireGraphTokenMock, listEspProfilesMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  getServerClientOrNullMock: vi.fn(),
  acquireGraphTokenMock: vi.fn(),
  listEspProfilesMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({ parseAccessToken: parseAccessTokenMock }));
vi.mock('@/lib/supabase', () => ({ getServerClientOrNull: getServerClientOrNullMock }));
vi.mock('@/lib/graph-token', () => ({ acquireGraphToken: acquireGraphTokenMock }));
vi.mock('@/lib/esp-api', () => ({ listEspProfiles: listEspProfilesMock }));

import { GET } from '@/app/api/intune/esp-profiles/route';

// Self-hosted SQLite mode (no Supabase): the route skips the tenant_consent
// check and lists ESP profiles from Graph with the app-only token
// (b6d59f0c2). It used to return an empty list without Supabase.
describe('GET /api/intune/esp-profiles (no Supabase)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseAccessTokenMock.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-1', userEmail: 'user@example.com' });
    getServerClientOrNullMock.mockReturnValue(null);
  });

  it('lists ESP profiles from Graph for the caller tenant', async () => {
    acquireGraphTokenMock.mockResolvedValue({ accessToken: 'tok', expiresIn: 3600 });
    listEspProfilesMock.mockResolvedValue([{ id: 'esp-1', displayName: 'Default ESP' }]);

    const response = await GET(new NextRequest('http://localhost/api/intune/esp-profiles'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ profiles: [{ id: 'esp-1', displayName: 'Default ESP' }], count: 1 });
    expect(acquireGraphTokenMock).toHaveBeenCalledWith('tenant-1');
    expect(listEspProfilesMock).toHaveBeenCalledWith('tok');
  });

  it('returns 500 with a clear error when no Graph token can be acquired', async () => {
    acquireGraphTokenMock.mockRejectedValue(new Error('Token acquisition failed (invalid_client)'));

    const response = await GET(new NextRequest('http://localhost/api/intune/esp-profiles'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to get Graph API token' });
    expect(listEspProfilesMock).not.toHaveBeenCalled();
  });

  it('401s without a valid access token', async () => {
    parseAccessTokenMock.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://localhost/api/intune/esp-profiles'));
    expect(response.status).toBe(401);
  });
});
