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

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('SQLite mode: GET/PATCH/DELETE /api/update-policies/[id]', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-policy-id-sqlite-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.clearAllMocks();
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'home-tenant',
      userName: 'User',
    });
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    delete process.env.DATABASE_PATH;
  });

  it('GET returns the policy when it belongs to the user, 404 otherwise', async () => {
    const { sqliteUpdatePolicies } = await import('@/lib/db/sqlite');
    const { policy } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1', policy_type: 'notify',
    });

    const { GET } = await import('@/app/api/update-policies/[id]/route');
    const request = new NextRequest(`http://localhost:3000/api/update-policies/${policy.id}`);
    request.headers.set('Authorization', 'Bearer test-token');

    const found = await GET(request, makeParams(policy.id));
    expect(found.status).toBe(200);
    expect((await found.json()).policy.winget_id).toBe('Microsoft.Edge');

    const missing = await GET(request, makeParams('does-not-exist'));
    expect(missing.status).toBe(404);
  });

  it('PATCH updates an existing policy and validates pin_version/auto_update constraints', async () => {
    const { sqliteUpdatePolicies } = await import('@/lib/db/sqlite');
    const { policy } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1', policy_type: 'notify',
    });

    const { PATCH } = await import('@/app/api/update-policies/[id]/route');

    const badRequest = new NextRequest(`http://localhost:3000/api/update-policies/${policy.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy_type: 'pin_version' }),
    });
    const badResponse = await PATCH(badRequest, makeParams(policy.id));
    expect(badResponse.status).toBe(400);
    expect((await badResponse.json()).error).toContain('pinned_version');

    const okRequest = new NextRequest(`http://localhost:3000/api/update-policies/${policy.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy_type: 'pin_version', pinned_version: '1.2.3' }),
    });
    const okResponse = await PATCH(okRequest, makeParams(policy.id));
    const okBody = await okResponse.json();
    expect(okResponse.status).toBe(200);
    expect(okBody.policy.policy_type).toBe('pin_version');
    expect(okBody.policy.pinned_version).toBe('1.2.3');

    const missingRequest = new NextRequest('http://localhost:3000/api/update-policies/nope', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_enabled: false }),
    });
    const missingResponse = await PATCH(missingRequest, makeParams('nope'));
    expect(missingResponse.status).toBe(404);
  });

  it('DELETE removes an existing policy, 404 for a missing one', async () => {
    const { sqliteUpdatePolicies } = await import('@/lib/db/sqlite');
    const { policy } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1', policy_type: 'ignore',
    });

    const { DELETE } = await import('@/app/api/update-policies/[id]/route');
    const request = new NextRequest(`http://localhost:3000/api/update-policies/${policy.id}`, { method: 'DELETE' });
    request.headers.set('Authorization', 'Bearer test-token');

    const response = await DELETE(request, makeParams(policy.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, deleted: true });

    expect((await sqliteUpdatePolicies.getById(policy.id, 'user-1'))).toBeNull();

    const missingResponse = await DELETE(request, makeParams(policy.id));
    expect(missingResponse.status).toBe(404);
  });
});
