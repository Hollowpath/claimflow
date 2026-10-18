import { idempotencyKeySchema, idSchema } from '@claimflow/contracts';
import {
  businessPurposeMaxLength,
  claimHistoryActions,
  claimStatuses,
  decisionCommentMaxLength,
  isCalendarDate,
  isChecksumSha256,
  isCurrencyCode,
  isPositiveMinorAmount,
  isReceiptContentType,
  maxReceiptSizeBytes,
  merchantMaxLength,
  openReviewStatuses,
  sanitizeFileName,
  validateCategorySettings,
  type Category,
  type Claim,
  type ClaimHistoryAction,
  type ClaimHistoryEntry,
  type ClaimStatus,
  type Money,
  type Receipt,
} from '@claimflow/domain';

import { canonicalJson } from './transaction-token.js';

/**
 * Pure codecs between domain values and ClaimFlow table items
 * (docs/aws-architecture.md, sections 5 and 7). They send no commands.
 * Decoding validates every attribute strictly; encoding builds the item and
 * validates it the same way, so it never writes an item it could not read.
 */

/** A table item as the DynamoDB document client reads and writes it. */
export type DynamoItem = Record<string, unknown>;

/** A stored item does not match the approved item shape. */
export class ItemIntegrityError extends Error {
  public constructor(key: string, problem: string) {
    super(`The stored item ${key} is invalid: ${problem}.`);
    this.name = 'ItemIntegrityError';
  }
}

/** A domain value cannot be stored in the approved item shape. */
export class ItemEncodingError extends Error {
  public constructor(key: string, problem: string) {
    super(`Cannot encode the item ${key}: ${problem}.`);
    this.name = 'ItemEncodingError';
  }
}

export interface ClaimItemMetadata {
  /** The claim version of the latest publishable event, if any. */
  readonly lastEventVersion?: number;
}

export interface StoredClaim {
  readonly claim: Claim;
  readonly metadata: ClaimItemMetadata;
}

export interface CategoryItemMetadata {
  /** How many claims use the category; never negative. */
  readonly claimCount: number;
  /** The category version of the latest publishable event, if any. */
  readonly lastEventVersion?: number;
}

export interface StoredCategory {
  readonly category: Category;
  readonly metadata: CategoryItemMetadata;
}

export const claimEntityType = 'Claim';
export const historyEntityType = 'ClaimHistory';
export const categoryEntityType = 'Category';
export const categoriesPartitionKey = 'CATEGORIES';

/** History versions are zero-padded to this many digits in sort keys. */
export const historyVersionDigits = 10;
const maxHistoryVersion = 10 ** historyVersionDigits - 1;

export const indexAttributes = [
  'GSI1PK',
  'GSI1SK',
  'GSI2PK',
  'GSI2SK',
  'GSI3PK',
  'GSI3SK',
  'GSI4PK',
  'GSI4SK',
] as const;

export function claimKey(claimId: string) {
  return { PK: `CLAIM#${claimId}`, SK: 'CLAIM' } as const;
}

/** `HISTORY#` and the version zero-padded to 10 digits. */
export function historySortKey(version: number): string {
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > maxHistoryVersion
  ) {
    throw new RangeError(
      `History versions must be whole numbers from 1 to ${maxHistoryVersion}.`,
    );
  }
  return `HISTORY#${String(version).padStart(historyVersionDigits, '0')}`;
}

export function historyKey(claimId: string, version: number) {
  return { PK: `CLAIM#${claimId}`, SK: historySortKey(version) } as const;
}

export function categoryKey(categoryId: string) {
  return { PK: categoriesPartitionKey, SK: `CATEGORY#${categoryId}` } as const;
}

/**
 * The index attributes of a claim. GSI2 is present only while the claim is
 * open for review; an open claim must have a manager and a submission time.
 */
export function claimIndexAttributes(claim: Claim): Record<string, string> {
  const activity = `${claim.updatedAt}#${claim.claimId}`;
  const attributes: Record<string, string> = {
    GSI1PK: `EMPLOYEE#${claim.employeeId}`,
    GSI1SK: activity,
    GSI3PK: `STATUS#${claim.status}`,
    GSI3SK: activity,
    GSI4PK: 'CLAIM',
    GSI4SK: activity,
  };
  if (openReviewStatuses.includes(claim.status)) {
    if (
      claim.assignedManagerId === undefined ||
      claim.submittedAt === undefined
    ) {
      throw new RangeError(
        'An open claim needs an assigned manager and a submission time',
      );
    }
    attributes.GSI2PK = `MANAGER#${claim.assignedManagerId}#OPEN`;
    attributes.GSI2SK = `${claim.submittedAt}#${claim.claimId}`;
  }
  return attributes;
}

// Claims

const claimAttributes = new Set([
  'PK',
  'SK',
  'entityType',
  'claimId',
  'employeeId',
  'assignedManagerId',
  'categoryId',
  'amount',
  'expenseDate',
  'merchant',
  'businessPurpose',
  'receipt',
  'status',
  'version',
  'lastEventVersion',
  'createdAt',
  'updatedAt',
  'submittedAt',
  'reviewedAt',
  ...indexAttributes,
]);

export function encodeClaimItem(
  claim: Claim,
  metadata: ClaimItemMetadata = {},
): DynamoItem {
  const key = claimKey(claim.claimId);
  const encodingFailure = failWith(ItemEncodingError, key);
  let indexes: Record<string, string>;
  try {
    indexes = claimIndexAttributes(claim);
  } catch (error) {
    return encodingFailure(
      error instanceof RangeError ? error.message : 'invalid index values',
    );
  }
  const item = definedOnly({
    ...key,
    entityType: claimEntityType,
    claimId: claim.claimId,
    employeeId: claim.employeeId,
    assignedManagerId: claim.assignedManagerId,
    categoryId: claim.categoryId,
    amount:
      claim.amount === undefined
        ? undefined
        : {
            amountMinor: claim.amount.amountMinor,
            currency: claim.amount.currency,
          },
    expenseDate: claim.expenseDate,
    merchant: claim.merchant,
    businessPurpose: claim.businessPurpose,
    receipt: claim.receipt === undefined ? undefined : { ...claim.receipt },
    status: claim.status,
    version: claim.version,
    lastEventVersion: metadata.lastEventVersion,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    submittedAt: claim.submittedAt,
    reviewedAt: claim.reviewedAt,
    ...indexes,
  });
  readClaim(item, encodingFailure);
  return item;
}

export function decodeClaimItem(item: DynamoItem): StoredClaim {
  return readClaim(item, failWith(ItemIntegrityError, item));
}

function readClaim(item: DynamoItem, fail: Fail): StoredClaim {
  const read = new AttributeReader(item, fail);
  read.allowOnly(claimAttributes);
  read.entityType(claimEntityType);
  const claimId = read.id('claimId');
  read.keys(claimKey(claimId));

  const status = read.oneOf('status', claimStatuses);
  const version = read.positiveInteger('version');
  const claim: Claim = definedOnly({
    claimId,
    employeeId: read.id('employeeId'),
    assignedManagerId: read.optional('assignedManagerId', () =>
      read.id('assignedManagerId'),
    ),
    categoryId: read.optional('categoryId', () => read.id('categoryId')),
    amount: read.optional('amount', () => read.money('amount')),
    expenseDate: read.optional('expenseDate', () =>
      read.check('expenseDate', isCalendarDate),
    ),
    merchant: read.optional('merchant', () =>
      read.text('merchant', merchantMaxLength),
    ),
    businessPurpose: read.optional('businessPurpose', () =>
      read.text('businessPurpose', businessPurposeMaxLength),
    ),
    receipt: read.optional('receipt', () => read.receipt('receipt')),
    status,
    version,
    createdAt: read.timestamp('createdAt'),
    updatedAt: read.timestamp('updatedAt'),
    submittedAt: read.optional('submittedAt', () =>
      read.timestamp('submittedAt'),
    ),
    reviewedAt: read.optional('reviewedAt', () => read.timestamp('reviewedAt')),
  });
  const lastEventVersion = read.optional('lastEventVersion', () =>
    read.eventVersion('lastEventVersion', version),
  );

  let expected: Record<string, string>;
  try {
    expected = claimIndexAttributes(claim);
  } catch {
    return fail(
      'an open claim needs an assigned manager and a submission time',
    );
  }
  read.indexes(expected);

  return {
    claim,
    metadata: lastEventVersion === undefined ? {} : { lastEventVersion },
  };
}

// Claim history

const historyAttributes = new Set([
  'PK',
  'SK',
  'entityType',
  'claimId',
  'version',
  'action',
  'fromStatus',
  'toStatus',
  'actorId',
  'occurredAt',
  'comment',
]);

export function encodeHistoryItem(entry: ClaimHistoryEntry): DynamoItem {
  const partition = claimKey(entry.claimId).PK;
  let sortKey: string;
  try {
    sortKey = historySortKey(entry.version);
  } catch {
    return failWith(ItemEncodingError, { PK: partition, SK: 'HISTORY#?' })(
      'the history version cannot be represented in 10 digits',
    );
  }
  const item = definedOnly({
    PK: partition,
    SK: sortKey,
    entityType: historyEntityType,
    claimId: entry.claimId,
    version: entry.version,
    action: entry.action,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    actorId: entry.actorId,
    occurredAt: entry.occurredAt,
    comment: entry.comment,
  });
  readHistory(item, failWith(ItemEncodingError, item));
  return item;
}

export function decodeHistoryItem(item: DynamoItem): ClaimHistoryEntry {
  return readHistory(item, failWith(ItemIntegrityError, item));
}

function readHistory(item: DynamoItem, fail: Fail): ClaimHistoryEntry {
  const read = new AttributeReader(item, fail);
  read.noIndexes();
  read.allowOnly(historyAttributes);
  read.entityType(historyEntityType);
  const claimId = read.id('claimId');
  const version = read.positiveInteger('version');
  if (version > maxHistoryVersion) {
    fail('version does not fit in 10 digits');
  }
  read.keys(historyKey(claimId, version));

  return definedOnly({
    claimId,
    version,
    action: read.oneOf<ClaimHistoryAction>('action', claimHistoryActions),
    fromStatus: read.optional('fromStatus', () =>
      read.oneOf<ClaimStatus>('fromStatus', claimStatuses),
    ),
    toStatus: read.oneOf<ClaimStatus>('toStatus', claimStatuses),
    actorId: read.id('actorId'),
    occurredAt: read.timestamp('occurredAt'),
    comment: read.optional('comment', () =>
      read.text('comment', decisionCommentMaxLength),
    ),
  });
}

// Categories

const categoryAttributes = new Set([
  'PK',
  'SK',
  'entityType',
  'categoryId',
  'name',
  'active',
  'currency',
  'maxAmountMinor',
  'receiptRequiredAboveMinor',
  'version',
  'lastEventVersion',
  'claimCount',
  'createdAt',
  'updatedAt',
  'updatedBy',
]);

export function encodeCategoryItem(
  category: Category,
  metadata: CategoryItemMetadata,
): DynamoItem {
  const item = definedOnly({
    ...categoryKey(category.categoryId),
    entityType: categoryEntityType,
    categoryId: category.categoryId,
    name: category.name,
    active: category.active,
    currency: category.currency,
    maxAmountMinor: category.maxAmountMinor,
    receiptRequiredAboveMinor: category.receiptRequiredAboveMinor,
    version: category.version,
    lastEventVersion: metadata.lastEventVersion,
    claimCount: metadata.claimCount,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
    updatedBy: category.updatedBy,
  });
  readCategory(item, failWith(ItemEncodingError, item));
  return item;
}

export function decodeCategoryItem(item: DynamoItem): StoredCategory {
  return readCategory(item, failWith(ItemIntegrityError, item));
}

function readCategory(item: DynamoItem, fail: Fail): StoredCategory {
  const read = new AttributeReader(item, fail);
  read.noIndexes();
  read.allowOnly(categoryAttributes);
  read.entityType(categoryEntityType);
  const categoryId = read.id('categoryId');
  read.keys(categoryKey(categoryId));

  const version = read.positiveInteger('version');
  const category: Category = {
    categoryId,
    name: read.check('name', (value) => value === value.trim()),
    active: read.boolean('active'),
    currency: read.string('currency'),
    maxAmountMinor: read.number('maxAmountMinor'),
    receiptRequiredAboveMinor: read.number('receiptRequiredAboveMinor'),
    version,
    createdAt: read.timestamp('createdAt'),
    updatedAt: read.timestamp('updatedAt'),
    updatedBy: read.id('updatedBy'),
  };
  if (validateCategorySettings(category).length > 0) {
    fail('the category settings are invalid');
  }
  const claimCount = read.nonNegativeInteger('claimCount');
  const lastEventVersion = read.optional('lastEventVersion', () =>
    read.eventVersion('lastEventVersion', version),
  );
  return {
    category,
    metadata:
      lastEventVersion === undefined
        ? { claimCount }
        : { claimCount, lastEventVersion },
  };
}

// Validation

export type Fail = (problem: string) => never;

/** Canonical `Date.toISOString` timestamps, which sort as text by time. */
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoTimestamp(value: string): boolean {
  if (!isoTimestampPattern.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

/** The identifier used in errors for an item whose key is not well formed. */
export const invalidKeyIdentifier = '(with an invalid key)';

const isKeyId = (value: string) => idSchema.safeParse(value).success;

/** `CLAIM#<id>`, `CATEGORIES`, or `IDEMPOTENCY#<actorId>#<key>`. */
function isSafePartitionKey(value: string): boolean {
  if (value.startsWith('IDEMPOTENCY#')) {
    const [actorId = '', key = '', ...rest] = value
      .slice('IDEMPOTENCY#'.length)
      .split('#');
    return (
      rest.length === 0 &&
      isKeyId(actorId) &&
      idempotencyKeySchema.safeParse(key).success
    );
  }
  return (
    value === categoriesPartitionKey ||
    (value.startsWith('CLAIM#') && isKeyId(value.slice('CLAIM#'.length)))
  );
}

/**
 * `CLAIM`, `HISTORY#` and 10 digits, `CATEGORY#<id>`, `IDEMPOTENCY`, or
 * `OUTBOX#<timestamp>#<id>`.
 */
function isSafeSortKey(value: string): boolean {
  if (value.startsWith('OUTBOX#')) {
    const [occurredAt = '', eventId = '', ...rest] = value
      .slice('OUTBOX#'.length)
      .split('#');
    return rest.length === 0 && isIsoTimestamp(occurredAt) && isKeyId(eventId);
  }
  return (
    value === 'CLAIM' ||
    value === 'IDEMPOTENCY' ||
    /^HISTORY#\d{10}$/.test(value) ||
    (value.startsWith('CATEGORY#') && isKeyId(value.slice('CATEGORY#'.length)))
  );
}

/**
 * Names the item in errors by its key, but only when both key parts have a
 * known ClaimFlow shape; otherwise the stored key could itself be arbitrary
 * text, so a generic identifier is used instead.
 */
export function failWith(
  ErrorType: typeof ItemIntegrityError | typeof ItemEncodingError,
  item: DynamoItem,
): Fail {
  const { PK, SK } = item;
  const key =
    typeof PK === 'string' &&
    typeof SK === 'string' &&
    isSafePartitionKey(PK) &&
    isSafeSortKey(SK)
      ? `${PK} / ${SK}`
      : invalidKeyIdentifier;
  return (problem) => {
    throw new ErrorType(key, problem);
  };
}

/**
 * Reads typed attributes, failing with the attribute name and the kind of
 * problem only; stored values never appear in messages.
 */
export class AttributeReader {
  /** `field` names a nested map, such as `payload`, in messages. */
  public constructor(
    private readonly item: DynamoItem,
    private readonly fail: Fail,
    private readonly field?: string,
  ) {}

  /** A reader for the map in attribute `name`, which must be a plain map. */
  public map(name: string): AttributeReader {
    const value = this.item[name];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return this.fail(`${this.label(name)} must be a map`);
    }
    return new AttributeReader(
      value as DynamoItem,
      this.fail,
      this.label(name),
    );
  }

  public allowOnly(allowed: ReadonlySet<string>): void {
    for (const name of Object.keys(this.item)) {
      if (!allowed.has(name)) {
        this.fail(
          this.field === undefined
            ? 'it has an unexpected attribute'
            : `${this.field} has an unexpected field`,
        );
      }
    }
  }

  /** Whether attribute `name` is present with a value. */
  public has(name: string): boolean {
    return this.item[name] !== undefined;
  }

  private label(name: string): string {
    return this.field === undefined ? name : `${this.field}.${name}`;
  }

  public noIndexes(): void {
    for (const name of indexAttributes) {
      if (name in this.item) {
        this.fail(`this item type must not have ${this.label(name)}`);
      }
    }
  }

  public indexes(expected: Readonly<Record<string, string>>): void {
    for (const name of indexAttributes) {
      const value = this.item[name];
      const wanted = expected[name];
      if (wanted === undefined) {
        if (name in this.item) {
          this.fail(`${this.label(name)} must be absent`);
        }
      } else if (value === undefined) {
        this.fail(`${this.label(name)} is missing`);
      } else if (value !== wanted) {
        this.fail(`${this.label(name)} does not match the item`);
      }
    }
  }

  public entityType(expected: string): void {
    if (this.item.entityType !== expected) {
      this.fail(`entityType is not ${expected}`);
    }
  }

  public keys(expected: { readonly PK: string; readonly SK: string }): void {
    if (this.item.PK !== expected.PK || this.item.SK !== expected.SK) {
      this.fail('its key does not match its attributes');
    }
  }

  public optional<T>(name: string, read: () => T): T | undefined {
    return this.item[name] === undefined ? undefined : read();
  }

  public string(name: string): string {
    const value = this.item[name];
    return typeof value === 'string'
      ? value
      : this.fail(`${this.label(name)} must be a string`);
  }

  public check(name: string, valid: (value: string) => boolean): string {
    const value = this.string(name);
    return valid(value) ? value : this.fail(`${this.label(name)} is not valid`);
  }

  public id(name: string): string {
    return this.check(name, (value) => idSchema.safeParse(value).success);
  }

  public timestamp(name: string): string {
    return this.check(name, isIsoTimestamp);
  }

  /** Trimmed, non-empty text of at most `maxLength` characters. */
  public text(name: string, maxLength: number): string {
    return this.check(
      name,
      (value) =>
        value.length > 0 && value.length <= maxLength && value.trim() === value,
    );
  }

  public oneOf<T extends string>(name: string, values: readonly T[]): T {
    const value = this.string(name);
    return (values as readonly string[]).includes(value)
      ? (value as T)
      : this.fail(`${this.label(name)} is not an allowed value`);
  }

  public boolean(name: string): boolean {
    const value = this.item[name];
    return typeof value === 'boolean'
      ? value
      : this.fail(`${this.label(name)} must be a boolean`);
  }

  public number(name: string): number {
    const value = this.item[name];
    return typeof value === 'number'
      ? value
      : this.fail(`${this.label(name)} must be a number`);
  }

  public nonNegativeInteger(name: string): number {
    const value = this.number(name);
    return Number.isSafeInteger(value) && value >= 0
      ? value
      : this.fail(`${this.label(name)} must be a non-negative whole number`);
  }

  public positiveInteger(name: string): number {
    const value = this.number(name);
    return Number.isSafeInteger(value) && value >= 1
      ? value
      : this.fail(`${this.label(name)} must be a positive whole number`);
  }

  /** A non-negative event version no newer than the aggregate's version. */
  public eventVersion(name: string, aggregateVersion: number): number {
    const value = this.nonNegativeInteger(name);
    return value <= aggregateVersion
      ? value
      : this.fail(`${this.label(name)} is newer than the aggregate version`);
  }

  /**
   * A JSON value (no `undefined`, sets, binary, or non-finite numbers) that
   * nests at most `maxDepth` levels and serializes to at most `maxBytes` UTF-8
   * bytes, so it can be stored as a DynamoDB map. The shape is checked first,
   * with bounded work, so no stored value can exhaust the stack or memory.
   */
  public json(name: string, maxDepth: number, maxBytes: number): unknown {
    const value = this.item[name];
    // Every map, list, and scalar adds at least one byte to the JSON text.
    const shape = checkShape(value, maxDepth, maxBytes);
    if (shape !== undefined) {
      return this.fail(`${this.label(name)} is ${shape}`);
    }
    let text: string;
    try {
      text = canonicalJson(value);
    } catch {
      return this.fail(`${this.label(name)} is not a JSON value`);
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return this.fail(`${this.label(name)} is too large`);
    }
    return value;
  }

  public money(name: string): Money {
    const value = this.item[name];
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !hasExactly(value, ['amountMinor', 'currency'])
    ) {
      return this.fail(
        `${this.label(name)} must have only amountMinor and currency`,
      );
    }
    const { amountMinor, currency } = value as Record<string, unknown>;
    if (
      typeof amountMinor !== 'number' ||
      !isPositiveMinorAmount(amountMinor) ||
      typeof currency !== 'string' ||
      !isCurrencyCode(currency)
    ) {
      return this.fail(`${this.label(name)} is not a valid amount`);
    }
    return { amountMinor, currency };
  }

  public receipt(name: string): Receipt {
    const value = this.item[name];
    const fields = [
      'receiptId',
      'fileName',
      'contentType',
      'sizeBytes',
      'checksumSha256',
      'attachedAt',
    ] as const;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !hasExactly(value, fields)
    ) {
      return this.fail(
        `${this.label(name)} must have exactly the receipt fields`,
      );
    }
    const r = value as Record<string, unknown>;
    const valid =
      typeof r.receiptId === 'string' &&
      idSchema.safeParse(r.receiptId).success &&
      typeof r.fileName === 'string' &&
      r.fileName === sanitizeFileName(r.fileName) &&
      typeof r.contentType === 'string' &&
      isReceiptContentType(r.contentType) &&
      typeof r.sizeBytes === 'number' &&
      Number.isSafeInteger(r.sizeBytes) &&
      r.sizeBytes >= 1 &&
      r.sizeBytes <= maxReceiptSizeBytes &&
      typeof r.checksumSha256 === 'string' &&
      isChecksumSha256(r.checksumSha256) &&
      typeof r.attachedAt === 'string' &&
      isIsoTimestamp(r.attachedAt);
    if (!valid) {
      return this.fail(`${this.label(name)} is not a valid receipt`);
    }
    return {
      receiptId: r.receiptId,
      fileName: r.fileName,
      contentType: r.contentType,
      sizeBytes: r.sizeBytes,
      checksumSha256: r.checksumSha256,
      attachedAt: r.attachedAt,
    } as Receipt;
  }
}

function hasExactly(value: object, names: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === names.length && names.every((name) => keys.includes(name))
  );
}

/** `T` with properties that may be `undefined` made optional instead. */
type DefinedOnly<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

/** A copy without `undefined` properties, which must never be written. */
function definedOnly<T extends Record<string, unknown>>(
  value: T,
): DefinedOnly<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, inner]) => inner !== undefined),
  ) as DefinedOnly<T>;
}

/**
 * Walks `value` iteratively and stops as soon as it finds more than
 * `maxDepth` levels of maps and lists, or more than `maxNodes` values in all.
 * A cycle counts as too deep. Scalars are level 0.
 */
function checkShape(
  value: unknown,
  maxDepth: number,
  maxNodes: number,
): 'nested too deeply' | 'too large' | undefined {
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 0 },
  ];
  let seen = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    seen += 1;
    if (typeof next.value !== 'object' || next.value === null) {
      continue;
    }
    const level = next.depth + 1;
    if (level > maxDepth) {
      return 'nested too deeply';
    }
    const children: readonly unknown[] = Array.isArray(next.value)
      ? next.value
      : Object.values(next.value);
    if (seen + pending.length + children.length > maxNodes) {
      return 'too large';
    }
    for (const child of children) {
      pending.push({ value: child, depth: level });
    }
  }
  return undefined;
}
