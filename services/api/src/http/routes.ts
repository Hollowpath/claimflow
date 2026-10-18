import {
  adminClaimListQuerySchema,
  attachReceiptRequestSchema,
  claimActionPaths,
  claimActionRequestSchema,
  claimDecisionRequestSchema,
  claimListQuerySchema,
  createCategoryRequestSchema,
  createClaimRequestSchema,
  deleteRequestSchema,
  headers,
  idSchema,
  selectUserRequestSchema,
  updateCategoryRequestSchema,
  updateClaimRequestSchema,
  type ClaimAction,
} from '@claimflow/contracts';
import type { Actor } from '@claimflow/domain';

import { NotFoundError, ValidationError } from '../application/errors.js';
import type { Application } from '../composition.js';
import type { SessionCookies } from './session-cookie.js';

export interface RouteContext {
  readonly actor: Actor | undefined;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Parsed JSON body (`json` routes only). */
  readonly body: unknown;
  /** Raw body bytes (`raw` routes only). */
  readonly raw: Uint8Array;
  readonly header: (name: string) => string | undefined;
}

export interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** A binary response body; takes precedence over `body`. */
  readonly file?: Uint8Array;
}

export interface Route {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly operation: string;
  /** Whether a signed-in user is required. */
  readonly auth: boolean;
  /** Whether an `Idempotency-Key` header is required and honoured. */
  readonly idempotent: boolean;
  readonly body: 'none' | 'json' | 'raw';
  readonly handle: (context: RouteContext) => Promise<Reply>;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const created = (body: unknown): Reply => ({ status: 201, body });
const noContent: Reply = { status: 204 };

/** The signed-in actor; the server checks `auth` before calling handlers. */
function actorOf(context: RouteContext): Actor {
  if (context.actor === undefined) {
    throw new Error('Route requires authentication.');
  }
  return context.actor;
}

/** Malformed IDs cannot exist, so they are reported as not found. */
function idParam(context: RouteContext, name: string): string {
  const parsed = idSchema.safeParse(context.params[name]);
  if (!parsed.success) {
    throw new NotFoundError();
  }
  return parsed.data;
}

const health: Route = {
  method: 'GET',
  path: '/health',
  operation: 'health',
  auth: false,
  idempotent: false,
  body: 'none',
  handle: () => Promise.resolve(ok({ status: 'ok' })),
};

/**
 * The local development runtime's routes. Development sign-in selects and
 * clears a sample user through `PUT` and `DELETE /session`, and
 * `GET /session` lists the selectable users.
 */
export function createLocalRoutes(
  app: Application,
  cookies: SessionCookies,
): Route[] {
  return [
    health,
    {
      method: 'GET',
      path: '/session',
      operation: 'session.get',
      auth: false,
      idempotent: false,
      body: 'none',
      handle: async (context) => ok(await app.sessions.describe(context.actor)),
    },
    {
      method: 'PUT',
      path: '/session',
      operation: 'session.select',
      auth: false,
      idempotent: false,
      body: 'json',
      handle: async (context) => {
        const { userId } = selectUserRequestSchema.parse(context.body);
        const actor = await app.sessions.actorFor(userId);
        if (actor === undefined) {
          throw new ValidationError('Unknown user.', [
            { field: 'userId', code: 'UNKNOWN_USER', message: 'Unknown user.' },
          ]);
        }
        return {
          ...ok(await app.sessions.describe(actor)),
          headers: { 'Set-Cookie': cookies.issue(actor.userId) },
        };
      },
    },
    {
      method: 'DELETE',
      path: '/session',
      operation: 'session.clear',
      auth: false,
      idempotent: false,
      body: 'none',
      handle: async () => ({
        ...ok(await app.sessions.describe(undefined)),
        headers: { 'Set-Cookie': cookies.clear() },
      }),
    },
    ...applicationRoutes(app),
  ];
}

/**
 * The AWS runtime's routes. Users sign in through Cognito, so there is no
 * way to select or clear a user, and `GET /session` describes only the
 * signed-in user, never the other users.
 */
export function createAwsRoutes(app: Application): Route[] {
  return [
    health,
    {
      method: 'GET',
      path: '/session',
      operation: 'session.get',
      auth: false,
      idempotent: false,
      body: 'none',
      handle: async (context) =>
        ok(await app.sessions.describeSignedIn(context.actor)),
    },
    ...applicationRoutes(app),
  ];
}

/** Every route other than health and sessions; the same in both runtimes. */
function applicationRoutes(app: Application): Route[] {
  const claimId = (context: RouteContext) => idParam(context, 'claimId');

  const actionRoutes = (
    Object.entries(claimActionPaths) as [ClaimAction, string][]
  ).map(([action, segment]): Route => ({
    method: 'POST',
    path: `/claims/:claimId/${segment}`,
    operation: `claim.${segment}`,
    auth: true,
    idempotent: true,
    body: 'json',
    handle: async (context) => {
      const input =
        action === 'APPROVE' || action === 'REJECT'
          ? claimDecisionRequestSchema.parse(context.body)
          : claimActionRequestSchema.parse(context.body);
      return ok(
        await app.claims.perform(
          actorOf(context),
          claimId(context),
          action,
          input,
        ),
      );
    },
  }));

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/categories',
      operation: 'category.list',
      auth: true,
      idempotent: false,
      body: 'none',
      handle: async () => ok({ items: await app.categories.list() }),
    },
    {
      method: 'POST',
      path: '/categories',
      operation: 'category.create',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: async (context) =>
        created(
          await app.categories.create(
            actorOf(context),
            createCategoryRequestSchema.parse(context.body),
          ),
        ),
    },
    {
      method: 'PATCH',
      path: '/categories/:categoryId',
      operation: 'category.update',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: async (context) =>
        ok(
          await app.categories.update(
            actorOf(context),
            idParam(context, 'categoryId'),
            updateCategoryRequestSchema.parse(context.body),
          ),
        ),
    },
    {
      method: 'DELETE',
      path: '/categories/:categoryId',
      operation: 'category.delete',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: async (context) => {
        const { expectedVersion } = deleteRequestSchema.parse(context.body);
        await app.categories.delete(
          actorOf(context),
          idParam(context, 'categoryId'),
          expectedVersion,
        );
        return noContent;
      },
    },
    {
      method: 'GET',
      path: '/me/claims',
      operation: 'claim.list_mine',
      auth: true,
      idempotent: false,
      body: 'none',
      handle: async (context) =>
        ok(
          await app.claims.listMine(
            actorOf(context),
            claimListQuerySchema.parse(context.query),
          ),
        ),
    },
    {
      method: 'GET',
      path: '/review-queue',
      operation: 'claim.list_review_queue',
      auth: true,
      idempotent: false,
      body: 'none',
      handle: async (context) =>
        ok(
          await app.claims.listReviewQueue(
            actorOf(context),
            claimListQuerySchema.parse(context.query),
          ),
        ),
    },
    {
      method: 'GET',
      path: '/claims',
      operation: 'claim.list_all',
      auth: true,
      idempotent: false,
      body: 'none',
      handle: async (context) => {
        const { status, ...page } = adminClaimListQuerySchema.parse(
          context.query,
        );
        return ok(await app.claims.listAll(actorOf(context), status, page));
      },
    },
    {
      method: 'POST',
      path: '/claims',
      operation: 'claim.create',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: async (context) =>
        created(
          await app.claims.create(
            actorOf(context),
            createClaimRequestSchema.parse(context.body),
          ),
        ),
    },
    {
      method: 'GET',
      path: '/claims/:claimId',
      operation: 'claim.get',
      auth: true,
      idempotent: false,
      body: 'none',
      handle: async (context) =>
        ok(await app.claims.get(actorOf(context), claimId(context))),
    },
    {
      method: 'PATCH',
      path: '/claims/:claimId',
      operation: 'claim.update',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: async (context) =>
        ok(
          await app.claims.update(
            actorOf(context),
            claimId(context),
            updateClaimRequestSchema.parse(context.body),
          ),
        ),
    },
    {
      method: 'DELETE',
      path: '/claims/:claimId',
      operation: 'claim.delete',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: async (context) => {
        const { expectedVersion } = deleteRequestSchema.parse(context.body);
        await app.claims.delete(
          actorOf(context),
          claimId(context),
          expectedVersion,
        );
        return noContent;
      },
    },
    {
      method: 'GET',
      path: '/claims/:claimId/history',
      operation: 'claim.history',
      auth: true,
      idempotent: false,
      body: 'none',
      handle: async (context) =>
        ok(
          await app.claims.history(
            actorOf(context),
            claimId(context),
            claimListQuerySchema.parse(context.query),
          ),
        ),
    },
    ...actionRoutes,
    {
      method: 'POST',
      path: '/receipts',
      operation: 'receipt.upload',
      auth: true,
      idempotent: true,
      body: 'raw',
      handle: async (context) =>
        created(
          await app.receipts.upload(actorOf(context), {
            fileName: decodeFileName(context.header(headers.fileName)),
            contentType: (context.header('content-type') ?? '')
              .split(';')[0]!
              .trim()
              .toLowerCase(),
            content: context.raw,
          }),
        ),
    },
    {
      method: 'PUT',
      path: '/claims/:claimId/receipt',
      operation: 'receipt.attach',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: async (context) =>
        ok(
          await app.receipts.attach(
            actorOf(context),
            claimId(context),
            attachReceiptRequestSchema.parse(context.body),
          ),
        ),
    },
    {
      method: 'DELETE',
      path: '/claims/:claimId/receipt',
      operation: 'receipt.remove',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: async (context) => {
        const { expectedVersion } = claimActionRequestSchema.parse(
          context.body,
        );
        return ok(
          await app.receipts.remove(
            actorOf(context),
            claimId(context),
            expectedVersion,
          ),
        );
      },
    },
    {
      method: 'GET',
      path: '/claims/:claimId/receipt',
      operation: 'receipt.read',
      auth: true,
      idempotent: false,
      body: 'none',
      handle: async (context) => {
        const file = await app.receipts.read(
          actorOf(context),
          claimId(context),
        );
        return {
          status: 200,
          file: file.content,
          headers: {
            'Content-Type': file.contentType,
            'Content-Disposition': contentDisposition(file.fileName),
          },
        };
      },
    },
  ];
  return routes;
}

function decodeFileName(header: string | undefined): string {
  if (header === undefined) {
    return '';
  }
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/** `inline` with an ASCII fallback and an RFC 5987 UTF-8 file name. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
