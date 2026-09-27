import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs';

const {
  parseAccessTokenMock,
  getServerClientOrNullMock,
  resolveTargetTenantIdMock,
} = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  getServerClientOrNullMock: vi.fn(),
  resolveTargetTenantIdMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/supabase', () => ({
  getServerClientOrNull: getServerClientOrNullMock,
}));

vi.mock('@/lib/msp/tenant-resolution', () => ({
  resolveTargetTenantId: resolveTargetTenantIdMock,
}));

import { GET } from '@/app/api/intune/apps/deployed/route';

function createAwaitableUploadHistoryQuery(
  result: { data: unknown; error: unknown },
  operations: Array<{ method: string; args: unknown[] }>
) {
  const query: Record<string, unknown> = {};

  query.select = (...args: unknown[]) => {
    operations.push({ method: 'select', args });
    return query;
  };
  query.eq = (...args: unknown[]) => {
    operations.push({ method: 'eq', args });
    return query;
  };
  query.order = (...args: unknown[]) => {
    operations.push({ method: 'order', args });
    return query;
  };
  query.then = (resolve: (value: { data: unknown; error: unknown }) => unknown) =>
    Promise.resolve(result).then(resolve);

  return query;
}

describe('GET /api/intune/apps/deployed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns unique deployed winget IDs for authenticated user and tenant', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'tenant-home',
      userName: 'User',
    });

    const operations: Array<{ method: string; args: unknown[] }> = [];
    const uploadHistoryQuery = createAwaitableUploadHistoryQuery(
      {
        data: [
          { winget_id: 'Microsoft.Edge' },
          { winget_id: 'Microsoft.Edge' },
          { winget_id: 'Git.Git' },
        ],
        error: null,
      },
      operations
    );

    getServerClientOrNullMock.mockReturnValue({
      from: (table: string) => {
        if (table === 'upload_history') {
          return uploadHistoryQuery;
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    });

    resolveTargetTenantIdMock.mockResolvedValue({
      tenantId: 'tenant-home',
      errorResponse: null,
    });

    const request = new NextRequest('http://localhost:3000/api/intune/apps/deployed');
    request.headers.set('Authorization', 'Bearer test-token');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deployedWingetIds).toEqual(['Microsoft.Edge', 'Git.Git']);
    expect(body.count).toBe(2);
    expect(
      operations.some(
        (op) => op.method === 'eq' && op.args[0] === 'user_id' && op.args[1] === 'user-1'
      )
    ).toBe(true);
    expect(
      operations.some(
        (op) => op.method === 'eq' && op.args[0] === 'intune_tenant_id' && op.args[1] === 'tenant-home'
      )
    ).toBe(true);
  });

  it('applies tenant override via X-MSP-Tenant-Id', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'tenant-home',
      userName: 'User',
    });

    const uploadHistoryQuery = createAwaitableUploadHistoryQuery(
      { data: [], error: null },
      []
    );

    getServerClientOrNullMock.mockReturnValue({
      from: () => uploadHistoryQuery,
    });

    resolveTargetTenantIdMock.mockResolvedValue({
      tenantId: 'tenant-managed',
      errorResponse: null,
    });

    const request = new NextRequest('http://localhost:3000/api/intune/apps/deployed');
    request.headers.set('Authorization', 'Bearer test-token');
    request.headers.set('X-MSP-Tenant-Id', 'tenant-managed');

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(resolveTargetTenantIdMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tokenTenantId: 'tenant-home',
        requestedTenantId: 'tenant-managed',
      })
    );
  });

  it('returns 401 without valid auth', async () => {
    parseAccessTokenMock.mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/intune/apps/deployed');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('Authentication required');
  });

  it('returns resolver-provided 403 response for unauthorized tenant access', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'tenant-home',
      userName: 'User',
    });

    getServerClientOrNullMock.mockReturnValue({
      from: vi.fn(),
    });

    resolveTargetTenantIdMock.mockResolvedValue({
      tenantId: 'tenant-home',
      errorResponse: NextResponse.json(
        { error: 'Not authorized to access other tenants' },
        { status: 403 }
      ),
    });

    const request = new NextRequest('http://localhost:3000/api/intune/apps/deployed');
    request.headers.set('Authorization', 'Bearer test-token');
    request.headers.set('X-MSP-Tenant-Id', 'tenant-blocked');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe('Not authorized to access other tenants');
  });

  it('includes intuneAppId in tenant-scope deployments (Supabase)', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'tenant-home',
      userName: 'User',
    });

    const packagingJobsQuery = createAwaitableUploadHistoryQuery(
      {
        data: [
          { winget_id: 'Microsoft.Edge', user_email: 'teammate@example.com', intune_app_id: 'app-guid-1' },
        ],
        error: null,
      },
      []
    );

    getServerClientOrNullMock.mockReturnValue({
      from: (table: string) => {
        if (table === 'packaging_jobs') return packagingJobsQuery;
        throw new Error(`Unexpected table: ${table}`);
      },
    });

    resolveTargetTenantIdMock.mockResolvedValue({
      tenantId: 'tenant-home',
      errorResponse: null,
    });

    const request = new NextRequest('http://localhost:3000/api/intune/apps/deployed?scope=tenant');
    request.headers.set('Authorization', 'Bearer test-token');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tenantDeployments[0]).toEqual({
      wingetId: 'Microsoft.Edge',
      deployedBy: 'teammate@example.com',
      intuneAppId: 'app-guid-1',
    });
  });

  it('handles empty deployment history', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'tenant-home',
      userName: 'User',
    });

    const uploadHistoryQuery = createAwaitableUploadHistoryQuery(
      { data: [], error: null },
      []
    );

    getServerClientOrNullMock.mockReturnValue({
      from: () => uploadHistoryQuery,
    });

    resolveTargetTenantIdMock.mockResolvedValue({
      tenantId: 'tenant-home',
      errorResponse: null,
    });

    const request = new NextRequest('http://localhost:3000/api/intune/apps/deployed');
    request.headers.set('Authorization', 'Bearer test-token');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deployedWingetIds).toEqual([]);
    expect(body.count).toBe(0);
  });
});

describe('GET /api/intune/apps/deployed — SQLite mode dedupe (tenant scope)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-deployed-route-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.doMock('@/lib/auth-utils', () => ({
      parseAccessToken: async () => ({ userId: 'user-1', tenantId: 'tenant-1', userEmail: 'user@example.com' }),
    }));
    vi.doMock('@/lib/supabase', () => ({ getServerClientOrNull: () => null }));
    vi.doMock('@/lib/msp/tenant-resolution', () => ({ resolveTargetTenantId: vi.fn() }));
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    const { resetDatabaseInstance } = await import('@/lib/db');
    resetDatabaseInstance();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('returns only the newest deployed app when the same winget id has multiple deployed jobs', async () => {
    const { getDatabase } = await import('@/lib/db');
    // Oldest job first — the superseded app that must NOT win.
    // intune_app_id isn't an INSERT column on jobs.create (it's set once
    // the real Intune App ID is known, via a later update) — match that
    // here with an explicit update() rather than passing it to create().
    const oldJob = await getDatabase().jobs.create({
      user_id: 'user-1', tenant_id: 'tenant-1', winget_id: 'Microsoft.VisualStudioCode', version: '1.0.0',
      display_name: 'Microsoft Visual Studio Code', publisher: 'Microsoft', architecture: 'x64',
      installer_type: 'exe', installer_url: 'https://x/old.exe', install_command: 'x',
      uninstall_command: 'x', install_scope: 'machine', status: 'deployed',
    });
    await getDatabase().jobs.update(oldJob.id, { intune_app_id: 'old-app-id' });

    // A real delay, not a fake timer — created_at is a fresh
    // Date().toISOString() per insert, and the dedupe relies on it
    // actually differing between the two rows.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Newest job — the one currently live, must win.
    const newJob = await getDatabase().jobs.create({
      user_id: 'user-1', tenant_id: 'tenant-1', winget_id: 'Microsoft.VisualStudioCode', version: '1.0.0',
      display_name: 'Microsoft Visual Studio Code', publisher: 'Microsoft', architecture: 'x64',
      installer_type: 'exe', installer_url: 'https://x/new.exe', install_command: 'x',
      uninstall_command: 'x', install_scope: 'machine', status: 'deployed',
    });
    await getDatabase().jobs.update(newJob.id, { intune_app_id: 'new-app-id' });

    const { GET } = await import('./route');
    const response = await GET(
      new NextRequest('http://localhost:3000/api/intune/apps/deployed?scope=tenant', {
        headers: { Authorization: 'Bearer test-token' },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    const vscodeEntries = body.tenantDeployments.filter(
      (d: { wingetId: string }) => d.wingetId === 'Microsoft.VisualStudioCode'
    );
    expect(vscodeEntries).toHaveLength(1);
    expect(vscodeEntries[0].intuneAppId).toBe('new-app-id');
  });
});
