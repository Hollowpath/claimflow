import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Application } from '../src/composition.js';
import { ApiClient, startServer } from './http-support.js';
import {
  pdfBytes,
  pngBytes,
  temporaryDirectory,
  testApplication,
} from './support.js';

let dir: Awaited<ReturnType<typeof temporaryDirectory>>;
let app: Application;
let server: Awaited<ReturnType<typeof startServer>>;
let aisha: ApiClient;
let ravi: ApiClient;
let ben: ApiClient;
let chloe: ApiClient;
let dan: ApiClient;

beforeEach(async () => {
  dir = await temporaryDirectory();
  app = await testApplication(dir.path);
  server = await startServer(app);
  const signIn = (userId: string) => ApiClient.signedIn(server.baseUrl, userId);
  aisha = await signIn('u-aisha');
  ravi = await signIn('u-ravi');
  ben = await signIn('u-ben');
  chloe = await signIn('u-chloe');
  dan = await signIn('u-dan');
});

afterEach(async () => {
  await server.close();
  await dir.remove();
});

const completeClaim = {
  categoryId: 'travel',
  amount: { amountMinor: 25_000, currency: 'MYR' },
  expenseDate: '2026-10-10',
  merchant: 'Regional Airline',
  businessPurpose: 'Client workshop at the regional office',
};

async function createClaim(body: object = completeClaim) {
  const response = await aisha.request('POST', '/claims', { body });
  expect(response.status).toBe(201);
  return response.body as { claimId: string; version: number };
}

async function uploadReceipt(client = aisha, content = pdfBytes) {
  const response = await client.request('POST', '/receipts', {
    raw: content,
    headers: {
      'Content-Type': 'application/pdf',
      'X-File-Name': encodeURIComponent('Client flight.pdf'),
    },
  });
  return response;
}

async function attachNewReceipt(claimId: string, expectedVersion: number) {
  const upload = (await uploadReceipt()).body;
  const response = await aisha.request('PUT', `/claims/${claimId}/receipt`, {
    body: {
      expectedVersion,
      receiptId: upload.receiptId,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      checksumSha256: upload.checksumSha256,
    },
  });
  expect(response.status).toBe(200);
  return response.body;
}

function act(
  client: ApiClient,
  claimId: string,
  action: string,
  expectedVersion: number,
  comment?: string,
) {
  return client.request('POST', `/claims/${claimId}/${action}`, {
    body: { expectedVersion, ...(comment === undefined ? {} : { comment }) },
  });
}

/** A submitted claim with a receipt, assigned to Ben. Version 3. */
async function submittedClaim() {
  const claim = await createClaim();
  await attachNewReceipt(claim.claimId, 1);
  const submitted = await act(aisha, claim.claimId, 'submit', 2);
  expect(submitted.status).toBe(200);
  return claim.claimId;
}

describe('authentication', () => {
  it('requires a selected local user', async () => {
    const anonymous = new ApiClient(server.baseUrl);
    const response = await anonymous.get('/me/claims');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
    expect((await anonymous.get('/session')).body.user).toBeNull();
  });

  it('ignores tampered session cookies', async () => {
    const forged = new ApiClient(server.baseUrl);
    forged.cookie = aisha.cookie!.replace('u-aisha', 'u-dan');
    expect((await forged.get('/claims')).status).toBe(401);
  });

  it('describes the signed-in user from the directory', async () => {
    const session = await aisha.get('/session');
    expect(session.body.user).toMatchObject({
      userId: 'u-aisha',
      roles: ['EMPLOYEE'],
      manager: { userId: 'u-ben', displayName: 'Ben Tan' },
    });
    expect(session.body.users).toHaveLength(5);
  });

  it('rejects unknown users and signs out', async () => {
    const client = new ApiClient(server.baseUrl);
    const unknown = await client.request('PUT', '/session', {
      body: { userId: 'u-nobody' },
    });
    expect(unknown.status).toBe(400);
    await aisha.request('DELETE', '/session');
    expect(aisha.cookie).toBeUndefined();
    expect((await aisha.get('/me/claims')).status).toBe(401);
  });
});

describe('complete workflow', () => {
  it('runs draft to paid with a full history', async () => {
    const claim = await createClaim({ merchant: 'Air' });
    const edited = await aisha.request('PATCH', `/claims/${claim.claimId}`, {
      body: { expectedVersion: 1, ...completeClaim },
    });
    expect(edited.body).toMatchObject({
      version: 2,
      merchant: 'Regional Airline',
    });

    const early = await act(aisha, claim.claimId, 'submit', 2);
    expect(early.status).toBe(400);
    expect(early.body.error.details).toEqual([
      expect.objectContaining({ field: 'receipt', code: 'RECEIPT_REQUIRED' }),
    ]);

    await attachNewReceipt(claim.claimId, 2);
    const submitted = await act(aisha, claim.claimId, 'submit', 3);
    expect(submitted.body).toMatchObject({
      status: 'SUBMITTED',
      assignedManager: { userId: 'u-ben' },
      permissions: { canEdit: false, actions: [] },
    });

    const queue = await ben.get('/review-queue');
    expect(queue.body.items.map((c: any) => c.claimId)).toEqual([
      claim.claimId,
    ]);

    expect((await act(ben, claim.claimId, 'start-review', 4)).status).toBe(200);
    const approved = await act(ben, claim.claimId, 'approve', 5, 'Approved.');
    expect(approved.body.status).toBe('APPROVED');
    expect((await ben.get('/review-queue')).body.items).toEqual([]);

    const paid = await act(dan, claim.claimId, 'mark-paid', 6);
    expect(paid.body).toMatchObject({ status: 'PAID', version: 7 });

    const history = await aisha.get(`/claims/${claim.claimId}/history`);
    expect(
      history.body.items.map((h: any) => [
        h.version,
        h.action,
        h.actor.displayName,
      ]),
    ).toEqual([
      [1, 'CREATE', 'Aisha Rahman'],
      [2, 'UPDATE', 'Aisha Rahman'],
      [3, 'ATTACH_RECEIPT', 'Aisha Rahman'],
      [4, 'SUBMIT', 'Aisha Rahman'],
      [5, 'START_REVIEW', 'Ben Tan'],
      [6, 'APPROVE', 'Ben Tan'],
      [7, 'MARK_PAID', 'Dan Wong'],
    ]);
    expect(history.body.items[5].comment).toBe('Approved.');
  });

  it('reopens, edits, and resubmits a rejected claim', async () => {
    const claimId = await submittedClaim();
    await act(ben, claimId, 'start-review', 3);
    const rejected = await act(ben, claimId, 'reject', 4, 'Wrong date.');
    expect(rejected.body.permissions.actions).toEqual([]);

    const blocked = await aisha.request('PATCH', `/claims/${claimId}`, {
      body: { expectedVersion: 5, expenseDate: '2026-10-09' },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CLAIM_NOT_EDITABLE');

    const reopened = await act(aisha, claimId, 'reopen', 5);
    expect(reopened.body).toMatchObject({
      status: 'DRAFT',
      permissions: { canEdit: true, actions: ['SUBMIT'] },
    });
    await aisha.request('PATCH', `/claims/${claimId}`, {
      body: { expectedVersion: 6, expenseDate: '2026-10-09' },
    });
    const resubmitted = await act(aisha, claimId, 'submit', 7);
    expect(resubmitted.body).toMatchObject({
      status: 'SUBMITTED',
      expenseDate: '2026-10-09',
    });
  });
});

describe('authorization and visibility', () => {
  it('hides claims from users who may not see them', async () => {
    const draft = await createClaim();
    for (const client of [ravi, ben, chloe]) {
      const response = await client.get(`/claims/${draft.claimId}`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
    expect((await dan.get(`/claims/${draft.claimId}`)).status).toBe(200);
    expect(
      (
        await ravi.request('PATCH', `/claims/${draft.claimId}`, {
          body: { expectedVersion: 1, merchant: 'Hacked' },
        })
      ).status,
    ).toBe(404);
    expect((await ravi.get(`/claims/${draft.claimId}/history`)).status).toBe(
      404,
    );
    expect((await ravi.get(`/claims/${draft.claimId}/receipt`)).status).toBe(
      404,
    );
    expect((await aisha.get('/claims/not-a-real-id')).status).toBe(404);
  });

  it('enforces roles and assignment on lifecycle actions', async () => {
    const claimId = await submittedClaim();

    const byOwner = await act(aisha, claimId, 'start-review', 3);
    expect(byOwner.status).toBe(403);
    expect(byOwner.body.error.code).toBe('SELF_REVIEW_FORBIDDEN');

    expect((await act(chloe, claimId, 'start-review', 3)).status).toBe(404);
    const edit = await ben.request('PATCH', `/claims/${claimId}`, {
      body: { expectedVersion: 3, merchant: 'X' },
    });
    expect(edit.status).toBe(403);

    await act(ben, claimId, 'start-review', 3);
    const blank = await act(ben, claimId, 'approve', 4, '   ');
    expect(blank.status).toBe(400);
    expect(blank.body.error.details[0].code).toBe('COMMENT_REQUIRED');

    const notApproved = await act(dan, claimId, 'mark-paid', 4);
    expect(notApproved.status).toBe(409);
    expect(notApproved.body.error.code).toBe('INVALID_TRANSITION');

    await act(ben, claimId, 'approve', 4, 'OK');
    expect((await act(ben, claimId, 'mark-paid', 5)).status).toBe(403);
  });

  it('prevents a manager approving their own claim', async () => {
    const own = await ben.request('POST', '/claims', { body: completeClaim });
    const claimId = own.body.claimId;
    const upload = (await uploadReceipt(ben)).body;
    await ben.request('PUT', `/claims/${claimId}/receipt`, {
      body: {
        expectedVersion: 1,
        receiptId: upload.receiptId,
        contentType: upload.contentType,
        sizeBytes: upload.sizeBytes,
        checksumSha256: upload.checksumSha256,
      },
    });
    const submitted = await act(ben, claimId, 'submit', 2);
    expect(submitted.body.assignedManager.userId).toBe('u-chloe');
    expect((await act(ben, claimId, 'start-review', 3)).status).toBe(403);
    expect((await act(chloe, claimId, 'start-review', 3)).status).toBe(200);
  });

  it('restricts lists to the right roles', async () => {
    await submittedClaim();
    expect((await chloe.get('/me/claims')).status).toBe(403);
    expect((await aisha.get('/review-queue')).status).toBe(403);
    expect((await chloe.get('/review-queue')).body.items).toEqual([]);
    expect((await ben.get('/claims')).status).toBe(403);

    const submitted = await dan.get('/claims?status=SUBMITTED');
    expect(submitted.body.items).toHaveLength(1);
    expect((await dan.get('/claims?status=PAID')).body.items).toEqual([]);
    expect((await ravi.get('/me/claims')).body.items).toEqual([]);
  });
});

describe('error contract', () => {
  it('returns consistent JSON errors with the request ID', async () => {
    const response = await aisha.request('POST', '/claims', {
      body: { employeeId: 'u-ravi', status: 'APPROVED' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: expect.any(String),
        requestId: response.headers.get('x-request-id'),
        details: [expect.objectContaining({ field: 'body' })],
      },
    });
  });

  it('rejects malformed bodies, wrong content types, and bad queries', async () => {
    expect(
      (await aisha.request('POST', '/claims', { body: '{ nope' })).status,
    ).toBe(400);
    expect(
      (
        await aisha.request('POST', '/claims', {
          body: '{}',
          headers: { 'Content-Type': 'text/plain' },
        })
      ).status,
    ).toBe(400);
    expect((await dan.get('/claims?status=LOST')).status).toBe(400);
    expect((await dan.get('/claims?limit=0')).status).toBe(400);
  });

  it('requires an idempotency key on mutations', async () => {
    const response = await aisha.request('POST', '/claims', {
      body: {},
      key: false,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe('Idempotency-Key');
  });

  it('hides unexpected failures behind a generic 500', async () => {
    app.claims.get = () => Promise.reject(new Error('disk exploded at C:\\x'));
    const response = await aisha.get('/claims/abc');
    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain('disk');
  });

  it('echoes a valid correlation ID', async () => {
    const response = await aisha.request('GET', '/me/claims', {
      headers: { 'X-Correlation-Id': 'trace-123' },
    });
    expect(response.headers.get('x-correlation-id')).toBe('trace-123');
  });

  it('answers a malformed percent-encoded path segment with 404', async () => {
    const response = await aisha.get('/claims/%E0%A4%A');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('optimistic concurrency', () => {
  it('rejects updates based on a stale version', async () => {
    const claim = await createClaim();
    await aisha.request('PATCH', `/claims/${claim.claimId}`, {
      body: { expectedVersion: 1, merchant: 'First' },
    });
    const stale = await aisha.request('PATCH', `/claims/${claim.claimId}`, {
      body: { expectedVersion: 1, merchant: 'Second' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await aisha.get(`/claims/${claim.claimId}`)).body.merchant).toBe(
      'First',
    );
  });
});

describe('idempotent retries', () => {
  it('replays a retried action without a duplicate effect', async () => {
    const claimId = await submittedClaim();
    const first = await ben.request('POST', `/claims/${claimId}/start-review`, {
      body: { expectedVersion: 3 },
      key: 'retry-key-0001',
    });
    const retry = await ben.request('POST', `/claims/${claimId}/start-review`, {
      body: { expectedVersion: 3 },
      key: 'retry-key-0001',
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');

    const history = await ben.get(`/claims/${claimId}/history`);
    expect(
      history.body.items.filter((h: any) => h.action === 'START_REVIEW'),
    ).toHaveLength(1);
  });

  it('creates one claim for a retried create', async () => {
    for (let i = 0; i < 3; i += 1) {
      await aisha.request('POST', '/claims', {
        body: completeClaim,
        key: 'create-key-0001',
      });
    }
    expect((await aisha.get('/me/claims')).body.items).toHaveLength(1);
  });

  it('refuses a reused key with a different request', async () => {
    await aisha.request('POST', '/claims', { body: {}, key: 'reuse-key-0001' });
    const reused = await aisha.request('POST', '/claims', {
      body: { merchant: 'Other' },
      key: 'reuse-key-0001',
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('pagination', () => {
  it('pages through history with opaque cursors', async () => {
    const claim = await createClaim({});
    for (let version = 1; version <= 4; version += 1) {
      await aisha.request('PATCH', `/claims/${claim.claimId}`, {
        body: { expectedVersion: version, merchant: `M${version}` },
      });
    }
    const first = await aisha.get(`/claims/${claim.claimId}/history?limit=3`);
    expect(first.body.items.map((h: any) => h.version)).toEqual([1, 2, 3]);
    const second = await aisha.get(
      `/claims/${claim.claimId}/history?limit=3&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((h: any) => h.version)).toEqual([4, 5]);
    expect(second.body.nextCursor).toBeUndefined();
  });
});

describe('categories', () => {
  it('lets administrators manage categories and limits', async () => {
    const created = await dan.request('POST', '/categories', {
      body: {
        name: 'Parking',
        currency: 'MYR',
        maxAmountMinor: 5_000,
        receiptRequiredAboveMinor: 1_000,
      },
    });
    expect(created.status).toBe(201);
    const { categoryId } = created.body;

    const updated = await dan.request('PATCH', `/categories/${categoryId}`, {
      body: { expectedVersion: 1, active: false, maxAmountMinor: 6_000 },
    });
    expect(updated.body).toMatchObject({
      active: false,
      maxAmountMinor: 6_000,
      version: 2,
    });

    const stale = await dan.request('PATCH', `/categories/${categoryId}`, {
      body: { expectedVersion: 1, name: 'Car park' },
    });
    expect(stale.status).toBe(409);

    const invalid = await dan.request('PATCH', `/categories/${categoryId}`, {
      body: { expectedVersion: 2, receiptRequiredAboveMinor: -1 },
    });
    expect(invalid.status).toBe(400);

    const inactive = await aisha.request('POST', '/claims', {
      body: { categoryId },
    });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.details[0].code).toBe('CATEGORY_INACTIVE');
  });

  it('forbids non-administrators from changing categories', async () => {
    const response = await ben.request('POST', '/categories', {
      body: {
        name: 'X',
        currency: 'MYR',
        maxAmountMinor: 1,
        receiptRequiredAboveMinor: 0,
      },
    });
    expect(response.status).toBe(403);
    expect(
      (
        await aisha.request('PATCH', '/categories/travel', {
          body: { expectedVersion: 1, active: false },
        })
      ).status,
    ).toBe(403);
    expect((await aisha.get('/categories')).body.items).toHaveLength(4);
  });

  it('re-evaluates the current policy when a claim is submitted', async () => {
    const claim = await createClaim({
      ...completeClaim,
      amount: { amountMinor: 10_000, currency: 'MYR' },
    });
    await dan.request('PATCH', '/categories/travel', {
      body: { expectedVersion: 1, maxAmountMinor: 5_000 },
    });
    const response = await act(aisha, claim.claimId, 'submit', 1);
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].code).toBe('LIMIT_EXCEEDED');
  });
});

describe('receipts', () => {
  it('serves a receipt with its inline Content-Disposition', async () => {
    const claim = await createClaim();
    await attachNewReceipt(claim.claimId, claim.version);

    const file = await aisha.get(`/claims/${claim.claimId}/receipt`);

    expect(file.headers.get('content-disposition')).toBe(
      `inline; filename="Client flight.pdf"; filename*=UTF-8''Client%20flight.pdf`,
    );
  });

  it('uploads, views, replaces, and removes a receipt', async () => {
    const claim = await createClaim();
    const upload = await uploadReceipt();
    expect(upload.status).toBe(201);
    expect(upload.body).toMatchObject({
      fileName: 'Client flight.pdf',
      sizeBytes: pdfBytes.byteLength,
    });

    await attachNewReceipt(claim.claimId, 1);
    const file = await aisha.get(`/claims/${claim.claimId}/receipt`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toContain(
      'Client%20flight.pdf',
    );
    expect(file.body).toEqual(pdfBytes);

    const replaced = await attachNewReceipt(claim.claimId, 2);
    expect(replaced.version).toBe(3);

    const removed = await aisha.request(
      'DELETE',
      `/claims/${claim.claimId}/receipt`,
      { body: { expectedVersion: 3 } },
    );
    expect(removed.body.receipt).toBeUndefined();
    expect((await aisha.get(`/claims/${claim.claimId}/receipt`)).status).toBe(
      404,
    );
  });

  it('lets the assigned manager and administrators view receipts', async () => {
    const claimId = await submittedClaim();
    expect((await ben.get(`/claims/${claimId}/receipt`)).status).toBe(200);
    expect((await dan.get(`/claims/${claimId}/receipt`)).status).toBe(200);
    expect((await chloe.get(`/claims/${claimId}/receipt`)).status).toBe(404);
  });

  it('rejects oversized, mistyped, or mismatched receipts', async () => {
    const tooLarge = await aisha.request('POST', '/receipts', {
      raw: new Uint8Array(10 * 1024 * 1024 + 1),
      headers: { 'Content-Type': 'application/pdf' },
    });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    const mistyped = await aisha.request('POST', '/receipts', {
      raw: pngBytes,
      headers: { 'Content-Type': 'application/pdf' },
    });
    expect(mistyped.status).toBe(400);

    const html = await aisha.request('POST', '/receipts', {
      raw: new TextEncoder().encode('<html>'),
      headers: { 'Content-Type': 'text/html' },
    });
    expect(html.status).toBe(400);

    const claim = await createClaim();
    const upload = (await uploadReceipt()).body;
    const mismatch = await aisha.request(
      'PUT',
      `/claims/${claim.claimId}/receipt`,
      {
        body: {
          expectedVersion: 1,
          receiptId: upload.receiptId,
          contentType: 'application/pdf',
          sizeBytes: upload.sizeBytes,
          checksumSha256: '0'.repeat(64),
        },
      },
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.details[0].code).toBe('RECEIPT_MISMATCH');

    const missing = await aisha.request(
      'PUT',
      `/claims/${claim.claimId}/receipt`,
      { body: { expectedVersion: 1 } },
    );
    expect(missing.status).toBe(400);
  });
});

describe('restarts', () => {
  it('keeps data and sessions across a restart', async () => {
    const claimId = await submittedClaim();
    await server.close();

    app = await testApplication(dir.path);
    server = await startServer(app);
    const restarted = new ApiClient(server.baseUrl);
    restarted.cookie = aisha.cookie;
    const claim = await restarted.get(`/claims/${claimId}`);
    expect(claim.body).toMatchObject({ status: 'SUBMITTED', version: 3 });
  });
});

describe('deleting drafts', () => {
  it('lets the owner delete a never-submitted draft with its receipt', async () => {
    const claim = await createClaim();
    await attachNewReceipt(claim.claimId, 1);
    expect(
      (await aisha.get(`/claims/${claim.claimId}`)).body.permissions,
    ).toMatchObject({ canDelete: true });

    const deleted = await aisha.request('DELETE', `/claims/${claim.claimId}`, {
      body: { expectedVersion: 2 },
      key: 'delete-key-0001',
    });
    expect(deleted.status).toBe(204);

    const retry = await aisha.request('DELETE', `/claims/${claim.claimId}`, {
      body: { expectedVersion: 2 },
      key: 'delete-key-0001',
    });
    expect(retry.status).toBe(204);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');

    expect((await aisha.get(`/claims/${claim.claimId}`)).status).toBe(404);
    expect((await aisha.get(`/claims/${claim.claimId}/history`)).status).toBe(
      404,
    );
    expect((await aisha.get('/me/claims')).body.items).toEqual([]);
    expect((await dan.get('/claims')).body.items).toEqual([]);
  });

  it('refuses other users, stale versions, and submitted claims', async () => {
    const claim = await createClaim();
    const remove = (client: ApiClient, expectedVersion: number) =>
      client.request('DELETE', `/claims/${claim.claimId}`, {
        body: { expectedVersion },
      });

    expect((await remove(ravi, 1)).status).toBe(404);
    expect((await remove(dan, 1)).status).toBe(403);
    expect((await remove(aisha, 9)).status).toBe(409);

    const claimId = await submittedClaim();
    const submitted = await aisha.request('DELETE', `/claims/${claimId}`, {
      body: { expectedVersion: 3 },
    });
    expect(submitted.status).toBe(409);
    expect(submitted.body.error.code).toBe('CLAIM_NOT_EDITABLE');
  });

  it('keeps a reopened draft and its review history', async () => {
    const claimId = await submittedClaim();
    await act(ben, claimId, 'start-review', 3);
    await act(ben, claimId, 'reject', 4, 'Missing detail.');
    const reopened = await act(aisha, claimId, 'reopen', 5);
    expect(reopened.body.permissions.canDelete).toBe(false);

    const response = await aisha.request('DELETE', `/claims/${claimId}`, {
      body: { expectedVersion: 6 },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CLAIM_NOT_DELETABLE');
    expect((await aisha.get(`/claims/${claimId}`)).status).toBe(200);
  });
});

describe('deleting categories', () => {
  async function newCategory() {
    const created = await dan.request('POST', '/categories', {
      body: {
        name: 'Parking',
        currency: 'MYR',
        maxAmountMinor: 5_000,
        receiptRequiredAboveMinor: 0,
      },
    });
    return created.body.categoryId as string;
  }

  it('deletes an unused category', async () => {
    const categoryId = await newCategory();
    const response = await dan.request('DELETE', `/categories/${categoryId}`, {
      body: { expectedVersion: 1 },
    });
    expect(response.status).toBe(204);
    const names = (await dan.get('/categories')).body.items.map(
      (c: any) => c.name,
    );
    expect(names).not.toContain('Parking');
  });

  it('refuses categories used by any claim, even a draft', async () => {
    const categoryId = await newCategory();
    await createClaim({ categoryId });
    const response = await dan.request('DELETE', `/categories/${categoryId}`, {
      body: { expectedVersion: 1 },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CATEGORY_IN_USE');
    expect(response.body.error.message).toMatch(/Deactivate it instead/);
  });

  it('is limited to administrators and checks versions', async () => {
    const categoryId = await newCategory();
    const byEmployee = await aisha.request(
      'DELETE',
      `/categories/${categoryId}`,
      { body: { expectedVersion: 1 } },
    );
    expect(byEmployee.status).toBe(403);
    const stale = await dan.request('DELETE', `/categories/${categoryId}`, {
      body: { expectedVersion: 2 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const missing = await dan.request('DELETE', '/categories/nope', {
      body: { expectedVersion: 1 },
    });
    expect(missing.status).toBe(404);
  });
});
