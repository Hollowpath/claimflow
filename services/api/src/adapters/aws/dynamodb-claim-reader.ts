import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { idSchema } from '@claimflow/contracts';
import {
  claimStatuses,
  type Claim,
  type ClaimHistoryEntry,
  type ClaimStatus,
} from '@claimflow/domain';

import type {
  ClaimRepository,
  Page,
  PageRequest,
} from '../../application/ports.js';
import {
  encodeClaimCursor,
  encodeHistoryCursor,
  type CursorList,
} from './dynamodb-cursor.js';
import {
  categoryKey,
  claimKey,
  decodeCategoryItem,
  decodeClaimItem,
  decodeHistoryItem,
  ItemIntegrityError,
  type StoredClaim,
} from './dynamodb-items.js';
import {
  checkReaderOptions,
  queryPage,
  type DynamoDbReaderOptions,
  type ReadDocumentClient,
} from './dynamodb-read-support.js';

/**
 * The read side of the DynamoDB claim repository (docs/aws-architecture.md,
 * sections 6 and 13, access patterns A1 and A5 to A10). It sends only
 * `GetItem` and `Query`, never `Scan` or a write, with no filter expressions,
 * and decodes every item with the item codecs into domain values without
 * persistence metadata. Inputs are validated before any command, with fixed
 * messages that name no supplied value; SDK and codec errors propagate
 * unchanged.
 */

type ClaimReads = Pick<
  ClaimRepository,
  | 'get'
  | 'existsForCategory'
  | 'listByEmployee'
  | 'listOpenForManager'
  | 'listByStatus'
  | 'listHistory'
>;

export class DynamoDbClaimReader implements ClaimReads {
  private readonly client: ReadDocumentClient;
  private readonly tableName: string;

  public constructor(options: DynamoDbReaderOptions) {
    checkReaderOptions(options);
    this.client = options.client;
    this.tableName = options.tableName;
  }

  /** A1: strongly consistent `GetItem` for the requested claim only. */
  public async get(claimId: string): Promise<Claim | undefined> {
    return (await this.getStored(claimId))?.claim;
  }

  /**
   * A1 with the persistence metadata: the claim and its `lastEventVersion`
   * from the same strongly consistent `GetItem`, for write orchestration. The
   * stored value is returned as decoded; nothing is inferred when the
   * attribute is absent.
   */
  public async getStored(claimId: string): Promise<StoredClaim | undefined> {
    checkId(claimId, 'claim');
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: claimKey(claimId),
        ConsistentRead: true,
      }),
    );
    if (output.Item === undefined) {
      return undefined;
    }
    const stored = decodeClaimItem(output.Item);
    if (stored.claim.claimId !== claimId) {
      // The ID was validated, so the key names no unchecked value.
      const { PK, SK } = claimKey(claimId);
      throw new ItemIntegrityError(
        `${PK} / ${SK}`,
        'the item is not the requested claim',
      );
    }
    return stored;
  }

  /**
   * A5: the category's `claimCount`, read strongly consistently. A category
   * that does not exist is not used by any claim.
   */
  public async existsForCategory(categoryId: string): Promise<boolean> {
    checkId(categoryId, 'category');
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: categoryKey(categoryId),
        ConsistentRead: true,
      }),
    );
    return output.Item === undefined
      ? false
      : decodeCategoryItem(output.Item).metadata.claimCount > 0;
  }

  /** A6: GSI1, most recently updated first. */
  public listByEmployee(
    employeeId: string,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    checkId(employeeId, 'employee');
    return this.claimPage(
      { list: 'employee', employeeId },
      'GSI1',
      `EMPLOYEE#${employeeId}`,
      false,
      page,
    );
  }

  /** A7: GSI2, oldest submission first. */
  public listOpenForManager(
    managerId: string,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    checkId(managerId, 'manager');
    return this.claimPage(
      { list: 'queue', managerId },
      'GSI2',
      `MANAGER#${managerId}#OPEN`,
      true,
      page,
    );
  }

  /** A8 (GSI3) for one status, or A9 (GSI4) for all; newest first. */
  public listByStatus(
    status: ClaimStatus | undefined,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    if (status === undefined) {
      return this.claimPage({ list: 'all' }, 'GSI4', 'CLAIM', false, page);
    }
    if (!claimStatuses.includes(status)) {
      throw new TypeError('The claim status is not valid.');
    }
    return this.claimPage(
      { list: 'status', status },
      'GSI3',
      `STATUS#${status}`,
      false,
      page,
    );
  }

  /** A10: strongly consistent base-table query, oldest version first. */
  public listHistory(
    claimId: string,
    page: PageRequest,
  ): Promise<Page<ClaimHistoryEntry>> {
    checkId(claimId, 'claim');
    const list: CursorList = { list: 'history', claimId };
    return queryPage(
      this.client,
      {
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :history)',
        ExpressionAttributeValues: {
          ':pk': claimKey(claimId).PK,
          ':history': 'HISTORY#',
        },
        ScanIndexForward: true,
        ConsistentRead: true,
      },
      page,
      list,
      decodeHistoryItem,
      encodeHistoryCursor,
    );
  }

  private claimPage(
    list: Exclude<CursorList, { list: 'history' }>,
    index: 'GSI1' | 'GSI2' | 'GSI3' | 'GSI4',
    partition: string,
    ascending: boolean,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    return queryPage(
      this.client,
      {
        TableName: this.tableName,
        IndexName: index,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': `${index}PK` },
        ExpressionAttributeValues: { ':pk': partition },
        ScanIndexForward: ascending,
        // Global secondary indexes support only eventually consistent reads.
        ConsistentRead: false,
      },
      page,
      list,
      (item) => decodeClaimItem(item).claim,
      (claim) => encodeClaimCursor(list, claim),
    );
  }
}

function checkId(
  value: string,
  kind: 'claim' | 'category' | 'employee' | 'manager',
): void {
  if (!idSchema.safeParse(value).success) {
    throw new TypeError(`The ${kind} ID is not valid.`);
  }
}
