import { NextRequest, NextResponse } from 'next/server';
import { getServerClientOrNull } from '@/lib/supabase';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import { getApp, getAppAssignments, assignToGroups, convertToGraphAssignments, setAppRules } from '@/lib/intune-api';
import { buildCartItemRequirementRules } from '@/lib/requirement-rules';
import { mergeAssignments } from '@/lib/assignment-merge';
import { parseAccessToken } from '@/lib/auth-utils';
import type { PackageAssignment } from '@/types/upload';

interface MergeAssignmentBody {
  assignments: PackageAssignment[];
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: intuneAppId } = await params;

    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = (await request.json()) as MergeAssignmentBody;
    if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
      return NextResponse.json({ error: 'At least one assignment is required' }, { status: 400 });
    }

    // Same tenant-resolution + admin-consent pattern as settings/route.ts —
    // supabase is null in self-hosted SQLite mode, so both steps fall back
    // to the token's own tenant/an implicit "consented" state.
    const supabase = getServerClientOrNull();
    const mspTenantId = request.headers.get('X-MSP-Tenant-Id');

    const tenantResolution = supabase
      ? await resolveTargetTenantId({
          supabase,
          userId: user.userId,
          tokenTenantId: user.tenantId,
          requestedTenantId: mspTenantId,
        })
      : { tenantId: user.tenantId, errorResponse: null };

    if (tenantResolution.errorResponse) {
      return tenantResolution.errorResponse;
    }
    const tenantId = tenantResolution.tenantId;

    const { data: consentData, error: consentError } = supabase
      ? await supabase.from('tenant_consent').select('*').eq('tenant_id', tenantId).eq('is_active', true).single()
      : { data: true, error: null };

    if (consentError || !consentData) {
      return NextResponse.json(
        { error: 'Admin consent not found. Please complete the admin consent flow.' },
        { status: 403 }
      );
    }

    // Always use the tenant's own app-only Graph token — never a token the
    // caller supplies. The signed-in user's own delegated token only ever
    // carries User.Read and cannot manage Intune apps.
    const graphToken = await getServicePrincipalToken(tenantId);
    if (!graphToken) {
      return NextResponse.json({ error: 'Failed to get Graph API token' }, { status: 500 });
    }

    const existingApp = await getApp(graphToken, intuneAppId);
    if (!existingApp) {
      return NextResponse.json(
        { error: 'App not found in Intune. It may have been deleted. Try redeploying instead.' },
        { status: 404 }
      );
    }

    // updateOnly assignments rely on a requirement rule (prior version must
    // already be installed) to avoid a fresh, forced install — same guard
    // settings/route.ts applies, skipped only if the app already has one.
    const productCode = existingApp.msiInformation?.productCode;
    const requirementRules = buildCartItemRequirementRules(
      existingApp.displayName,
      productCode ? 'msi' : 'exe',
      productCode,
      body.assignments
    );
    const existingRules = existingApp.rules ?? [];
    const hasRequirementRule = existingRules.some((rule) => rule.ruleType === 'requirement');
    if (requirementRules && !hasRequirementRule) {
      await setAppRules(graphToken, intuneAppId, [...existingRules, ...requirementRules]);
    }

    const existingAssignments = await getAppAssignments(graphToken, intuneAppId);
    const incoming = convertToGraphAssignments(body.assignments);
    const merged = mergeAssignments(existingAssignments, incoming);

    await assignToGroups(graphToken, intuneAppId, merged);

    return NextResponse.json({ success: true, assignmentCount: merged.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Could not update assignments on the existing app: ${message}` },
      { status: 500 }
    );
  }
}
