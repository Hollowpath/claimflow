import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { setAuth } from '../src/auth';
import { CognitoAuth } from '../src/auth/cognito';
import { localConfig, setRuntimeConfig } from '../src/config';
import { navigation } from '../src/lib/navigation';
import { claim } from './fixtures';

const apiBaseUrl =
  'https://abc.execute-api.ap-southeast-1.amazonaws.com/api/v1';
const hostedUiUrl = 'https://claimflow-1.auth.ap-southeast-1.amazoncognito.com';
const s3Url = 'https://claimflow-receipts.s3.ap-southeast-1.amazonaws.com/';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const file = new File(['%PDF-1.4 receipt'], 'taxi.pdf', {
  type: 'application/pdf',
});

/** SHA-256 of the file's bytes, computed independently of the app's code. */
async function expectedChecksum() {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

const fields = {
  key: 'uploads/pending/r-1',
  'Content-Type': 'application/pdf',
  'x-amz-algorithm': 'AWS4-HMAC-SHA256',
  Policy: 'cG9saWN5',
  'x-amz-signature': 'abc',
};

function useCognito() {
  const store = new Map<string, string>([
    [
      'claimflow.auth.tokens',
      JSON.stringify({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 3_600_000,
      }),
    ],
  ]);
  setRuntimeConfig({
    apiBaseUrl,
    cognito: { hostedUiUrl, clientId: 'client123' },
  });
  setAuth(
    new CognitoAuth({
      config: { hostedUiUrl, clientId: 'client123' },
      storage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
      },
      fetch: vi.fn(),
      now: () => Date.now(),
      navigate: vi.fn(),
      origin: 'https://d111.cloudfront.net',
    }),
  );
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}
let calls: Call[];
let handlers: Record<string, () => Response>;

function stubFetch() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const key = `${init.method} ${url}`;
      const handler = handlers[key];
      if (handler === undefined) {
        throw new Error(`Unexpected request ${key}`);
      }
      return Promise.resolve(handler());
    }),
  );
}

const headersOf = (call: Call) =>
  (call.init.headers ?? {}) as Record<string, string>;
const quiet = () =>
  vi.spyOn(navigation, 'assign').mockImplementation(() => undefined);

describe('AWS receipt upload', () => {
  beforeEach(() => {
    useCognito();
    handlers = {
      [`POST ${apiBaseUrl}/receipts`]: () =>
        json({ receiptId: 'r-1', form: { url: s3Url, fields } }, 201),
      [`POST ${s3Url}`]: () => new Response(null, { status: 204 }),
      [`PUT ${apiBaseUrl}/claims/c-1/receipt`]: () =>
        json(claim({ version: 2 })),
    };
    stubFetch();
  });

  it('declares the file, posts every field then the file to S3, then attaches it', async () => {
    const result = await api.attachReceiptFile('c-1', 1, file);

    expect(result.version).toBe(2);
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      `POST ${apiBaseUrl}/receipts`,
      `POST ${s3Url}`,
      `PUT ${apiBaseUrl}/claims/c-1/receipt`,
    ]);
    const checksumSha256 = await expectedChecksum();
    const [declare, upload, attach] = calls as [Call, Call, Call];

    // The JSON declaration, sent with the access token.
    expect(headersOf(declare)['Content-Type']).toBe('application/json');
    expect(headersOf(declare).Authorization).toBe('Bearer access-1');
    expect(JSON.parse(declare.init.body as string)).toEqual({
      fileName: 'taxi.pdf',
      contentType: 'application/pdf',
      sizeBytes: file.size,
      checksumSha256,
    });

    // The S3 form: every returned field in order, then the file.
    const form = upload.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const entries = [...form.entries()];
    expect(entries.map(([name]) => name)).toEqual([
      ...Object.keys(fields),
      'file',
    ]);
    expect(entries.slice(0, -1)).toEqual(Object.entries(fields));
    const sent = entries.at(-1)![1] as File;
    expect(sent.name).toBe('taxi.pdf');
    expect(sent.size).toBe(file.size);

    // The existing attach request with the existing metadata.
    expect(JSON.parse(attach.init.body as string)).toEqual({
      expectedVersion: 1,
      receiptId: 'r-1',
      contentType: 'application/pdf',
      sizeBytes: file.size,
      checksumSha256,
    });
  });

  it('keeps the bearer token and cookies away from S3', async () => {
    await api.attachReceiptFile('c-1', 1, file);

    const upload = calls[1]!;
    expect(upload.init.headers).toBeUndefined();
    expect(upload.init.credentials).toBe('omit');
    expect(JSON.stringify(upload)).not.toContain('access-1');
    expect(headersOf(calls[0]!).Authorization).toBe('Bearer access-1');
    expect(headersOf(calls[2]!).Authorization).toBe('Bearer access-1');
  });

  it('does not attach when S3 rejects the upload', async () => {
    handlers[`POST ${s3Url}`] = () => new Response('<Error/>', { status: 403 });

    await expect(api.attachReceiptFile('c-1', 1, file)).rejects.toMatchObject({
      status: 403,
      message: 'The receipt could not be uploaded. Please try again.',
    });
    expect(calls.map((call) => call.init.method)).toEqual(['POST', 'POST']);
  });

  it('does not attach when S3 is unreachable', async () => {
    handlers[`POST ${s3Url}`] = () => {
      throw new TypeError('offline');
    };
    await expect(api.attachReceiptFile('c-1', 1, file)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(calls).toHaveLength(2);
  });

  it('does not contact S3 when the API refuses the declaration', async () => {
    const details = [
      { field: 'sizeBytes', code: 'TOO_LARGE', message: 'Big.' },
    ];
    handlers[`POST ${apiBaseUrl}/receipts`] = () =>
      json(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The receipt is not valid.',
            details,
          },
        },
        400,
      );
    await expect(api.attachReceiptFile('c-1', 1, file)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details,
    });
    expect(calls).toHaveLength(1);
  });

  it('surfaces an attach failure after a successful upload', async () => {
    handlers[`PUT ${apiBaseUrl}/claims/c-1/receipt`] = () =>
      json(
        { error: { code: 'VERSION_CONFLICT', message: 'Claim changed.' } },
        409,
      );
    await expect(api.attachReceiptFile('c-1', 1, file)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(calls).toHaveLength(3);
  });

  it.each(['http://bucket.example.com/', 'javascript:alert(1)', 'nope'])(
    'refuses a non-https upload URL (%s) without sending the file',
    async (url) => {
      handlers[`POST ${apiBaseUrl}/receipts`] = () =>
        json({ receiptId: 'r-1', form: { url, fields } }, 201);
      await expect(api.attachReceiptFile('c-1', 1, file)).rejects.toBeDefined();
      expect(calls).toHaveLength(1);
    },
  );
});

describe('AWS receipt download', () => {
  const download = `${apiBaseUrl}/claims/c-1/receipt`;
  const presigned =
    'https://claimflow-receipts.s3.ap-southeast-1.amazonaws.com/receipts/r-1?X-Amz-Signature=abc';

  beforeEach(() => {
    useCognito();
    handlers = {
      [`GET ${download}`]: () =>
        json({ url: presigned, expiresAt: '2026-10-21T12:05:00.000Z' }),
    };
    stubFetch();
  });

  it('fetches the URL with the token, then navigates there without calling S3', async () => {
    const assign = quiet();

    await api.openReceipt('c-1');

    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]!).Authorization).toBe('Bearer access-1');
    expect(assign).toHaveBeenCalledExactlyOnceWith(presigned);
  });

  it('does not navigate when the API refuses', async () => {
    const assign = quiet();
    handlers[`GET ${download}`] = () =>
      json({ error: { code: 'NOT_FOUND', message: 'No receipt.' } }, 404);
    await expect(api.openReceipt('c-1')).rejects.toMatchObject({ status: 404 });
    expect(assign).not.toHaveBeenCalled();
  });

  it.each(['http://example.com/x', 'javascript:alert(1)', ''])(
    'never navigates to %j',
    async (url) => {
      const assign = quiet();
      handlers[`GET ${download}`] = () => json({ url, expiresAt: 'x' });
      await expect(api.openReceipt('c-1')).rejects.toBeDefined();
      expect(assign).not.toHaveBeenCalled();
    },
  );
});

describe('local receipt flow', () => {
  beforeEach(() => {
    setRuntimeConfig(localConfig);
    setAuth(undefined);
    handlers = {
      'POST /api/v1/receipts': () =>
        json({ receiptId: 'r-9', fileName: 'taxi.pdf' }, 201),
      'PUT /api/v1/claims/c-1/receipt': () => json(claim({ version: 2 })),
    };
    stubFetch();
  });

  afterEach(() => vi.restoreAllMocks());

  it('still uploads the raw file to the local API and attaches it', async () => {
    await api.attachReceiptFile('c-1', 1, file);

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST /api/v1/receipts',
      'PUT /api/v1/claims/c-1/receipt',
    ]);
    const upload = calls[0]!;
    expect(upload.init.body).toBe(file);
    expect(headersOf(upload)['Content-Type']).toBe('application/pdf');
    expect(headersOf(upload)['X-File-Name']).toBe('taxi.pdf');
    expect(headersOf(upload)).not.toHaveProperty('Authorization');
    expect(upload.init.credentials).toBe('same-origin');
    expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({
      receiptId: 'r-9',
    });
  });

  it('still downloads through a plain same-origin link', () => {
    expect(api.receiptUrl('c-1')).toBe('/api/v1/claims/c-1/receipt');
  });
});
