import { afterEach, describe, expect, it, vi } from 'vitest';

const entryPoint = '../src/adapters/aws/receipt-janitor-lambda.js';

describe('receipt janitor Lambda entry point', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exports only the handler', async () => {
    vi.stubEnv('CLAIMFLOW_RECEIPT_BUCKET_NAME', 'receipts');
    const module = await import(entryPoint);
    expect(Object.keys(module)).toEqual(['handler']);
    expect(module.handler).toBeTypeOf('function');
  });

  it('answers an empty batch without calling AWS', async () => {
    vi.stubEnv('CLAIMFLOW_RECEIPT_BUCKET_NAME', 'receipts');
    const { handler } = await import(entryPoint);
    await expect(handler({ Records: [] })).resolves.toEqual({
      batchItemFailures: [],
    });
  });

  it('ignores removals that were not made by the DynamoDB service', async () => {
    vi.stubEnv('CLAIMFLOW_RECEIPT_BUCKET_NAME', 'receipts');
    const { handler } = await import(entryPoint);
    await expect(
      handler({
        Records: [
          {
            eventName: 'REMOVE',
            dynamodb: { SequenceNumber: '1' },
          },
          {
            eventName: 'INSERT',
            userIdentity: {
              type: 'Service',
              principalId: 'dynamodb.amazonaws.com',
            },
            dynamodb: { SequenceNumber: '2' },
          },
        ],
      }),
    ).resolves.toEqual({ batchItemFailures: [] });
  });

  it.each([undefined, ''])(
    'fails to load with the bucket name %j',
    async (value) => {
      vi.stubEnv('CLAIMFLOW_RECEIPT_BUCKET_NAME', value);
      await expect(import(entryPoint)).rejects.toThrow(
        'The CLAIMFLOW_RECEIPT_BUCKET_NAME environment variable is missing.',
      );
    },
  );
});
