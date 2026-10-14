import { describe, expect, it } from 'vitest';

import {
  attachReceipt,
  detectReceiptContentType,
  maxReceiptSizeBytes,
  removeReceipt,
  sanitizeFileName,
  validateReceiptFile,
  verifyReceiptForAttachment,
  type ReceiptDeclaration,
} from '../src/index.js';
import { aisha, as, claimIn, draft, ravi, upload } from './fixtures.js';

const declared: ReceiptDeclaration = {
  contentType: 'application/pdf',
  sizeBytes: 2048,
  checksumSha256: 'a'.repeat(64),
};

const codes = (violations: readonly { code: string }[]) =>
  violations.map((v) => v.code);

describe('receipt files', () => {
  it.each([
    ['application/pdf', 1, []],
    ['image/jpeg', maxReceiptSizeBytes, []],
    ['image/png', maxReceiptSizeBytes + 1, ['INVALID_RECEIPT_SIZE']],
    ['image/png', 0, ['INVALID_RECEIPT_SIZE']],
    ['image/gif', 10, ['INVALID_RECEIPT_TYPE']],
    ['text/html', 10, ['INVALID_RECEIPT_TYPE']],
  ])('validates %s of %i bytes', (contentType, sizeBytes, expected) => {
    expect(codes(validateReceiptFile({ contentType, sizeBytes }))).toEqual(
      expected,
    );
  });

  it('detects supported types from their signatures', () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    expect(detectReceiptContentType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe(
      'application/pdf',
    );
    expect(detectReceiptContentType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(
      'image/jpeg',
    );
    expect(
      detectReceiptContentType(
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      ),
    ).toBe('image/png');
    expect(detectReceiptContentType(bytes(0x3c, 0x68, 0x74))).toBeUndefined();
    expect(detectReceiptContentType(bytes())).toBeUndefined();
  });

  it.each([
    ['receipt.pdf', 'receipt.pdf'],
    ['C:\\Users\\me\\scan 1.png', 'scan 1.png'],
    ['../../etc/passwd', 'passwd'],
    ['..hidden', 'hidden'],
    ['a<b>"c"|d?.pdf', 'abcd.pdf'],
    ['line\r\nbreak.pdf', 'linebreak.pdf'],
    ['', 'receipt'],
    ['   ', 'receipt'],
  ])('sanitizes %j to %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('limits file name length', () => {
    expect(sanitizeFileName(`${'a'.repeat(300)}.pdf`)).toHaveLength(120);
  });
});

describe('receipt verification', () => {
  const claim = draft();

  it('accepts a matching upload by the claim owner', () => {
    expect(
      verifyReceiptForAttachment(upload(), declared, claim, aisha),
    ).toEqual([]);
  });

  it('rejects uploads owned by someone else or attached elsewhere', () => {
    for (const [candidate, actor] of [
      [upload({ ownerId: 'u-ravi' }), aisha],
      [upload({ ownerId: 'u-ravi' }), ravi],
      [upload({ attachedClaimId: 'c-other' }), aisha],
    ] as const) {
      expect(
        codes(verifyReceiptForAttachment(candidate, declared, claim, actor)),
      ).toEqual(['RECEIPT_UNAVAILABLE']);
    }
  });

  it('reports each mismatched or malformed declaration field', () => {
    expect(
      verifyReceiptForAttachment(
        upload(),
        {
          contentType: 'image/png',
          sizeBytes: 2049,
          checksumSha256: 'b'.repeat(64),
        },
        claim,
        aisha,
      ).map((v) => [v.field, v.code]),
    ).toEqual([
      ['checksumSha256', 'RECEIPT_MISMATCH'],
      ['sizeBytes', 'RECEIPT_MISMATCH'],
      ['contentType', 'RECEIPT_MISMATCH'],
    ]);
    expect(
      codes(
        verifyReceiptForAttachment(
          upload(),
          { ...declared, checksumSha256: 'A'.repeat(64) },
          claim,
          aisha,
        ),
      ),
    ).toEqual(['INVALID_CHECKSUM']);
  });
});

describe('receipt commands', () => {
  it('attaches, replaces, and removes with history', () => {
    const attached = attachReceipt(draft(), upload(), declared, as(aisha));
    expect(attached.claim.receipt).toMatchObject({
      receiptId: 'r-1',
      checksumSha256: 'a'.repeat(64),
    });
    expect(attached.history.action).toBe('ATTACH_RECEIPT');

    const replacement = upload({
      receiptId: 'r-2',
      checksumSha256: 'c'.repeat(64),
    });
    const replaced = attachReceipt(
      attached.claim,
      replacement,
      { ...declared, checksumSha256: 'c'.repeat(64) },
      as(aisha),
    );
    expect(replaced.claim.receipt?.receiptId).toBe('r-2');
    expect(replaced.history).toMatchObject({
      action: 'REPLACE_RECEIPT',
      version: 3,
    });

    const removed = removeReceipt(replaced.claim, as(aisha));
    expect(removed.claim).not.toHaveProperty('receipt');
    expect(removed.history).toMatchObject({
      action: 'REMOVE_RECEIPT',
      version: 4,
    });
  });

  it('refuses receipt changes outside DRAFT or by non-owners', () => {
    expect(() =>
      attachReceipt(claimIn('SUBMITTED'), upload(), declared, as(aisha)),
    ).toThrow(expect.objectContaining({ code: 'CLAIM_NOT_EDITABLE' }));
    expect(() => removeReceipt(draft(), as(ravi))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('refuses to remove a missing receipt', () => {
    expect(() => removeReceipt(draft(), as(aisha))).toThrow(
      expect.objectContaining({
        violations: [expect.objectContaining({ code: 'NO_RECEIPT' })],
      }),
    );
  });

  it('refuses a mismatched upload', () => {
    expect(() =>
      attachReceipt(
        draft(),
        upload(),
        { ...declared, sizeBytes: 1 },
        as(aisha),
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
