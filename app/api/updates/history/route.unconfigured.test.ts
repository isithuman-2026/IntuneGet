import { NextRequest } from 'next/server';

const { parseAccessTokenMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
}));

// Regression test: an unauthenticated request against a deployment that is
// neither SQLite mode nor Supabase-configured must still get the ORIGINAL
// response (401, since auth is checked before either mode guard in this
// route) - unchanged by the new isSqliteMode() branch.
vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
  isSupabaseServerConfigured: () => false,
}));

vi.mock('@/lib/db', () => ({
  isSqliteMode: () => false,
}));

import { GET } from '@/app/api/updates/history/route';

describe('unauthenticated + not SQLite + Supabase unconfigured: GET /api/updates/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseAccessTokenMock.mockResolvedValue(null);
  });

  it('returns the original 401 unauthenticated response', async () => {
    const request = new NextRequest('http://localhost:3000/api/updates/history', {
      headers: {},
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: 'Authentication required' });
  });
});
