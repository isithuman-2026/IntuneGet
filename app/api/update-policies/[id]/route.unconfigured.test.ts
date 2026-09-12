import { NextRequest } from 'next/server';

const { parseAccessTokenMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
}));

// Regression test: same guarantee as
// app/api/update-policies/route.unconfigured.test.ts, for the [id] routes.
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

import { GET, PATCH, DELETE } from '@/app/api/update-policies/[id]/route';

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('unauthenticated + not SQLite + Supabase unconfigured: /api/update-policies/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET returns the original null-policy response without requiring auth', async () => {
    const request = new NextRequest('http://localhost:3000/api/update-policies/some-id');
    const response = await GET(request, makeParams('some-id'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ policy: null });
    expect(parseAccessTokenMock).not.toHaveBeenCalled();
  });

  it('PATCH returns the original 503 without requiring auth', async () => {
    const request = new NextRequest('http://localhost:3000/api/update-policies/some-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_enabled: false }),
    });
    const response = await PATCH(request, makeParams('some-id'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'Auto-update policies require hosted services' });
    expect(parseAccessTokenMock).not.toHaveBeenCalled();
  });

  it('DELETE returns the original 503 without requiring auth', async () => {
    const request = new NextRequest('http://localhost:3000/api/update-policies/some-id', { method: 'DELETE' });
    const response = await DELETE(request, makeParams('some-id'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'Auto-update policies require hosted services' });
    expect(parseAccessTokenMock).not.toHaveBeenCalled();
  });
});
