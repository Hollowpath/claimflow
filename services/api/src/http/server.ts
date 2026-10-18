import { readFile, stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

import { apiBasePath } from '@claimflow/contracts';

import type { ApiHandler, ApiRequest, ApiResponse } from './api-handler.js';

export interface ServerOptions {
  /** Directory of the built web app to serve, if any. */
  readonly webRoot?: string;
}

/**
 * The `node:http` transport: API requests go to the shared handler, and
 * other paths serve the built web app when `webRoot` is set.
 */
export function createHttpServer(
  handler: ApiHandler,
  options: ServerOptions = {},
): Server {
  return createServer((request, response) => {
    void handle(handler, options, request, response);
  });
}

async function handle(
  handler: ApiHandler,
  options: ServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';

  if (!url.pathname.startsWith(`${apiBasePath}/`)) {
    await serveWeb(options.webRoot, url.pathname, method, response);
    return;
  }

  send(response, await handler(toApiRequest(request, url, method)));
}

function toApiRequest(
  request: IncomingMessage,
  url: URL,
  method: string,
): ApiRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) {
      headers[name] = first;
    }
  }
  return {
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    readBody: (limitBytes) => readBody(request, limitBytes),
  };
}

async function readBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > limitBytes) {
    request.resume();
    return undefined;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > limitBytes) {
      request.resume();
      return undefined;
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function send(response: ServerResponse, apiResponse: ApiResponse): void {
  response.statusCode = apiResponse.status;
  for (const [name, value] of Object.entries(apiResponse.headers)) {
    response.setHeader(name, value);
  }
  response.end(apiResponse.body);
}

const staticTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

/** Serves the built single-page app, falling back to index.html. */
async function serveWeb(
  webRoot: string | undefined,
  pathname: string,
  method: string,
  response: ServerResponse,
): Promise<void> {
  if (webRoot === undefined || (method !== 'GET' && method !== 'HEAD')) {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Not found. The web app runs on http://localhost:5173.');
    return;
  }

  const root = resolve(webRoot);
  let file = resolve(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root + sep) || !(await isFile(file))) {
    file = join(root, 'index.html');
  }
  response.statusCode = 200;
  response.setHeader(
    'Content-Type',
    staticTypes[extname(file)] ?? 'application/octet-stream',
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(method === 'HEAD' ? undefined : await readFile(file));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
