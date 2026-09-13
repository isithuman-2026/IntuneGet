import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { isSqliteMode } from '@/lib/db';
import { sqliteUploadHistory, getDb } from '@/lib/db/sqlite';

export async function GET(
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

  const db = getDb();
  const versions = db
    .prepare('SELECT id, version, status, completed_at FROM packaging_jobs WHERE user_id = ? AND winget_id = ? AND status = ? ORDER BY completed_at DESC')
    .all(uploadHistory.user_id, uploadHistory.winget_id, 'deployed');

  return NextResponse.json({ versions });
}
