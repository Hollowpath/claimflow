import {
  claimStatuses,
  openReviewStatuses,
  sanitizeFileName,
  type Category,
  type Claim,
  type ClaimHistoryEntry,
  type ClaimStatus,
} from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  categoryKey,
  claimIndexAttributes,
  claimKey,
  decodeCategoryItem,
  decodeClaimItem,
  decodeHistoryItem,
  encodeCategoryItem,
  encodeClaimItem,
  encodeHistoryItem,
  historyKey,
  historySortKey,
  indexAttributes,
  ItemEncodingError,
  invalidKeyIdentifier,
  ItemIntegrityError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const checksum = '9f2c'.repeat(16);
const merchant = 'Regional Airline';
const businessPurpose = 'Client workshop';

/** The approved example claim (section 7), with a complete checksum. */
const submittedClaim: Claim = {
  claimId,
  employeeId: 'sub-aisha',
  assignedManagerId: 'sub-ben',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  expenseDate: '2026-10-08',
  merchant,
  businessPurpose,
  receipt: {
    receiptId: 'r-7731',
    fileName: 'flight.pdf',
    contentType: 'application/pdf',
    sizeBytes: 52_144,
    checksumSha256: checksum,
    attachedAt: '2026-10-14T10:40:00.000Z',
  },
  status: 'SUBMITTED',
  version: 4,
  createdAt: '2026-10-14T10:30:00.000Z',
  updatedAt: '2026-10-14T10:41:00.000Z',
  submittedAt: '2026-10-14T10:41:00.000Z',
};

const newDraft: Claim = {
  claimId: 'c-draft-1',
  employeeId: 'sub-ravi',
  status: 'DRAFT',
  version: 1,
  createdAt: '2026-10-14T09:00:00.000Z',
  updatedAt: '2026-10-14T09:00:00.000Z',
};

/** A claim in each status, with the fields that status implies. */
function claimIn(status: ClaimStatus): Claim {
  const decided = ['APPROVED', 'REJECTED', 'PAID'].includes(status);
  return {
    ...submittedClaim,
    status,
    version: 6,
    updatedAt: '2026-10-15T08:00:00.000Z',
    ...(decided ? { reviewedAt: '2026-10-15T08:00:00.000Z' } : {}),
  };
}

const travel: Category = {
  categoryId: 'travel',
  name: 'Travel',
  active: true,
  currency: 'MYR',
  maxAmountMinor: 200_000,
  receiptRequiredAboveMinor: 20_000,
  version: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-09-30T08:00:00.000Z',
  updatedBy: 'sub-dan',
};

const submission: ClaimHistoryEntry = {
  claimId,
  version: 4,
  action: 'SUBMIT',
  fromStatus: 'DRAFT',
  toStatus: 'SUBMITTED',
  actorId: 'sub-aisha',
  occurredAt: '2026-10-14T10:41:00.000Z',
};

const rejection: ClaimHistoryEntry = {
  claimId,
  version: 6,
  action: 'REJECT',
  fromStatus: 'UNDER_REVIEW',
  toStatus: 'REJECTED',
  actorId: 'sub-ben',
  occurredAt: '2026-10-15T08:00:00.000Z',
  comment: 'Please attach the boarding pass for the return flight.',
};

const indexValues = (item: DynamoItem) =>
  indexAttributes.filter((name) => name in item).map((name) => item[name]);

function expectIntegrityError(decode: () => unknown, problem?: string) {
  expect(decode).toThrow(ItemIntegrityError);
  if (problem !== undefined) {
    expect(decode).toThrow(problem);
  }
}

describe('claim items', () => {
  it('encode the approved example item exactly', () => {
    expect(encodeClaimItem(submittedClaim, { lastEventVersion: 4 })).toEqual({
      PK: `CLAIM#${claimId}`,
      SK: 'CLAIM',
      entityType: 'Claim',
      claimId,
      employeeId: 'sub-aisha',
      assignedManagerId: 'sub-ben',
      categoryId: 'travel',
      amount: { amountMinor: 45_000, currency: 'MYR' },
      expenseDate: '2026-10-08',
      merchant,
      businessPurpose,
      receipt: {
        receiptId: 'r-7731',
        fileName: 'flight.pdf',
        contentType: 'application/pdf',
        sizeBytes: 52_144,
        checksumSha256: checksum,
        attachedAt: '2026-10-14T10:40:00.000Z',
      },
      status: 'SUBMITTED',
      version: 4,
      lastEventVersion: 4,
      createdAt: '2026-10-14T10:30:00.000Z',
      updatedAt: '2026-10-14T10:41:00.000Z',
      submittedAt: '2026-10-14T10:41:00.000Z',
      GSI1PK: 'EMPLOYEE#sub-aisha',
      GSI1SK: `2026-10-14T10:41:00.000Z#${claimId}`,
      GSI2PK: 'MANAGER#sub-ben#OPEN',
      GSI2SK: `2026-10-14T10:41:00.000Z#${claimId}`,
      GSI3PK: 'STATUS#SUBMITTED',
      GSI3SK: `2026-10-14T10:41:00.000Z#${claimId}`,
      GSI4PK: 'CLAIM',
      GSI4SK: `2026-10-14T10:41:00.000Z#${claimId}`,
    });
  });

  it.each(claimStatuses)(
    'index a %s claim, with GSI2 only while open for review',
    (status) => {
      const claim = claimIn(status);
      const item = encodeClaimItem(claim);
      const activity = `2026-10-15T08:00:00.000Z#${claimId}`;

      expect(item).toMatchObject({
        GSI1PK: 'EMPLOYEE#sub-aisha',
        GSI1SK: activity,
        GSI3PK: `STATUS#${status}`,
        GSI3SK: activity,
        GSI4PK: 'CLAIM',
        GSI4SK: activity,
      });
      if (openReviewStatuses.includes(status)) {
        expect(item.GSI2PK).toBe('MANAGER#sub-ben#OPEN');
        expect(item.GSI2SK).toBe(`2026-10-14T10:41:00.000Z#${claimId}`);
      } else {
        expect(item).not.toHaveProperty('GSI2PK');
        expect(item).not.toHaveProperty('GSI2SK');
      }
      expect(decodeClaimItem(item)).toEqual({ claim, metadata: {} });
    },
  );

  it('round-trip a new draft without optional details, omitting absent attributes', () => {
    const item = encodeClaimItem(newDraft);

    expect(Object.keys(item).sort()).toEqual(
      [
        'PK',
        'SK',
        'entityType',
        'claimId',
        'employeeId',
        'status',
        'version',
        'createdAt',
        'updatedAt',
        'GSI1PK',
        'GSI1SK',
        'GSI3PK',
        'GSI3SK',
        'GSI4PK',
        'GSI4SK',
      ].sort(),
    );
    expect(Object.values(item)).not.toContain(undefined);
    expect(decodeClaimItem(item)).toEqual({ claim: newDraft, metadata: {} });
  });

  it('round-trip every detail, the receipt, and the event version', () => {
    const item = encodeClaimItem(submittedClaim, { lastEventVersion: 4 });

    expect(decodeClaimItem(item)).toEqual({
      claim: submittedClaim,
      metadata: { lastEventVersion: 4 },
    });
  });

  it('keep a reopened draft out of the review queue', () => {
    const reopened: Claim = { ...claimIn('DRAFT'), version: 7 };
    const item = encodeClaimItem(reopened, { lastEventVersion: 7 });

    expect(reopened.assignedManagerId).toBe('sub-ben');
    expect(item).not.toHaveProperty('GSI2PK');
    expect(decodeClaimItem(item).claim).toEqual(reopened);
  });

  it('never put free text into index keys', () => {
    const item = encodeClaimItem(submittedClaim);

    for (const value of indexValues(item)) {
      expect(value).not.toContain(merchant);
      expect(value).not.toContain(businessPurpose);
      expect(value).not.toContain('flight.pdf');
    }
  });

  it('derive the same index values the encoder writes', () => {
    const item = encodeClaimItem(submittedClaim);

    expect(claimIndexAttributes(submittedClaim)).toEqual(
      Object.fromEntries(indexAttributes.map((name) => [name, item[name]])),
    );
    expect(claimKey(claimId)).toEqual({ PK: `CLAIM#${claimId}`, SK: 'CLAIM' });
  });

  it.each<[string, Claim]>([
    [
      'an open claim without a manager',
      { ...submittedClaim, assignedManagerId: undefined } as unknown as Claim,
    ],
    [
      'an open claim without a submission time',
      {
        ...claimIn('UNDER_REVIEW'),
        submittedAt: undefined,
      } as unknown as Claim,
    ],
  ])('refuse to encode %s', (_name, claim) => {
    const encoded = JSON.parse(JSON.stringify(claim)) as Claim;

    expect(() => encodeClaimItem(encoded)).toThrow(ItemEncodingError);
    expect(() => encodeClaimItem(encoded)).toThrow(
      'an assigned manager and a submission time',
    );
  });

  it.each<[string, Claim, { lastEventVersion?: number }]>([
    [
      'a non-canonical timestamp',
      { ...newDraft, updatedAt: '2026-10-14T09:00:00Z' },
      {},
    ],
    ['an ID that cannot be a key', { ...newDraft, employeeId: 'a#b' }, {}],
    [
      'an event version above the claim version',
      newDraft,
      { lastEventVersion: 2 },
    ],
    ['a negative event version', newDraft, { lastEventVersion: -1 }],
    ['a zero version', { ...newDraft, version: 0 }, {}],
  ])('refuse to encode %s', (_name, claim, metadata) => {
    expect(() => encodeClaimItem(claim, metadata)).toThrow(ItemEncodingError);
  });

  const valid = () => encodeClaimItem(submittedClaim, { lastEventVersion: 4 });
  const changed = (changes: DynamoItem): DynamoItem => {
    const item = { ...valid(), ...changes };
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) {
        delete item[name];
      }
    }
    return item;
  };
  const withReceipt = (changes: DynamoItem) => ({
    receipt: { ...(valid().receipt as DynamoItem), ...changes },
  });

  it.each<[string, DynamoItem, string]>([
    ['a wrong partition key', { PK: 'CLAIM#other' }, 'key does not match'],
    ['a wrong sort key', { SK: 'HISTORY#0000000004' }, 'key does not match'],
    ['a wrong entity type', { entityType: 'Category' }, 'entityType'],
    ['a claim ID that does not match its key', { claimId: 'other' }, 'key'],
    ['a missing employee', { employeeId: undefined }, 'employeeId'],
    ['an ID with a key separator', { employeeId: 'sub#x' }, 'employeeId'],
    ['an unknown status', { status: 'ARCHIVED' }, 'status'],
    ['a zero version', { version: 0 }, 'version'],
    ['a fractional version', { version: 4.5 }, 'version'],
    ['a version stored as text', { version: '4' }, 'version'],
    ['a date-only timestamp', { createdAt: '2026-10-14' }, 'createdAt'],
    [
      'an impossible timestamp',
      { updatedAt: '2026-02-30T00:00:00.000Z' },
      'updatedAt',
    ],
    [
      'a non-UTC timestamp',
      { submittedAt: '2026-10-14T10:41:00.000+08:00' },
      'submittedAt',
    ],
    [
      'a zero amount',
      { amount: { amountMinor: 0, currency: 'MYR' } },
      'amount',
    ],
    [
      'a fractional amount',
      { amount: { amountMinor: 1.5, currency: 'MYR' } },
      'amount',
    ],
    [
      'a lower-case currency',
      { amount: { amountMinor: 100, currency: 'myr' } },
      'amount',
    ],
    [
      'an amount with extra fields',
      { amount: { amountMinor: 100, currency: 'MYR', note: 'x' } },
      'amount',
    ],
    ['an invalid expense date', { expenseDate: '2026-13-01' }, 'expenseDate'],
    ['an empty merchant', { merchant: '' }, 'merchant'],
    ['an untrimmed merchant', { merchant: ' Airline ' }, 'merchant'],
    [
      'an overlong business purpose',
      { businessPurpose: 'x'.repeat(501) },
      'businessPurpose',
    ],
    [
      'a receipt without its checksum',
      withReceipt({ checksumSha256: undefined }),
      'receipt',
    ],
    [
      'a receipt with a bad checksum',
      withReceipt({ checksumSha256: 'abc' }),
      'receipt',
    ],
    [
      'a receipt of an unsupported type',
      withReceipt({ contentType: 'image/gif' }),
      'receipt',
    ],
    ['an empty receipt', withReceipt({ sizeBytes: 0 }), 'receipt'],
    [
      'an oversized receipt',
      withReceipt({ sizeBytes: 10 * 1024 * 1024 + 1 }),
      'receipt',
    ],
    [
      'a receipt with a bad attachment time',
      withReceipt({ attachedAt: 'yesterday' }),
      'receipt',
    ],
    [
      'an event version above the claim version',
      { lastEventVersion: 5 },
      'lastEventVersion',
    ],
    ['a negative event version', { lastEventVersion: -1 }, 'lastEventVersion'],
    ['a wrong employee index', { GSI1PK: 'EMPLOYEE#sub-ravi' }, 'GSI1PK'],
    [
      'a wrong activity sort key',
      { GSI3SK: `2026-01-01T00:00:00.000Z#${claimId}` },
      'GSI3SK',
    ],
    ['a missing all-claims index', { GSI4PK: undefined }, 'GSI4PK'],
    [
      'a missing review-queue index on an open claim',
      { GSI2PK: undefined, GSI2SK: undefined },
      'GSI2PK',
    ],
    [
      'a review queue for another manager',
      { GSI2PK: 'MANAGER#sub-chloe#OPEN' },
      'GSI2PK',
    ],
    ['an unexpected attribute', { notes: 'x' }, 'unexpected attribute'],
    ['an unknown index attribute', { GSI5PK: 'x' }, 'unexpected attribute'],
  ])('reject an item with %s', (_name, changes, problem) => {
    expectIntegrityError(() => decodeClaimItem(changed(changes)), problem);
  });

  it('reject review-queue attributes on a decided claim', () => {
    const item = {
      ...encodeClaimItem(claimIn('APPROVED')),
      GSI2PK: 'MANAGER#sub-ben#OPEN',
      GSI2SK: `2026-10-14T10:41:00.000Z#${claimId}`,
    };

    expectIntegrityError(() => decodeClaimItem(item), 'GSI2PK must be absent');
  });

  it('reject an open claim without a manager, whatever its indexes', () => {
    const item = changed({ assignedManagerId: undefined });

    expectIntegrityError(
      () => decodeClaimItem(item),
      'an assigned manager and a submission time',
    );
  });

  it('identify the item without revealing stored values', () => {
    const secret = 'Confidential Supplier Sdn Bhd';
    const error = (() => {
      try {
        decodeClaimItem(changed({ merchant: `${secret} `, version: 'secret' }));
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ItemIntegrityError);
    expect(String(error)).toContain(`CLAIM#${claimId} / CLAIM`);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain('secret');
  });

  it('reject an item without a usable key', () => {
    expectIntegrityError(
      () => decodeClaimItem({ entityType: 'Claim' }),
      invalidKeyIdentifier,
    );
  });

  const unsafeFileNames: [string, string][] = [
    ['a path', 'scans/flight.pdf'],
    ['a Windows path', 'C:\\Users\\aisha\\flight.pdf'],
    ['a control character', 'flight\u0007.pdf'],
    ['an unsafe character', 'flight<1>.pdf'],
    ['a header-breaking character', 'flight;.pdf'],
    ['repeated spaces', 'flight  ticket.pdf'],
    ['surrounding whitespace', ' flight.pdf'],
    ['a leading dot', '.flight.pdf'],
    ['only dots', '...'],
    ['an empty name', ''],
    ['more than 120 characters', `${'a'.repeat(117)}.pdf`],
  ];

  it.each(unsafeFileNames)(
    'reject a stored receipt file name with %s',
    (_name, fileName) => {
      expectIntegrityError(
        () => decodeClaimItem(changed(withReceipt({ fileName }))),
        'receipt is not a valid receipt',
      );
    },
  );

  it.each(unsafeFileNames)(
    'refuse to encode a receipt file name with %s',
    (_name, fileName) => {
      const claim: Claim = {
        ...submittedClaim,
        receipt: { ...submittedClaim.receipt!, fileName },
      };

      expect(() => encodeClaimItem(claim)).toThrow(ItemEncodingError);
    },
  );

  it('accept a file name already in its sanitized form', () => {
    const fileName = `Client flight (return) ${'x'.repeat(93)}.pdf`;
    const claim: Claim = {
      ...submittedClaim,
      receipt: { ...submittedClaim.receipt!, fileName },
    };

    expect(fileName).toHaveLength(120);
    expect(
      decodeClaimItem(encodeClaimItem(claim)).claim.receipt?.fileName,
    ).toBe(fileName);
  });

  it('round-trip a long name the domain shortened at a space', () => {
    const fileName = sanitizeFileName(
      `${'a'.repeat(119)} ${'b'.repeat(20)}.pdf`,
    );
    const claim: Claim = {
      ...submittedClaim,
      receipt: { ...submittedClaim.receipt!, fileName },
    };

    expect(fileName).not.toMatch(/\s$/);
    expect(decodeClaimItem(encodeClaimItem(claim)).claim).toEqual(claim);
  });
});

describe('error identifiers', () => {
  const confidential = 'Salary review for Aisha Rahman';

  it.each<[string, DynamoItem]>([
    [
      'a partition key with free text',
      { PK: `CLAIM#${confidential}`, SK: 'CLAIM' },
    ],
    ['a sort key with free text', { PK: `CLAIM#${claimId}`, SK: confidential }],
    [
      'a history sort key with text after the version',
      { PK: `CLAIM#${claimId}`, SK: `HISTORY#0000000004 ${confidential}` },
    ],
    [
      'a category key with free text',
      { PK: 'CATEGORIES', SK: `CATEGORY#${confidential}` },
    ],
    [
      'an overlong ID-shaped key',
      { PK: `CLAIM#${'Confidential'.repeat(10)}`, SK: 'CLAIM' },
    ],
    ['an unknown partition', { PK: `USER#${confidential}`, SK: 'PROFILE' }],
  ])('use a generic identifier for %s', (_name, key) => {
    for (const decode of [
      decodeClaimItem,
      decodeHistoryItem,
      decodeCategoryItem,
    ]) {
      const error = (() => {
        try {
          decode({ ...key, entityType: 'Unknown' });
        } catch (e) {
          return e;
        }
      })();

      expect(error).toBeInstanceOf(ItemIntegrityError);
      expect(String(error)).toContain(invalidKeyIdentifier);
      expect(String(error)).not.toContain(confidential);
      expect(String(error)).not.toContain('Confidential');
    }
  });

  it('use a generic identifier when encoding with an unsafe ID', () => {
    const error = (() => {
      try {
        encodeClaimItem({ ...newDraft, claimId: confidential });
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ItemEncodingError);
    expect(String(error)).toContain(invalidKeyIdentifier);
    expect(String(error)).not.toContain(confidential);
  });

  it('name well-formed keys of every item type', () => {
    const cases: [() => unknown, string][] = [
      [
        () => decodeClaimItem({ PK: `CLAIM#${claimId}`, SK: 'CLAIM' }),
        `CLAIM#${claimId} / CLAIM`,
      ],
      [
        () =>
          decodeHistoryItem({
            PK: `CLAIM#${claimId}`,
            SK: 'HISTORY#0000000004',
          }),
        `CLAIM#${claimId} / HISTORY#0000000004`,
      ],
      [
        () => decodeCategoryItem({ PK: 'CATEGORIES', SK: 'CATEGORY#travel' }),
        'CATEGORIES / CATEGORY#travel',
      ],
    ];
    for (const [decode, key] of cases) {
      expectIntegrityError(decode, key);
    }
  });
});

describe('history items', () => {
  it('encode the approved example item exactly', () => {
    expect(encodeHistoryItem(submission)).toEqual({
      PK: `CLAIM#${claimId}`,
      SK: 'HISTORY#0000000004',
      entityType: 'ClaimHistory',
      claimId,
      version: 4,
      action: 'SUBMIT',
      fromStatus: 'DRAFT',
      toStatus: 'SUBMITTED',
      actorId: 'sub-aisha',
      occurredAt: '2026-10-14T10:41:00.000Z',
    });
  });

  it('pad versions to exactly 10 digits', () => {
    expect(historySortKey(1)).toBe('HISTORY#0000000001');
    expect(historySortKey(4)).toBe('HISTORY#0000000004');
    expect(historySortKey(1_234_567_890)).toBe('HISTORY#1234567890');
    expect(historySortKey(9_999_999_999)).toBe('HISTORY#9999999999');
    expect(historyKey(claimId, 12)).toEqual({
      PK: `CLAIM#${claimId}`,
      SK: 'HISTORY#0000000012',
    });
  });

  it('sort as text in version order across digit boundaries', () => {
    const versions = [100, 9, 10, 1, 99, 1_000_000_000, 11];
    const byText = versions.map(historySortKey).sort();

    expect(byText).toEqual(
      [...versions].sort((a, b) => a - b).map(historySortKey),
    );
  });

  it.each([0, -1, 1.5, Number.NaN, 10_000_000_000, Number.MAX_SAFE_INTEGER])(
    'reject version %s',
    (version) => {
      expect(() => historySortKey(version)).toThrow(RangeError);
      expect(() => encodeHistoryItem({ ...submission, version })).toThrow(
        ItemEncodingError,
      );
    },
  );

  it('round-trip entries with and without optional fields, keeping comments', () => {
    const creation: ClaimHistoryEntry = {
      claimId,
      version: 1,
      action: 'CREATE',
      toStatus: 'DRAFT',
      actorId: 'sub-aisha',
      occurredAt: '2026-10-14T10:30:00.000Z',
    };

    for (const entry of [creation, submission, rejection]) {
      const item = encodeHistoryItem(entry);
      expect(Object.values(item)).not.toContain(undefined);
      expect(decodeHistoryItem(item)).toEqual(entry);
    }
    expect(encodeHistoryItem(creation)).not.toHaveProperty('fromStatus');
    expect(encodeHistoryItem(creation)).not.toHaveProperty('comment');
    expect(decodeHistoryItem(encodeHistoryItem(rejection)).comment).toBe(
      rejection.comment,
    );
  });

  it('keep comments out of the key and have no index attributes', () => {
    const item = encodeHistoryItem(rejection);

    expect(item.SK).toBe('HISTORY#0000000006');
    expect(String(item.PK) + String(item.SK)).not.toContain('boarding');
    for (const name of indexAttributes) {
      expect(item).not.toHaveProperty(name);
    }
  });

  const valid = () => encodeHistoryItem(rejection);

  it.each<[string, DynamoItem, string]>([
    ['an unpadded sort key', { SK: 'HISTORY#6' }, 'key does not match'],
    ['a sort key for another version', { SK: 'HISTORY#0000000007' }, 'key'],
    ['another claim partition', { PK: 'CLAIM#other' }, 'key'],
    ['a wrong entity type', { entityType: 'Claim' }, 'entityType'],
    ['an unknown action', { action: 'ESCALATE' }, 'action'],
    ['an unknown target status', { toStatus: 'LOST' }, 'toStatus'],
    ['an unknown source status', { fromStatus: 'LOST' }, 'fromStatus'],
    ['an empty comment', { comment: '' }, 'comment'],
    ['an overlong comment', { comment: 'x'.repeat(1001) }, 'comment'],
    ['an invalid time', { occurredAt: '2026-10-15 08:00' }, 'occurredAt'],
    ['a missing actor', { actorId: 42 }, 'actorId'],
    [
      'a version beyond 10 digits',
      { version: 10_000_000_000, SK: 'HISTORY#10000000000' },
      'version',
    ],
    [
      'an index attribute',
      { GSI1PK: 'EMPLOYEE#sub-ben' },
      'must not have GSI1PK',
    ],
    ['an unexpected attribute', { merchant: 'x' }, 'unexpected attribute'],
  ])('reject an item with %s', (_name, changes, problem) => {
    expectIntegrityError(
      () => decodeHistoryItem({ ...valid(), ...changes }),
      problem,
    );
  });

  it('do not reveal comments in errors', () => {
    const error = (() => {
      try {
        decodeHistoryItem({ ...valid(), comment: ` ${rejection.comment!}` });
      } catch (e) {
        return e;
      }
    })();

    expect(String(error)).toContain('comment');
    expect(String(error)).not.toContain('boarding');
  });
});

describe('category items', () => {
  it('encode the approved example item exactly', () => {
    expect(
      encodeCategoryItem(travel, { claimCount: 17, lastEventVersion: 3 }),
    ).toEqual({
      PK: 'CATEGORIES',
      SK: 'CATEGORY#travel',
      entityType: 'Category',
      categoryId: 'travel',
      name: 'Travel',
      active: true,
      currency: 'MYR',
      maxAmountMinor: 200_000,
      receiptRequiredAboveMinor: 20_000,
      version: 3,
      lastEventVersion: 3,
      claimCount: 17,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-09-30T08:00:00.000Z',
      updatedBy: 'sub-dan',
    });
    expect(categoryKey('travel')).toEqual({
      PK: 'CATEGORIES',
      SK: 'CATEGORY#travel',
    });
  });

  it('round-trip the category and its persistence metadata', () => {
    const inactive: Category = { ...travel, active: false, version: 4 };

    expect(
      decodeCategoryItem(encodeCategoryItem(travel, { claimCount: 0 })),
    ).toEqual({ category: travel, metadata: { claimCount: 0 } });
    expect(
      decodeCategoryItem(
        encodeCategoryItem(inactive, { claimCount: 5, lastEventVersion: 4 }),
      ),
    ).toEqual({
      category: inactive,
      metadata: { claimCount: 5, lastEventVersion: 4 },
    });
  });

  it('have no index attributes and omit an absent event version', () => {
    const item = encodeCategoryItem(travel, { claimCount: 2 });

    for (const name of indexAttributes) {
      expect(item).not.toHaveProperty(name);
    }
    expect(item).not.toHaveProperty('lastEventVersion');
    expect(Object.values(item)).not.toContain(undefined);
  });

  it.each([-1, 1.5, Number.NaN])(
    'refuse to encode a claim count of %s',
    (claimCount) => {
      expect(() => encodeCategoryItem(travel, { claimCount })).toThrow(
        ItemEncodingError,
      );
    },
  );

  it('refuse to encode an event version above the category version', () => {
    expect(() =>
      encodeCategoryItem(travel, { claimCount: 0, lastEventVersion: 4 }),
    ).toThrow(ItemEncodingError);
  });

  const valid = () =>
    encodeCategoryItem(travel, { claimCount: 17, lastEventVersion: 3 });

  it.each<[string, DynamoItem, string]>([
    ['a wrong partition', { PK: 'CATEGORY' }, 'key does not match'],
    ['a sort key for another category', { SK: 'CATEGORY#meals' }, 'key'],
    ['a wrong entity type', { entityType: 'Claim' }, 'entityType'],
    ['a missing claim count', { claimCount: undefined }, 'claimCount'],
    ['a negative claim count', { claimCount: -1 }, 'claimCount'],
    ['a fractional claim count', { claimCount: 0.5 }, 'claimCount'],
    [
      'an event version above the version',
      { lastEventVersion: 4 },
      'lastEventVersion',
    ],
    ['an empty name', { name: '' }, 'settings'],
    ['a name with a leading space', { name: ' Travel' }, 'name'],
    ['a name with a trailing space', { name: 'Travel ' }, 'name'],
    ['a name with surrounding newlines', { name: '\nTravel\n' }, 'name'],
    ['an invalid currency', { currency: 'RM' }, 'settings'],
    ['a zero maximum', { maxAmountMinor: 0 }, 'settings'],
    [
      'a negative receipt threshold',
      { receiptRequiredAboveMinor: -1 },
      'settings',
    ],
    ['a non-boolean active flag', { active: 'yes' }, 'active'],
    ['an invalid update time', { updatedAt: '30/09/2026' }, 'updatedAt'],
    ['an index attribute', { GSI4PK: 'CLAIM' }, 'must not have GSI4PK'],
    ['an unexpected attribute', { description: 'x' }, 'unexpected attribute'],
  ])('reject an item with %s', (_name, changes, problem) => {
    const item: DynamoItem = { ...valid(), ...changes };
    if (changes.claimCount === undefined && 'claimCount' in changes) {
      delete item.claimCount;
    }
    expectIntegrityError(() => decodeCategoryItem(item), problem);
  });

  it.each([' Travel', 'Travel ', '\tTravel', ' Travel\n'])(
    'refuse to encode an untrimmed name %j',
    (name) => {
      expect(() =>
        encodeCategoryItem({ ...travel, name }, { claimCount: 0 }),
      ).toThrow(ItemEncodingError);
    },
  );

  it('keep inner spaces in a trimmed name', () => {
    const category: Category = { ...travel, name: 'Meals and entertainment' };

    expect(
      decodeCategoryItem(encodeCategoryItem(category, { claimCount: 0 }))
        .category.name,
    ).toBe('Meals and entertainment');
  });
});
