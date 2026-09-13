import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('PATCH /api/intune/apps/[intuneAppId]/edit - instant path', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-edit-route-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.doMock('@/lib/auth-utils', () => ({
      parseAccessToken: async () => ({ userId: 'user-1', tenantId: 'tenant-1' }),
    }));
    vi.doMock('@/lib/intune/graph-client', () => ({
      getServicePrincipalToken: async () => 'fake-graph-token',
    }));
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('404s for an app with no upload_history row', async () => {
    const { PATCH } = await import('./route');
    const response = await PATCH(
      new Request('http://x/api/intune/apps/unknown-app/edit', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyType: 'ignore' }),
      }),
      { params: Promise.resolve({ intuneAppId: 'unknown-app' }) }
    );
    expect(response.status).toBe(404);
  });

  it('applies assignments/categories via Graph and policy/delayDays via DB, reporting per-field results', async () => {
    const { sqliteDb } = await import('@/lib/db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });

    vi.doMock('@/lib/intune-api', () => ({
      assignToGroups: vi.fn().mockResolvedValue(undefined),
      syncAppCategories: vi.fn().mockResolvedValue(undefined),
    }));

    const { PATCH } = await import('./route');
    const response = await PATCH(
      new Request('http://x/api/intune/apps/app-abc/edit', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignments: [{ '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }],
          categories: [{ id: 'cat-1' }],
          policyType: 'auto_update',
          delayDays: 3,
        }),
      }),
      { params: Promise.resolve({ intuneAppId: 'app-abc' }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.assignments).toBe('ok');
    expect(body.results.categories).toBe('ok');
    expect(body.results.policy).toBe('ok');

    const { sqliteUpdatePolicies } = await import('@/lib/db/sqlite');
    const policy = await sqliteUpdatePolicies.getByApp('user-1', 'tenant-1', 'Foxit.FoxitReader');
    expect(policy?.policy_type).toBe('auto_update');
    expect(policy?.delay_days).toBe(3);
  });

  it('reports a per-field failure without failing the whole request', async () => {
    const { sqliteDb } = await import('@/lib/db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });

    vi.doMock('@/lib/intune-api', () => ({
      assignToGroups: vi.fn().mockRejectedValue(new Error('Failed to assign app to groups')),
      syncAppCategories: vi.fn().mockResolvedValue(undefined),
    }));

    const { PATCH } = await import('./route');
    const response = await PATCH(
      new Request('http://x/api/intune/apps/app-abc/edit', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignments: [{ '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }],
          categories: [{ id: 'cat-1' }],
        }),
      }),
      { params: Promise.resolve({ intuneAppId: 'app-abc' }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.assignments).toEqual({ error: 'Failed to assign app to groups' });
    expect(body.results.categories).toBe('ok');
  });
});
