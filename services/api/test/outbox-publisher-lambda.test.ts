import { afterEach, describe, expect, it, vi } from 'vitest';

const entryPoint = '../src/adapters/aws/outbox-publisher-lambda.js';

describe('outbox publisher Lambda entry point', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const stubEnvironment = () => {
    vi.stubEnv('CLAIMFLOW_TABLE_NAME', 'ClaimFlow');
    vi.stubEnv('CLAIMFLOW_EVENT_BUS_NAME', 'claimflow');
  };

  it('exports only the handler', async () => {
    stubEnvironment();
    const module = await import(entryPoint);
    expect(Object.keys(module)).toEqual(['handler']);
    expect(module.handler).toBeTypeOf('function');
  });

  it('answers an empty batch without calling AWS', async () => {
    stubEnvironment();
    const { handler } = await import(entryPoint);
    await expect(handler({ Records: [] })).resolves.toEqual({
      batchItemFailures: [],
    });
  });

  it('ignores records outside the approved filter without calling AWS', async () => {
    stubEnvironment();
    const { handler } = await import(entryPoint);
    const record = (eventName: string, sk: string) => ({
      eventName,
      dynamodb: { Keys: { SK: { S: sk } }, SequenceNumber: '1' },
    });
    await expect(
      handler({
        Records: [record('MODIFY', 'OUTBOX#1'), record('INSERT', 'HISTORY#1')],
      }),
    ).resolves.toEqual({ batchItemFailures: [] });
  });

  it.each(['CLAIMFLOW_TABLE_NAME', 'CLAIMFLOW_EVENT_BUS_NAME'])(
    'fails to load without %s',
    async (missing) => {
      stubEnvironment();
      vi.stubEnv(missing, '');
      await expect(import(entryPoint)).rejects.toThrow(
        `The ${missing} environment variable is missing.`,
      );
    },
  );
});
