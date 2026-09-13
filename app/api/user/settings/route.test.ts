import { NextRequest } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs';

const { parseAccessTokenMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

describe('GET/PATCH /api/user/settings (SQLite mode)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-user-settings-route-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.clearAllMocks();
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    delete process.env.DATABASE_PATH;
  });

  it('GET returns defaults with hasStoredSettings false when nothing saved', async () => {
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://x/api/user/settings', {
      headers: { Authorization: 'Bearer x' },
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.settings.carryOverAssignments).toBe(false);
    expect(body.settings.supersedePreviousApp).toBe(false);
    expect(body.hasStoredSettings).toBe(false);
  });

  it('PATCH saves and GET reflects it (no 503)', async () => {
    const { PATCH, GET } = await import('./route');
    const patchResponse = await PATCH(new NextRequest('http://x/api/user/settings', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ carryOverAssignments: true, supersedePreviousApp: true }),
    }));
    expect(patchResponse.status).toBe(200);
    const patchBody = await patchResponse.json();
    expect(patchBody.settings.carryOverAssignments).toBe(true);
    expect(patchBody.hasStoredSettings).toBe(true);

    const getResponse = await GET(new NextRequest('http://x/api/user/settings', {
      headers: { Authorization: 'Bearer x' },
    }));
    const getBody = await getResponse.json();
    expect(getBody.settings.supersedePreviousApp).toBe(true);
    expect(getBody.hasStoredSettings).toBe(true);
  });
});
