import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import * as intuneApi from '@/lib/intune-api';
import * as authUtils from '@/lib/auth-utils';

vi.mock('@/lib/intune-api');
vi.mock('@/lib/auth-utils');

function makeRequest(body: unknown, appId: string) {
  return new Request(`http://localhost/api/intune/apps/${appId}/merge-assignment`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/intune/apps/[appId]/merge-assignment', () => {
  beforeEach(() => {
    vi.mocked(authUtils.parseAccessToken).mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-1', email: 'a@b.com' } as never);
  });

  it('merges the incoming assignment with existing ones and calls assignToGroups with the union', async () => {
    vi.mocked(intuneApi.getAppAssignments).mockResolvedValue([
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'required', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'existing-group' } },
    ]);
    vi.mocked(intuneApi.assignToGroups).mockResolvedValue(undefined);
    vi.mocked(intuneApi.convertToGraphAssignments).mockReturnValue([
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'new-group' } },
    ]);

    const req = makeRequest(
      { accessToken: 'graph-token', assignment: { type: 'group', groupId: 'new-group', intent: 'available' } },
      'app-123'
    );
    const res = await POST(req, { params: Promise.resolve({ appId: 'app-123' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, assignmentCount: 2 });
    expect(intuneApi.assignToGroups).toHaveBeenCalledWith(
      'graph-token',
      'app-123',
      expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ groupId: 'existing-group' }) }),
        expect.objectContaining({ target: expect.objectContaining({ groupId: 'new-group' }) }),
      ])
    );
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(authUtils.parseAccessToken).mockResolvedValue(null);
    const req = makeRequest({ accessToken: 'x', assignment: { type: 'group', groupId: 'g', intent: 'required' } }, 'app-123');
    const res = await POST(req, { params: Promise.resolve({ appId: 'app-123' }) });
    expect(res.status).toBe(401);
  });

  it('returns 502 with a clear message when the target app no longer exists', async () => {
    vi.mocked(intuneApi.getAppAssignments).mockRejectedValue(new Error('Failed to get app assignments'));
    const req = makeRequest({ accessToken: 'graph-token', assignment: { type: 'group', groupId: 'g', intent: 'required' } }, 'app-123');
    const res = await POST(req, { params: Promise.resolve({ appId: 'app-123' }) });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/no longer exists|could not be reached/i);
  });
});
