import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const { sendEmailMock, isEmailConfiguredMock, deliverWebhookMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  isEmailConfiguredMock: vi.fn(),
  deliverWebhookMock: vi.fn(),
}));

vi.mock('@/lib/email/service', () => ({
  sendUpdateNotificationEmail: sendEmailMock,
  isEmailConfigured: isEmailConfiguredMock,
}));
vi.mock('@/lib/webhooks/service', () => ({
  deliverWebhook: deliverWebhookMock,
}));

import { notifyUserOfPendingUpdates } from '@/lib/notifications/notify-user';

// Minimal chainable Supabase stub. Per-table results; webhook_configurations is
// awaited as a thenable list, prefs/profile via maybeSingle.
function makeSupabase(tables: Record<string, unknown>, calls: { markNotified: string[][]; histInserts: string[] }) {
  function builder(table: string) {
    const b: any = {
      select: () => b,
      eq: () => b,
      is: () => b,
      order: () => b,
      maybeSingle: () => Promise.resolve({ data: tables[table] ?? null, error: null }),
      insert: (row: any) => { if (table === 'notification_history') calls.histInserts.push(row.status); return Promise.resolve({ data: null, error: null }); },
      update: () => ({
        eq: () => Promise.resolve({ data: null, error: null }),
        in: (_c: string, ids: string[]) => { if (table === 'update_check_results') calls.markNotified.push(ids); return Promise.resolve({ data: null, error: null }); },
      }),
      then: (res: any) => res({ data: tables[table] ?? [], error: null }),
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as any;
}

describe('notifyUserOfPendingUpdates', () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    isEmailConfiguredMock.mockReset();
    deliverWebhookMock.mockReset();
  });

  it('sends email + webhook and marks the update notified', async () => {
    isEmailConfiguredMock.mockReturnValue(true);
    sendEmailMock.mockResolvedValue({ success: true });
    deliverWebhookMock.mockResolvedValue({ success: true });

    const calls = { markNotified: [] as string[][], histInserts: [] as string[] };
    const supabase = makeSupabase({
      notification_preferences: { user_id: 'u1', email_enabled: true, email_frequency: 'daily', notify_critical_only: false, email_address: 'u1@test.com' },
      webhook_configurations: [{ id: 'w1', user_id: 'u1', name: 'WH', is_enabled: true, failure_count: 0 }],
      user_profiles: { id: 'u1', email: 'u1@test.com', name: 'User One', tenant_name: 'Tenant' },
    }, calls);

    const pending = [{ id: 'upd1', user_id: 'u1', tenant_id: 't1', winget_id: 'Google.Chrome', intune_app_id: 'a1', display_name: 'Chrome', current_version: '1.0', latest_version: '2.0', is_critical: false }] as any;

    const res = await notifyUserOfPendingUpdates(supabase, 'u1', { pendingUpdates: pending });

    expect(res.emailsSent).toBe(1);
    expect(res.webhooksSent).toBe(1);
    expect(res.notifiedUpdateIds).toEqual(['upd1']);
    expect(calls.markNotified.flat()).toContain('upd1');
    expect(calls.histInserts).toEqual(['sent', 'sent']);
  });

  it('does NOT mark notified when all channels fail (retried next run)', async () => {
    isEmailConfiguredMock.mockReturnValue(true);
    sendEmailMock.mockResolvedValue({ success: false, error: 'smtp down' });
    deliverWebhookMock.mockResolvedValue({ success: false, error: 'HTTP 403' });

    const calls = { markNotified: [] as string[][], histInserts: [] as string[] };
    const supabase = makeSupabase({
      notification_preferences: { user_id: 'u1', email_enabled: true, email_frequency: 'daily', notify_critical_only: false, email_address: 'u1@test.com' },
      webhook_configurations: [{ id: 'w1', user_id: 'u1', name: 'WH', is_enabled: true, failure_count: 0 }],
      user_profiles: { id: 'u1', email: 'u1@test.com', name: 'User One', tenant_name: 'Tenant' },
    }, calls);

    const pending = [{ id: 'upd1', user_id: 'u1', tenant_id: 't1', winget_id: 'Google.Chrome', intune_app_id: 'a1', display_name: 'Chrome', current_version: '1.0', latest_version: '2.0', is_critical: false }] as any;

    const res = await notifyUserOfPendingUpdates(supabase, 'u1', { pendingUpdates: pending });

    expect(res.notifiedUpdateIds).toEqual([]);
    expect(calls.markNotified.flat()).not.toContain('upd1');
  });
});

describe('SQLite-mode deployed/error notifications', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-notify-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('../db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('does not call deliverWebhook when notify_on_deployed is false', async () => {
    const { sqliteWebhooks, sqliteNotificationPreferences } = await import('../db/sqlite');
    await sqliteWebhooks.create('user-1', { name: 'test', url: 'https://discord.com/api/webhooks/x/y', webhook_type: 'discord' });
    await sqliteNotificationPreferences.upsert('user-1', { notify_on_deployed: false });

    const deliverMock = vi.fn().mockResolvedValue({ success: true });
    vi.doMock('@/lib/webhooks/service', () => ({ deliverWebhook: deliverMock }));

    const { notifyUserOfDeployedUpdate } = await import('./notify-user');
    await notifyUserOfDeployedUpdate('user-1', 'tenant-1', { wingetId: '7zip.7zip', displayName: '7-Zip', version: '23.0', intuneAppId: 'app-1' });

    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('calls deliverWebhook when notify_on_deployed is true (the default)', async () => {
    const { sqliteWebhooks } = await import('../db/sqlite');
    await sqliteWebhooks.create('user-1', { name: 'test', url: 'https://discord.com/api/webhooks/x/y', webhook_type: 'discord' });

    const deliverMock = vi.fn().mockResolvedValue({ success: true });
    vi.doMock('@/lib/webhooks/service', () => ({ deliverWebhook: deliverMock }));

    const { notifyUserOfDeployedUpdate } = await import('./notify-user');
    await notifyUserOfDeployedUpdate('user-1', 'tenant-1', { wingetId: '7zip.7zip', displayName: '7-Zip', version: '23.0', intuneAppId: 'app-1' });

    expect(deliverMock).toHaveBeenCalledTimes(1);
  });
});
