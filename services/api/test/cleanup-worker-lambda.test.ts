import { afterEach, describe, expect, it, vi } from 'vitest';

const entryPoint = '../src/adapters/aws/cleanup-worker-lambda.js';

describe('cleanup worker Lambda entry point', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exports only the handler', async () => {
    vi.stubEnv('CLAIMFLOW_TABLE_NAME', 'ClaimFlow');
    vi.stubEnv('CLAIMFLOW_RECEIPT_BUCKET_NAME', 'receipts');
    const module = await import(entryPoint);
    expect(Object.keys(module)).toEqual(['handler']);
    expect(module.handler).toBeTypeOf('function');
  });

  it('answers an empty batch without calling AWS', async () => {
    vi.stubEnv('CLAIMFLOW_TABLE_NAME', 'ClaimFlow');
    vi.stubEnv('CLAIMFLOW_RECEIPT_BUCKET_NAME', 'receipts');
    const { handler } = await import(entryPoint);
    await expect(handler({ Records: [] })).resolves.toEqual({
      batchItemFailures: [],
    });
  });

  it.each(['CLAIMFLOW_TABLE_NAME', 'CLAIMFLOW_RECEIPT_BUCKET_NAME'])(
    'fails to load without %s',
    async (missing) => {
      vi.stubEnv('CLAIMFLOW_TABLE_NAME', 'ClaimFlow');
      vi.stubEnv('CLAIMFLOW_RECEIPT_BUCKET_NAME', 'receipts');
      vi.stubEnv(missing, '');
      await expect(import(entryPoint)).rejects.toThrow(
        `The ${missing} environment variable is missing.`,
      );
    },
  );
});
