import { S3Client } from '@aws-sdk/client-s3';
import { sanitizeFileName } from '@claimflow/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createS3DownloadSigner,
  DownloadUrlError,
  downloadUrlLifetimeSeconds,
  S3DownloadUrlGenerator,
  type DownloadUrlRequest,
  type DownloadUrlSigner,
} from '../src/adapters/aws/s3-download-url.js';
import { contentDisposition } from '../src/application/content-disposition.js';
import type { Clock } from '../src/application/ports.js';

const bucket = 'claimflow-receipts-test';
const signedAt = new Date('2026-10-20T08:00:00.123Z');
const url =
  'https://claimflow-receipts-test.s3.ap-southeast-1.amazonaws.com/receipts/r-7731?X-Amz-Signature=abc';

const clock: Clock = { now: () => signedAt };

let requests: DownloadUrlRequest[];

function recordingSigner(result = url): DownloadUrlSigner {
  return (request) => {
    requests.push(request);
    return Promise.resolve(result);
  };
}

const generatorWith = (sign: DownloadUrlSigner, bucketName = bucket) =>
  new S3DownloadUrlGenerator({ bucketName, sign, clock });

async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeEach(() => {
  requests = [];
});

describe('createUrl', () => {
  it('asks the signer once for the final key, disposition, five minutes, and captured time', async () => {
    const result = await generatorWith(recordingSigner()).createUrl(
      'r-7731',
      'Client flight.pdf',
    );

    expect(requests).toEqual([
      {
        bucket,
        key: 'receipts/r-7731',
        responseContentDisposition: `inline; filename="Client flight.pdf"; filename*=UTF-8''Client%20flight.pdf`,
        expiresInSeconds: 300,
        signingDate: signedAt,
      },
    ]);
    expect(downloadUrlLifetimeSeconds).toBe(300);
    expect(result).toEqual({ url, expiresAt: '2026-10-20T08:05:00.123Z' });
  });

  it('reads the clock once, so the signing time and expiry agree', async () => {
    const now = vi.fn(() => signedAt);
    await new S3DownloadUrlGenerator({
      bucketName: bucket,
      sign: recordingSigner(),
      clock: { now },
    }).createUrl('r-7731', 'a.pdf');

    expect(now).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it.each([
    'flight.pdf',
    'Client flight (return).pdf',
    'Résumé café.pdf',
    '领收据.png',
  ])('uses the shared disposition for %s', async (fileName) => {
    expect(sanitizeFileName(fileName)).toBe(fileName);

    await generatorWith(recordingSigner()).createUrl('r-7731', fileName);

    expect(requests[0]!.responseContentDisposition).toBe(
      contentDisposition(fileName),
    );
  });
});

describe('contentDisposition', () => {
  it('gives an ASCII fallback and an RFC 5987 UTF-8 name', () => {
    expect(contentDisposition('Client flight.pdf')).toBe(
      `inline; filename="Client flight.pdf"; filename*=UTF-8''Client%20flight.pdf`,
    );
    expect(contentDisposition('Café "a".pdf')).toBe(
      `inline; filename="Caf_ _a_.pdf"; filename*=UTF-8''Caf%C3%A9%20%22a%22.pdf`,
    );
    expect(contentDisposition('领收据.png')).toBe(
      `inline; filename="___.png"; filename*=UTF-8''%E9%A2%86%E6%94%B6%E6%8D%AE.png`,
    );
  });
});

describe('rejections', () => {
  it.each(['', null as unknown as string])(
    'rejects a missing bucket (%j) before signing',
    async (bucketName) => {
      const error = await errorOf(() =>
        generatorWith(recordingSigner(), bucketName).createUrl(
          'r-7731',
          'a.pdf',
        ),
      );

      expect(error).toBeInstanceOf(DownloadUrlError);
      expect(requests).toEqual([]);
    },
  );

  it.each(['', 'r#1', 'r 1', 'receipts/r-1', '../r-1', 'x'.repeat(65)])(
    'rejects receipt ID %j before signing',
    async (receiptId) => {
      expect(
        await errorOf(() =>
          generatorWith(recordingSigner()).createUrl(receiptId, 'a.pdf'),
        ),
      ).toBeInstanceOf(DownloadUrlError);
      expect(requests).toEqual([]);
    },
  );

  it.each([
    '../a.pdf',
    'dir/a.pdf',
    ' a.pdf',
    'a  b.pdf',
    '.hidden.pdf',
    'a<b>.pdf',
    '',
    'x'.repeat(121),
  ])(
    'rejects the unsanitized file name %j before signing',
    async (fileName) => {
      expect(
        await errorOf(() =>
          generatorWith(recordingSigner()).createUrl('r-7731', fileName),
        ),
      ).toBeInstanceOf(DownloadUrlError);
      expect(requests).toEqual([]);
    },
  );

  it.each([
    ['an empty URL', ''],
    ['an insecure URL', 'http://example.com/a'],
    ['a bare scheme', 'https://'],
    ['a non-string URL', null as unknown as string],
  ])('rejects signer output with %s', async (_name, result) => {
    expect(
      await errorOf(() =>
        generatorWith(recordingSigner(result)).createUrl('r-7731', 'a.pdf'),
      ),
    ).toBeInstanceOf(DownloadUrlError);
    expect(requests).toHaveLength(1);
  });

  it('uses fixed messages without the bucket, key, receipt ID, or file name', async () => {
    const name = 'Payslip Aisha Rahman.pdf';
    const errors = [
      await errorOf(() =>
        generatorWith(recordingSigner(), '').createUrl('r-secret', name),
      ),
      await errorOf(() =>
        generatorWith(recordingSigner()).createUrl('r secret', name),
      ),
      await errorOf(() =>
        generatorWith(recordingSigner()).createUrl('r-secret', `/${name}`),
      ),
      await errorOf(() =>
        generatorWith(recordingSigner('http://r-secret')).createUrl(
          'r-secret',
          name,
        ),
      ),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(DownloadUrlError);
      const text = (error as Error).message;
      for (const value of [
        bucket,
        'r-secret',
        'r secret',
        'receipts/',
        'Payslip',
        'http://',
      ]) {
        expect(text).not.toContain(value);
      }
    }
  });

  it('propagates signer failures unchanged', async () => {
    const failure = new Error('signing failed');
    const sign: DownloadUrlSigner = () => Promise.reject(failure);

    expect(
      await errorOf(() => generatorWith(sign).createUrl('r-7731', 'a.pdf')),
    ).toBe(failure);
  });
});

describe('createS3DownloadSigner', () => {
  it('signs locally with the real SDK and sends no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new S3Client({
      region: 'ap-southeast-1',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    });
    const send = vi.spyOn(client, 'send');

    const result = await generatorWith(
      createS3DownloadSigner(client),
    ).createUrl('r-7731', 'Client flight.pdf');

    const signed = new URL(result.url);
    expect(signed.protocol).toBe('https:');
    expect(signed.hostname).toContain(bucket);
    expect(signed.pathname).toBe('/receipts/r-7731');
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(signed.searchParams.get('X-Amz-Date')).toBe('20261020T080000Z');
    expect(signed.searchParams.get('X-Amz-Signature')).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(signed.searchParams.get('response-content-disposition')).toBe(
      contentDisposition('Client flight.pdf'),
    );
    expect(result.expiresAt).toBe('2026-10-20T08:05:00.123Z');
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
