import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonDatabase } from '../src/adapters/local/json-database.js';
import { seedState } from '../src/adapters/local/seed.js';
import { localDataPaths, type Application } from '../src/composition.js';
import {
  actors,
  pdfBytes,
  pngBytes,
  temporaryDirectory,
  testApplication,
} from './support.js';

const { aisha, ravi, ben, dan } = actors;

let dir: { path: string; remove: () => Promise<void> };
let app: Application;

beforeEach(async () => {
  dir = await temporaryDirectory();
  app = await testApplication(dir.path);
});

afterEach(async () => {
  await dir.remove();
});

const complete = {
  categoryId: 'travel',
  amount: { amountMinor: 15_000, currency: 'MYR' },
  expenseDate: '2026-10-10',
  merchant: 'City Taxi',
  businessPurpose: 'Client visit',
};

describe('persistence', () => {
  it('keeps claims, history, and categories across restarts', async () => {
    const claim = await app.claims.create(aisha, complete);
    await app.claims.perform(aisha, claim.claimId, 'SUBMIT', {
      expectedVersion: 1,
    });
    await app.categories.create(dan, {
      name: 'Parking',
      currency: 'MYR',
      maxAmountMinor: 5_000,
      receiptRequiredAboveMinor: 0,
    });

    const restarted = await testApplication(dir.path);
    expect(await restarted.claims.get(aisha, claim.claimId)).toMatchObject({
      status: 'SUBMITTED',
      version: 2,
    });
    const history = await restarted.claims.history(aisha, claim.claimId, {
      limit: 10,
    });
    expect(history.items.map((h) => h.action)).toEqual(['CREATE', 'SUBMIT']);
    expect((await restarted.categories.list()).map((c) => c.name)).toContain(
      'Parking',
    );
  });

  it('refuses to start on unreadable data instead of overwriting it', async () => {
    const { database } = localDataPaths(dir.path);
    await writeFile(database, '{ not json');
    await expect(testApplication(dir.path)).rejects.toThrow(/reset-data/);
    expect(await readFile(database, 'utf8')).toBe('{ not json');
  });

  it('leaves state untouched when a write fails', async () => {
    const db = JsonDatabase.inMemory(seedState());
    await expect(
      db.write((state) => {
        delete state.categories.travel;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(db.read((s) => s.categories.travel)).toBeDefined();
  });
});

describe('optimistic concurrency', () => {
  it('lets exactly one of two concurrent edits win', async () => {
    const claim = await app.claims.create(aisha, {});
    const results = await Promise.allSettled([
      app.claims.update(aisha, claim.claimId, {
        expectedVersion: 1,
        merchant: 'First',
      }),
      app.claims.update(aisha, claim.claimId, {
        expectedVersion: 1,
        merchant: 'Second',
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'VERSION_CONFLICT' },
    });
    const history = await app.claims.history(aisha, claim.claimId, {
      limit: 10,
    });
    expect(history.items.map((h) => h.version)).toEqual([1, 2]);
  });

  it('rejects a stale expected version', async () => {
    const claim = await app.claims.create(aisha, {});
    await app.claims.update(aisha, claim.claimId, {
      expectedVersion: 1,
      merchant: 'A',
    });
    await expect(
      app.claims.update(aisha, claim.claimId, {
        expectedVersion: 1,
        merchant: 'B',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

describe('history', () => {
  it('returns copies so stored history cannot be altered', async () => {
    const claim = await app.claims.create(aisha, {});
    const first = await app.claims.history(aisha, claim.claimId, { limit: 5 });
    Object.assign(first.items[0]!, { action: 'TAMPERED' });
    const second = await app.claims.history(aisha, claim.claimId, {
      limit: 5,
    });
    expect(second.items[0]?.action).toBe('CREATE');
  });
});

describe('pagination', () => {
  it('walks every page exactly once', async () => {
    for (let i = 0; i < 5; i += 1) {
      await app.claims.create(aisha, { merchant: `M${i}` });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await app.claims.listMine(aisha, { limit: 2, cursor });
      seen.push(...page.items.map((c) => c.merchant ?? ''));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual(['M4', 'M3', 'M2', 'M1', 'M0']);
  });

  it('rejects malformed cursors and cursors from another list', async () => {
    await app.claims.create(aisha, {});
    await app.claims.create(aisha, {});
    const page = await app.claims.listMine(aisha, { limit: 1 });
    await expect(
      app.claims.listMine(aisha, { limit: 1, cursor: 'garbage' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      app.claims.listAll(dan, undefined, {
        limit: 1,
        cursor: page.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('idempotency', () => {
  const ok = (body: unknown) => Promise.resolve({ status: 201, body });

  it('replays the original response for a retry', async () => {
    const first = await app.idempotency.run('u-aisha', 'key-00001', 'f1', () =>
      ok({ n: 1 }),
    );
    const retry = await app.idempotency.run('u-aisha', 'key-00001', 'f1', () =>
      ok({ n: 2 }),
    );
    expect(first).toEqual({
      response: { status: 201, body: { n: 1 } },
      replayed: false,
    });
    expect(retry).toEqual({
      response: { status: 201, body: { n: 1 } },
      replayed: true,
    });
  });

  it('scopes keys to the actor and refuses reuse for another request', async () => {
    await app.idempotency.run('u-aisha', 'key-00001', 'f1', () => ok(1));
    await expect(
      app.idempotency.run('u-aisha', 'key-00001', 'f2', () => ok(2)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      (await app.idempotency.run('u-ravi', 'key-00001', 'f2', () => ok(3)))
        .replayed,
    ).toBe(false);
  });

  it('releases the key after an unexpected failure', async () => {
    await expect(
      app.idempotency.run('u-aisha', 'key-00002', 'f1', () =>
        Promise.reject(new Error('crash')),
      ),
    ).rejects.toThrow('crash');
    const retry = await app.idempotency.run('u-aisha', 'key-00002', 'f1', () =>
      ok('done'),
    );
    expect(retry.replayed).toBe(false);
  });

  it('reports a request that is still running', async () => {
    let finish!: () => void;
    const running = app.idempotency.run(
      'u-aisha',
      'key-00003',
      'f1',
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: 200, body: null });
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      app.idempotency.run('u-aisha', 'key-00003', 'f1', () => ok(null)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    finish();
    await running;
  });
});

describe('receipts', () => {
  async function uploadPdf(actor = aisha) {
    return app.receipts.upload(actor, {
      fileName: '../scan.pdf',
      contentType: 'application/pdf',
      content: pdfBytes,
    });
  }

  const declarationOf = (upload: Awaited<ReturnType<typeof uploadPdf>>) => ({
    receiptId: upload.receiptId,
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes,
    checksumSha256: upload.checksumSha256,
  });

  it('measures uploads on the server', async () => {
    const upload = await uploadPdf();
    expect(upload).toMatchObject({
      fileName: 'scan.pdf',
      contentType: 'application/pdf',
      sizeBytes: pdfBytes.byteLength,
      checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/) as string,
    });
  });

  it('rejects files whose contents do not match their type', async () => {
    await expect(
      app.receipts.upload(aisha, {
        fileName: 'fake.pdf',
        contentType: 'application/pdf',
        content: pngBytes,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ code: 'INVALID_RECEIPT_TYPE' })],
    });
    await expect(
      app.receipts.upload(dan, {
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        content: pdfBytes,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('attaches, replaces, reads, and removes receipts', async () => {
    const claim = await app.claims.create(aisha, complete);
    const first = await uploadPdf();
    const attached = await app.receipts.attach(aisha, claim.claimId, {
      expectedVersion: 1,
      ...declarationOf(first),
    });
    expect(attached.receipt?.receiptId).toBe(first.receiptId);

    const second = await app.receipts.upload(aisha, {
      fileName: 'photo.png',
      contentType: 'image/png',
      content: pngBytes,
    });
    const replaced = await app.receipts.attach(aisha, claim.claimId, {
      expectedVersion: 2,
      ...declarationOf(second),
    });
    expect(replaced.receipt?.fileName).toBe('photo.png');

    const files = await readdir(localDataPaths(dir.path).receipts);
    expect(files.some((f) => f.startsWith(first.receiptId))).toBe(false);

    // The manager cannot see a draft that was never submitted to them.
    await expect(app.receipts.read(ben, claim.claimId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await app.receipts.read(aisha, claim.claimId)).content).toEqual(
      pngBytes,
    );

    const removed = await app.receipts.remove(aisha, claim.claimId, 3);
    expect(removed.receipt).toBeUndefined();
    await expect(app.receipts.read(aisha, claim.claimId)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('rejects missing, foreign, mismatched, or reused uploads', async () => {
    const claim = await app.claims.create(aisha, {});
    const upload = await uploadPdf();
    const attach = (declaration: object, actor = aisha) =>
      app.receipts.attach(actor, claim.claimId, {
        expectedVersion: 1,
        ...declarationOf(upload),
        ...declaration,
      });

    await expect(attach({ receiptId: 'missing' })).rejects.toMatchObject({
      details: [expect.objectContaining({ code: 'RECEIPT_UNAVAILABLE' })],
    });
    await expect(attach({ sizeBytes: 1 })).rejects.toMatchObject({
      violations: [expect.objectContaining({ code: 'RECEIPT_MISMATCH' })],
    });

    // Ownership and reuse are domain rules, reported as domain violations.
    const raviUpload = await uploadPdf(ravi);
    await expect(attach(declarationOf(raviUpload))).rejects.toMatchObject({
      violations: [expect.objectContaining({ code: 'RECEIPT_UNAVAILABLE' })],
    });

    await attach({});
    const other = await app.claims.create(aisha, {});
    await expect(
      app.receipts.attach(aisha, other.claimId, {
        expectedVersion: 1,
        ...declarationOf(upload),
      }),
    ).rejects.toMatchObject({
      violations: [expect.objectContaining({ code: 'RECEIPT_UNAVAILABLE' })],
    });
  });

  it('refuses an upload whose stored bytes were altered', async () => {
    const claim = await app.claims.create(aisha, {});
    const upload = await uploadPdf();
    await writeFile(
      join(localDataPaths(dir.path).receipts, `${upload.receiptId}.bin`),
      pngBytes,
    );
    await expect(
      app.receipts.attach(aisha, claim.claimId, {
        expectedVersion: 1,
        ...declarationOf(upload),
      }),
    ).rejects.toMatchObject({
      details: [expect.objectContaining({ code: 'RECEIPT_UNAVAILABLE' })],
    });
  });

  it('purges abandoned uploads but keeps attached ones', async () => {
    const claim = await app.claims.create(aisha, {});
    const kept = await uploadPdf();
    await uploadPdf();
    await app.receipts.attach(aisha, claim.claimId, {
      expectedVersion: 1,
      ...declarationOf(kept),
    });
    expect(await app.receipts.purgeAbandonedUploads(0)).toBe(1);
    expect((await app.receipts.read(aisha, claim.claimId)).content).toEqual(
      pdfBytes,
    );
  });
});
