import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';

const entryPoint = '../src/adapters/aws/outbox-sweeper-lambda.js';

describe('outbox sweeper Lambda entry point', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it('queries the pending outbox index of the configured table', async () => {
    stubEnvironment();
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, 'send')
      .mockResolvedValue({ Items: [] } as never);
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const { handler } = await import(entryPoint);

    await expect(handler()).resolves.toEqual({ selected: 0 });

    const metric = written.map((line) => JSON.parse(line)).at(-1);
    expect(metric.OldestPendingOutboxAge).toBe(0);
    expect(metric._aws.CloudWatchMetrics[0].Namespace).toBe('ClaimFlow');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls.at(0)?.at(0) as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input.TableName).toBe('ClaimFlow');
    expect(command.input.IndexName).toBe('GSI4');
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
