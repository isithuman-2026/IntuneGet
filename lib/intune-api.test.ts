import { describe, it, expect, vi, beforeEach } from 'vitest';
import { replaceAppContentInPlace } from './intune-api';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('replaceAppContentInPlace', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.useFakeTimers();
  });

  const encryptionInfo = {
    encryptionKey: 'k',
    macKey: 'm',
    initializationVector: 'iv',
    mac: 'mac',
    profileIdentifier: 'ProfileVersion1',
    fileDigest: 'd',
    fileDigestAlgorithm: 'SHA256',
  };

  it('polls for the Azure Storage URI and for commit success before activating', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'cv-1' }, 201)) // 1. POST contentVersions
      .mockResolvedValueOnce(jsonResponse({ id: 'file-1', uploadState: 'azureStorageUriRequestPending' }, 201)) // 2. POST files (no URI yet — matches the real spike)
      .mockResolvedValueOnce(jsonResponse({ uploadState: 'azureStorageUriRequestPending' })) // 3. GET poll — still pending
      .mockResolvedValueOnce(jsonResponse({ uploadState: 'azureStorageUriRequestSuccess', azureStorageUri: 'https://sas.example/upload' })) // 4. GET poll — ready
      .mockResolvedValueOnce(new Response(null, { status: 201 })) // 5. PUT to SAS
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // 6. POST commit (accepted, async)
      .mockResolvedValueOnce(jsonResponse({ uploadState: 'pending' })) // 7. GET poll — still processing
      .mockResolvedValueOnce(jsonResponse({ uploadState: 'commitFileSuccess' })) // 8. GET poll — done
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // 9. PATCH committedContentVersion

    const promise = replaceAppContentInPlace('token', 'app-1', {
      fileName: 'app.intunewin',
      fileSize: 100,
      fileSizeEncrypted: 110,
      uploadBuffer: Buffer.from('fake-payload'),
      encryptionInfo,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(9);
    const patchCall = fetchMock.mock.calls[8];
    expect(String(patchCall[0])).toContain('/mobileApps/app-1');
    expect(JSON.parse(String((patchCall[1] as RequestInit).body))).toMatchObject({
      '@odata.type': '#microsoft.graph.win32LobApp',
      committedContentVersion: 'cv-1',
    });
  });

  it('throws without activating when the file commit is reported as failed', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'cv-1' }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: 'file-1', uploadState: 'azureStorageUriRequestPending' }, 201))
      .mockResolvedValueOnce(jsonResponse({ uploadState: 'azureStorageUriRequestSuccess', azureStorageUri: 'https://sas.example/upload' }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ uploadState: 'commitFileFailed' }));

    const promise = replaceAppContentInPlace('token', 'app-1', {
      fileName: 'app.intunewin',
      fileSize: 100,
      fileSizeEncrypted: 110,
      uploadBuffer: Buffer.from('fake-payload'),
      encryptionInfo,
    });
    const assertion = expect(promise).rejects.toThrow(/commit/i);
    await vi.runAllTimersAsync();
    await assertion;

    // The failed-commit guard this route relies on (see the spike record):
    // Graph itself would reject the PATCH with "All AppFiles must be
    // committed" — this function must never even attempt it.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('throws if the Azure Storage URI request itself fails, without uploading anything', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'cv-1' }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: 'file-1', uploadState: 'azureStorageUriRequestPending' }, 201))
      .mockResolvedValueOnce(jsonResponse({ uploadState: 'azureStorageUriRequestFailed' }));

    const promise = replaceAppContentInPlace('token', 'app-1', {
      fileName: 'app.intunewin',
      fileSize: 100,
      fileSizeEncrypted: 110,
      uploadBuffer: Buffer.from('fake-payload'),
      encryptionInfo,
    });
    const assertion = expect(promise).rejects.toThrow(/azure storage/i);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
