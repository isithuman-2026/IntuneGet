import { describe, it, expect, vi, beforeEach } from 'vitest';
import { replaceAppContentInPlace } from './intune-api';

describe('replaceAppContentInPlace', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('creates a content version, uploads, commits, then PATCHes committedContentVersion', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cv-1' }), { status: 201 })) // POST contentVersions
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-1', azureStorageUri: 'https://sas.example/upload' }), { status: 201 })) // POST files
      .mockResolvedValueOnce(new Response(null, { status: 201 })) // upload to SAS
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // commit
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // PATCH committedContentVersion

    await replaceAppContentInPlace('token', 'app-1', {
      fileName: 'app.intunewin',
      fileSize: 100,
      fileSizeEncrypted: 110,
      uploadBuffer: Buffer.from('fake-payload'),
      encryptionInfo: {
        encryptionKey: 'k',
        macKey: 'm',
        initializationVector: 'iv',
        mac: 'mac',
        profileIdentifier: 'ProfileVersion1',
        fileDigest: 'd',
        fileDigestAlgorithm: 'SHA256',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);

    const [createCvUrl] = fetchMock.mock.calls[0];
    expect(String(createCvUrl)).toContain('/mobileApps/app-1/microsoft.graph.win32LobApp/contentVersions');

    const patchCall = fetchMock.mock.calls[4];
    expect(String(patchCall[0])).toContain('/mobileApps/app-1');
    expect(JSON.parse(String((patchCall[1] as RequestInit).body))).toMatchObject({
      '@odata.type': '#microsoft.graph.win32LobApp',
      committedContentVersion: 'cv-1',
    });
  });

  it('throws when the content file commit is rejected', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cv-1' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-1', azureStorageUri: 'https://sas.example/upload' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response('bad request', { status: 400 }));

    await expect(
      replaceAppContentInPlace('token', 'app-1', {
        fileName: 'app.intunewin',
        fileSize: 100,
        fileSizeEncrypted: 110,
        uploadBuffer: Buffer.from('fake-payload'),
        encryptionInfo: {
          encryptionKey: 'k',
          macKey: 'm',
          initializationVector: 'iv',
          mac: 'mac',
          profileIdentifier: 'ProfileVersion1',
          fileDigest: 'd',
          fileDigestAlgorithm: 'SHA256',
        },
      })
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
