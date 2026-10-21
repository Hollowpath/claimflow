import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HttpApiEvent } from '../src/http/lambda-adapter.js';

const entryPoint = '../src/adapters/aws/api-lambda.js';

/** What the mocked SDK saw; reset for every test. */
const seen = vi.hoisted(() => ({
  dynamoClients: 0,
  s3Clients: 0,
  documentClients: 0,
  uploadSigners: 0,
  downloadSigners: 0,
  commands: [] as string[],
  items: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    public constructor() {
      seen.dynamoClients += 1;
    }
  },
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    public constructor() {
      seen.s3Clients += 1;
    }
  },
}));
vi.mock('@aws-sdk/lib-dynamodb', async (importActual) => ({
  ...(await importActual<object>()),
  DynamoDBDocumentClient: {
    from: () => {
      seen.documentClients += 1;
      return {
        send: (command: { constructor: { name: string }; input: any }) => {
          seen.commands.push(command.constructor.name);
          switch (command.constructor.name) {
            case 'GetCommand':
              return Promise.resolve({
                Item: seen.items.get(
                  `${String(command.input.Key.PK)}|${String(command.input.Key.SK)}`,
                ),
              });
            case 'QueryCommand':
              return Promise.resolve({ Items: [] });
            default:
              return Promise.reject(new Error('unexpected command'));
          }
        },
      };
    },
  },
}));
vi.mock('../src/adapters/aws/s3-upload-form.js', async (importActual) => ({
  ...(await importActual<object>()),
  createS3UploadFormSigner: () => {
    seen.uploadSigners += 1;
    return () => Promise.reject(new Error('no live signing'));
  },
}));
vi.mock('../src/adapters/aws/s3-download-url.js', async (importActual) => ({
  ...(await importActual<object>()),
  createS3DownloadSigner: () => {
    seen.downloadSigners += 1;
    return () => Promise.reject(new Error('no live signing'));
  },
}));

function event(
  rawPath: string,
  claims?: Record<string, unknown>,
  method = 'GET',
): HttpApiEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'example.invalid',
      domainPrefix: 'example',
      http: {
        method,
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.1',
        userAgent: 'test',
      },
      requestId: 'r',
      routeKey: '$default',
      stage: '$default',
      time: '14/Oct/2026:10:41:00 +0000',
      timeEpoch: 0,
      ...(claims === undefined
        ? {}
        : {
            authorizer: {
              principalId: '',
              integrationLatency: 0,
              jwt: { claims, scopes: [] },
            },
          }),
    },
    isBase64Encoded: false,
  };
}

const settings = () => {
  vi.stubEnv('CLAIMFLOW_TABLE_NAME', 'ClaimFlow');
  vi.stubEnv('CLAIMFLOW_RECEIPT_BUCKET_NAME', 'receipts');
};

describe('API Lambda entry point', () => {
  beforeEach(() => {
    // The request log goes to stdout; keep it out of the test output.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    seen.dynamoClients = 0;
    seen.s3Clients = 0;
    seen.documentClients = 0;
    seen.uploadSigners = 0;
    seen.downloadSigners = 0;
    seen.commands = [];
    seen.items = new Map([
      [
        'USER#sub-aisha|PROFILE',
        {
          PK: 'USER#sub-aisha',
          SK: 'PROFILE',
          entityType: 'UserProfile',
          userId: 'sub-aisha',
          displayName: 'Aisha Rahman',
          title: 'Sales',
          roles: ['EMPLOYEE'],
        },
      ],
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exports only the handler', async () => {
    settings();
    const module = await import(entryPoint);
    expect(Object.keys(module)).toEqual(['handler']);
    expect(module.handler).toBeTypeOf('function');
  });

  it.each([
    ['CLAIMFLOW_TABLE_NAME', undefined],
    ['CLAIMFLOW_TABLE_NAME', ''],
    ['CLAIMFLOW_RECEIPT_BUCKET_NAME', undefined],
    ['CLAIMFLOW_RECEIPT_BUCKET_NAME', ''],
  ])(
    'fails to load with %s set to %j, before building any client',
    async (name, value) => {
      settings();
      vi.stubEnv(name, value);
      await expect(import(entryPoint)).rejects.toThrow(
        `The ${name} environment variable is missing.`,
      );
      expect(seen.dynamoClients + seen.s3Clients + seen.documentClients).toBe(
        0,
      );
    },
  );

  it('builds each client and signer once, outside the handler, and reuses them', async () => {
    settings();
    const { handler } = await import(entryPoint);
    expect(seen).toMatchObject({
      dynamoClients: 1,
      s3Clients: 1,
      documentClients: 1,
      uploadSigners: 1,
      downloadSigners: 1,
    });

    await handler(event('/api/v1/health'));
    await handler(event('/api/v1/health'));
    await handler(event('/api/v1/session', { sub: 'sub-aisha' }));

    expect(seen).toMatchObject({
      dynamoClients: 1,
      s3Clients: 1,
      documentClients: 1,
      uploadSigners: 1,
      downloadSigners: 1,
    });
  });

  it('answers the health check without calling AWS', async () => {
    settings();
    const { handler } = await import(entryPoint);
    const result = await handler(event('/api/v1/health'));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'ok' });
    expect(seen.commands).toEqual([]);
  });

  it('answers an unauthenticated request with 401 and reads nothing', async () => {
    settings();
    const { handler } = await import(entryPoint);
    const result = await handler(event('/api/v1/categories'));
    expect(result.statusCode).toBe(401);
    expect(seen.commands).toEqual([]);
  });

  it('serves an authenticated request from the verified subject and directory', async () => {
    settings();
    const { handler } = await import(entryPoint);

    const session = await handler(
      event('/api/v1/session', {
        sub: 'sub-aisha',
        'cognito:groups': ['ADMIN'],
      }),
    );
    expect(session.statusCode).toBe(200);
    expect(JSON.parse(session.body)).toMatchObject({
      user: {
        userId: 'sub-aisha',
        displayName: 'Aisha Rahman',
        roles: ['EMPLOYEE'],
      },
      users: [],
    });

    const categories = await handler(
      event('/api/v1/categories', { sub: 'sub-aisha' }),
    );
    expect(categories.statusCode).toBe(200);
    expect(JSON.parse(categories.body)).toEqual({ items: [] });
    expect(seen.commands).toContain('QueryCommand');
  });

  it('treats a subject missing from the directory as signed out', async () => {
    settings();
    const { handler } = await import(entryPoint);
    const result = await handler(
      event('/api/v1/categories', { sub: 'sub-ghost' }),
    );
    expect(result.statusCode).toBe(401);
  });
});
