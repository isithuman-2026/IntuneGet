import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const now = new Date().toISOString();
const jobs = [
  { id: '1', winget_id: 'Git.Git', display_name: 'Git', publisher: 'Git', status: 'deployed', error_message: null, created_at: now, completed_at: now },
  { id: '2', winget_id: 'Git.Git', display_name: 'Git', publisher: 'Git', status: 'deployed', error_message: null, created_at: now, completed_at: now },
  { id: '3', winget_id: 'VideoLAN.VLC', display_name: 'VLC', publisher: 'VideoLAN', status: 'failed', error_message: 'boom', created_at: now, completed_at: now },
  { id: '4', winget_id: 'X.Y', display_name: 'X', publisher: null, status: 'packaging', error_message: null, created_at: now, completed_at: null },
];

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: vi.fn().mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-1' }),
}));
vi.mock('@/lib/db', () => ({
  getDatabase: () => ({ jobs: { getByUserId: vi.fn().mockResolvedValue(jobs) } }),
}));

import { GET } from './route';

describe('GET /api/analytics', () => {
  it('counts SQLite "deployed" jobs as successful deployments', async () => {
    const res = await GET(new NextRequest('http://localhost/api/analytics?days=30', { headers: { Authorization: 'Bearer a.b.c' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toMatchObject({ totalJobs: 4, completedJobs: 2, failedJobs: 1, pendingJobs: 1, successRate: 67 });
    expect(body.topApps[0]).toMatchObject({ wingetId: 'Git.Git' });
    const daily = body.dailyDeployments as Array<Record<string, number>>;
    expect(daily.reduce((n, d) => n + (d.completed ?? 0), 0)).toBe(2);
  });
});
