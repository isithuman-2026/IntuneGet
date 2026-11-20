/**
 * Choose which existing Intune app an auto-update carries assignments from
 * and supersedes. The newest tracked copy is not always the assigned one: an
 * update that ran with carry-over off leaves the assignments on an older
 * copy, and every later update then carried over nothing and left that
 * assigned copy behind forever (duplicate apps in the tenant).
 *
 * @param currentAppId newest tracked copy (the default source)
 * @param candidateIds tracked copies for the same app, newest first
 * @param countAssignments assignment count for an app, or null if it no longer exists
 */
export async function pickAssignedSourceApp(
  currentAppId: string,
  candidateIds: string[],
  countAssignments: (appId: string) => Promise<number | null>
): Promise<string> {
  const ordered = [currentAppId, ...candidateIds.filter((id) => id !== currentAppId)];
  for (const id of ordered) {
    const count = await countAssignments(id);
    if (count && count > 0) return id;
  }
  return currentAppId;
}
