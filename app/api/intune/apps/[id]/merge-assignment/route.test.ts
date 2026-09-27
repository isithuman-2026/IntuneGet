import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import * as intuneApi from '@/lib/intune-api';
import * as authUtils from '@/lib/auth-utils';
import * as graphClient from '@/lib/intune/graph-client';

vi.mock('@/lib/intune-api');
vi.mock('@/lib/auth-utils');
vi.mock('@/lib/intune/graph-client');

function makeRequest(body: unknown, appId: string) {
  return new Request(`http://localhost/api/intune/apps/${appId}/merge-assignment`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

const existingApp = {
  id: 'app-123',
  displayName: 'VLC media player',
  rules: [],
} as unknown as import('@/types/intune').IntuneWin32App;

describe('POST /api/intune/apps/[id]/merge-assignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authUtils.parseAccessToken).mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-1', email: 'a@b.com' } as never);
    vi.mocked(graphClient.getServicePrincipalToken).mockResolvedValue('sp-graph-token');
    vi.mocked(intuneApi.getApp).mockResolvedValue(existingApp);
  });

  it('uses the service-principal token, not any token from the request body', async () => {
    vi.mocked(intuneApi.getAppAssignments).mockResolvedValue([
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'required', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'existing-group' } },
    ]);
    vi.mocked(intuneApi.assignToGroups).mockResolvedValue(undefined);
    vi.mocked(intuneApi.convertToGraphAssignments).mockReturnValue([
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'new-group' } },
    ]);

    const req = makeRequest(
      { assignments: [{ type: 'group', groupId: 'new-group', intent: 'available' }] },
      'app-123'
    );
    const res = await POST(req, { params: Promise.resolve({ id: 'app-123' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, assignmentCount: 2 });
    // Every Graph call must use the service-principal token, never a value
    // the client could pass in — this route used to (wrongly) trust the
    // caller's own accessToken, which never carries app-management scopes.
    expect(intuneApi.getApp).toHaveBeenCalledWith('sp-graph-token', 'app-123');
    expect(intuneApi.getAppAssignments).toHaveBeenCalledWith('sp-graph-token', 'app-123');
    expect(intuneApi.assignToGroups).toHaveBeenCalledWith(
      'sp-graph-token',
      'app-123',
      expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ groupId: 'existing-group' }) }),
        expect.objectContaining({ target: expect.objectContaining({ groupId: 'new-group' }) }),
      ])
    );
  });

  it('merges every assignment in the array, not only the first', async () => {
    vi.mocked(intuneApi.getAppAssignments).mockResolvedValue([]);
    vi.mocked(intuneApi.assignToGroups).mockResolvedValue(undefined);
    vi.mocked(intuneApi.convertToGraphAssignments).mockImplementation((assignments) =>
      assignments.map((a) => ({
        '@odata.type': '#microsoft.graph.mobileAppAssignment',
        intent: a.intent === 'updateOnly' ? 'required' : a.intent,
        target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: a.groupId },
      }))
    );

    const req = makeRequest(
      {
        assignments: [
          { type: 'group', groupId: 'group-a', intent: 'required' },
          { type: 'exclusionGroup', groupId: 'group-b', intent: 'required' },
        ],
      },
      'app-123'
    );
    const res = await POST(req, { params: Promise.resolve({ id: 'app-123' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.assignmentCount).toBe(2);
    expect(intuneApi.convertToGraphAssignments).toHaveBeenCalledWith([
      { type: 'group', groupId: 'group-a', intent: 'required' },
      { type: 'exclusionGroup', groupId: 'group-b', intent: 'required' },
    ]);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(authUtils.parseAccessToken).mockResolvedValue(null);
    const req = makeRequest({ assignments: [{ type: 'group', groupId: 'g', intent: 'required' }] }, 'app-123');
    const res = await POST(req, { params: Promise.resolve({ id: 'app-123' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 with a redeploy hint when the app no longer exists in Intune', async () => {
    vi.mocked(intuneApi.getApp).mockResolvedValue(null);
    const req = makeRequest({ assignments: [{ type: 'group', groupId: 'g', intent: 'required' }] }, 'app-123');
    const res = await POST(req, { params: Promise.resolve({ id: 'app-123' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/no longer exists|deleted|redeploy/i);
    // A missing app must be caught by an explicit getApp() check, not
    // discovered as a side effect of some other call failing.
    expect(intuneApi.getAppAssignments).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty assignments array instead of silently defaulting to all devices', async () => {
    const req = makeRequest({ assignments: [] }, 'app-123');
    const res = await POST(req, { params: Promise.resolve({ id: 'app-123' }) });
    expect(res.status).toBe(400);
  });
});
