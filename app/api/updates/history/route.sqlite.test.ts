import { NextRequest } from 'next/server';

const { parseAccessTokenMock, listByUserMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  listByUserMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/db', () => ({
  isSqliteMode: () => true,
}));

vi.mock('@/lib/db/sqlite', () => ({
  sqliteAutoUpdateHistory: { listByUser: listByUserMock },
}));

import { GET } from '@/app/api/updates/history/route';

function makeRequest(query = '') {
  return new NextRequest(`http://localhost:3000/api/updates/history${query}`, {
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('SQLite mode: GET /api/updates/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'home-tenant',
      userName: 'User',
    });
  });

  it('returns an empty list when there is no history yet', async () => {
    listByUserMock.mockResolvedValue([]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body).toEqual({ history: [], count: 0, hasMore: false });
    expect(listByUserMock).toHaveBeenCalledWith('user-1', {
      tenantId: undefined,
      wingetId: undefined,
      status: undefined,
      limit: 50,
      offset: 0,
    });
  });

  it('passes through tenant_id, winget_id, status, limit and offset filters', async () => {
    listByUserMock.mockResolvedValue([]);

    await GET(makeRequest('?tenant_id=tenant-a&winget_id=Microsoft.Edge&status=completed&limit=10&offset=5'));

    expect(listByUserMock).toHaveBeenCalledWith('user-1', {
      tenantId: 'tenant-a',
      wingetId: 'Microsoft.Edge',
      status: 'completed',
      limit: 10,
      offset: 5,
    });
  });

  it('drops an invalid status filter', async () => {
    listByUserMock.mockResolvedValue([]);

    await GET(makeRequest('?status=bogus'));

    expect(listByUserMock).toHaveBeenCalledWith('user-1', expect.objectContaining({ status: undefined }));
  });

  it('sets hasMore when the result page is full', async () => {
    const row = {
      id: 'h1', policy_id: 'p1', packaging_job_id: 'j1', from_version: '1.0', to_version: '1.1',
      update_type: 'minor', status: 'completed', error_message: null, triggered_at: '2026-09-12T00:00:00Z',
      completed_at: '2026-09-12T00:05:00Z', policy: { winget_id: 'Microsoft.Edge', tenant_id: 'tenant-a' },
      display_name: 'Edge',
    };
    listByUserMock.mockResolvedValue([row]);

    const response = await GET(makeRequest('?limit=1'));
    const body = await response.json();

    expect(body).toEqual({ history: [row], count: 1, hasMore: true });
  });

  it('still requires auth in SQLite mode', async () => {
    parseAccessTokenMock.mockResolvedValue(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(listByUserMock).not.toHaveBeenCalled();
  });
});
