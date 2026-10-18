import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

import type { ApiHandler, ApiRequest, ApiResponse } from './api-handler.js';

/**
 * An API Gateway HTTP API event in payload format 2.0, from a route with or
 * without the JWT authorizer.
 */
export type HttpApiEvent =
  APIGatewayProxyEventV2 | APIGatewayProxyEventV2WithJWTAuthorizer;

export type HttpApiResult = APIGatewayProxyStructuredResultV2;

/**
 * The AWS Lambda transport for API Gateway HTTP API events. Every request,
 * including a failing one, is answered by the shared handler.
 */
export function createHttpApiAdapter(
  handler: ApiHandler,
): (event: HttpApiEvent) => Promise<HttpApiResult> {
  return async (event) => toHttpApiResult(await handler(toApiRequest(event)));
}

export function toApiRequest(event: HttpApiEvent): ApiRequest {
  const body = requestBody(event);
  const verifiedSubject = subjectOf(event);
  return {
    method: event.requestContext.http.method.toUpperCase(),
    path: event.rawPath,
    query: Object.fromEntries(new URLSearchParams(event.rawQueryString)),
    headers: requestHeaders(event),
    ...(verifiedSubject === undefined ? {} : { verifiedSubject }),
    readBody: (limitBytes) =>
      Promise.resolve(body.byteLength > limitBytes ? undefined : body),
  };
}

export function toHttpApiResult(response: ApiResponse): HttpApiResult {
  const { status, headers, body } = response;
  if (body === undefined) {
    return { statusCode: status, headers: { ...headers } };
  }
  if (typeof body === 'string') {
    return {
      statusCode: status,
      headers: { ...headers },
      body,
      isBase64Encoded: false,
    };
  }
  return {
    statusCode: status,
    headers: { ...headers },
    body: Buffer.from(body).toString('base64'),
    isBase64Encoded: true,
  };
}

/**
 * Header names in lower case. Payload format 2.0 moves request cookies out of
 * the headers into `cookies`, so they are joined back into a `cookie` header.
 */
function requestHeaders(event: HttpApiEvent): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers[name.toLowerCase()] = value;
    }
  }
  if (event.cookies !== undefined && event.cookies.length > 0) {
    headers.cookie ??= event.cookies.join('; ');
  }
  return headers;
}

function requestBody(event: HttpApiEvent): Uint8Array {
  if (event.body === undefined) {
    return new Uint8Array();
  }
  return new Uint8Array(
    Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'),
  );
}

/**
 * The `sub` claim validated by the JWT authorizer, if present and a non-empty
 * string. No other claim is read: roles and manager assignments always come
 * from the user's profile, never from the token.
 */
function subjectOf(event: HttpApiEvent): string | undefined {
  // Routes without the authorizer have no `authorizer`, so nothing is assumed.
  const { authorizer } = event.requestContext as {
    readonly authorizer?: { readonly jwt?: { readonly claims?: unknown } };
  };
  const claims = authorizer?.jwt?.claims;
  if (typeof claims !== 'object' || claims === null) {
    return undefined;
  }
  const sub = (claims as Record<string, unknown>).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : undefined;
}
