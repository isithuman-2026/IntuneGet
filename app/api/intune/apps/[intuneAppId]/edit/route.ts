import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { isSqliteMode } from '@/lib/db';
import { sqliteUploadHistory, sqliteUpdatePolicies } from '@/lib/db/sqlite';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import { assignToGroups, syncAppCategories } from '@/lib/intune-api';
import type { Win32LobAppAssignment } from '@/types/intune';
import type { UpdatePolicyType } from '@/types/update-policies';

interface EditAppRequest {
  assignments?: Win32LobAppAssignment[];
  categories?: { id: string }[];
  policyType?: UpdatePolicyType;
  delayDays?: number;
}

type FieldResult = 'ok' | { error: string };

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ intuneAppId: string }> }
) {
  const { intuneAppId } = await params;
  const user = await parseAccessToken(request.headers.get('Authorization'));
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (!isSqliteMode()) {
    return NextResponse.json({ error: 'Not implemented outside SQLite mode' }, { status: 501 });
  }

  const uploadHistory = await sqliteUploadHistory.getLatestByIntuneAppId(user.tenantId, intuneAppId);
  if (!uploadHistory) {
    return NextResponse.json({ error: 'App was not deployed by IntuneGet' }, { status: 404 });
  }

  const body = (await request.json()) as EditAppRequest;
  const results: Record<string, FieldResult> = {};

  if (body.assignments || body.categories) {
    const graphToken = await getServicePrincipalToken(user.tenantId);
    if (!graphToken) {
      return NextResponse.json({ error: 'Tenant consent is no longer active' }, { status: 403 });
    }

    if (body.assignments) {
      try {
        await assignToGroups(graphToken, intuneAppId, body.assignments);
        results.assignments = 'ok';
      } catch (error) {
        results.assignments = { error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }

    if (body.categories) {
      try {
        await syncAppCategories(graphToken, intuneAppId, body.categories);
        results.categories = 'ok';
      } catch (error) {
        results.categories = { error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }
  }

  if (body.policyType || body.delayDays !== undefined) {
    try {
      await sqliteUpdatePolicies.upsert(uploadHistory.user_id, {
        winget_id: uploadHistory.winget_id,
        tenant_id: user.tenantId,
        policy_type: body.policyType ?? 'notify',
        delay_days: body.delayDays,
      });
      results.policy = 'ok';
    } catch (error) {
      results.policy = { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  return NextResponse.json({ results });
}
