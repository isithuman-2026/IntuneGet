import { NextRequest } from 'next/server';

const { parseAccessTokenMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
}));

// Regression test: for an unauthenticated request against a self-hosted
// deployment that is in neither SQLite mode nor has Supabase configured,
// the ORIGINAL (pre-isSqliteMode-branch) response must be preserved
// unchanged. parseAccessToken must not even be reached in this case, since
// both guards short-circuit before it in the untouched Supabase code path.
vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
  isSupabaseServerConfigured: () => false,
}));

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(),
  isSqliteMode: () => false,
}));

import { GET, POST } from '@/app/api/update-policies/route';

describe('unauthenticated + not SQLite + Supabase unconfigured: /api/update-policies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET returns the original empty-list response without requiring auth', async () => {
    const request = new NextRequest('http://localhost:3000/api/update-policies');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ policies: [], count: 0 });
    expect(parseAccessTokenMock).not.toHaveBeenCalled();
  });

  it('POST returns the original 503 without requiring auth', async () => {
    const request = new NextRequest('http://localhost:3000/api/update-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1', policy_type: 'notify' }),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'Auto-update policies require hosted services' });
    expect(parseAccessTokenMock).not.toHaveBeenCalled();
  });
});
