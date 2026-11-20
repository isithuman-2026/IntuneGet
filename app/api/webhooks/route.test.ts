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

describe('POST /api/webhooks (SQLite mode)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-webhooks-route-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    parseAccessTokenMock.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-1' });
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    delete process.env.DATABASE_PATH;
  });

  const post = async (POST: (r: NextRequest) => Promise<Response>) =>
    POST(new NextRequest('http://x/api/webhooks', {
      method: 'POST',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alerts', url: 'https://discord.com/api/webhooks/1/abc' }),
    }));

  it('rejects a second webhook with the same URL so notifications are not sent twice', async () => {
    const { POST } = await import('./route');
    expect((await post(POST)).status).toBe(201);
    expect((await post(POST)).status).toBe(409);
  });
});
