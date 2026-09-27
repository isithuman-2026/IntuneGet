import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { getAppAssignments, assignToGroups, convertToGraphAssignments } from '@/lib/intune-api';
import { mergeAssignments } from '@/lib/assignment-merge';
import type { PackageAssignment } from '@/types/upload';

interface MergeAssignmentBody {
  accessToken: string; // Graph access token (caller already has it via MSAL)
  assignment: PackageAssignment;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const user = await parseAccessToken(request.headers.get('Authorization'));
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const { appId } = await params;
  const body = (await request.json()) as MergeAssignmentBody;

  if (!body.accessToken || !body.assignment) {
    return NextResponse.json({ error: 'accessToken and assignment are required' }, { status: 400 });
  }

  try {
    const existing = await getAppAssignments(body.accessToken, appId);
    const incoming = convertToGraphAssignments([body.assignment]);
    const merged = mergeAssignments(existing, incoming);

    await assignToGroups(body.accessToken, appId, merged);

    return NextResponse.json({ success: true, assignmentCount: merged.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Could not update assignments on the existing app (${appId}) — it no longer exists in Intune, or Intune could not be reached: ${message}` },
      { status: 502 }
    );
  }
}
