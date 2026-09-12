import { NextRequest } from 'next/server';

const { parseAccessTokenMock, runUpdateCheckMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  runUpdateCheckMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/db', () => ({
  isSqliteMode: () => true,
}));

vi.mock('@/lib/auto-update/check-updates', () => ({
  runUpdateCheck: runUpdateCheckMock,
}));

import { POST } from '@/app/api/updates/refresh/route';

describe('SQLite mode: POST /api/updates/refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'home-tenant',
      userName: 'User',
    });
  });

  it('runs runUpdateCheck() synchronously and shapes the response', async () => {
    runUpdateCheckMock.mockResolvedValue({
      usersChecked: 2,
      updatesFound: 3,
      autoUpdates: { triggered: 1, skipped: 0, failed: 0 },
      errors: [],
    });

    const request = new NextRequest('http://localhost:3000/api/updates/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(runUpdateCheckMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      refreshedCount: 3,
      removedCount: 0,
      updateCount: 3,
      matchingSummary: { totalChecked: 2, noMatch: 0, lowConfidenceSkipped: 0, packageNotInCache: 0 },
    });
  });

  it('surfaces errors from runUpdateCheck() and reports success: false', async () => {
    runUpdateCheckMock.mockResolvedValue({
      usersChecked: 1,
      updatesFound: 0,
      autoUpdates: { triggered: 0, skipped: 0, failed: 0 },
      errors: ['boom'],
    });

    const request = new NextRequest('http://localhost:3000/api/updates/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await (await POST(request)).json();

    expect(body.success).toBe(false);
    expect(body.errors).toEqual(['boom']);
  });

  it('still requires auth in SQLite mode', async () => {
    parseAccessTokenMock.mockResolvedValue(null);
    const request = new NextRequest('http://localhost:3000/api/updates/refresh', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(runUpdateCheckMock).not.toHaveBeenCalled();
  });
});
