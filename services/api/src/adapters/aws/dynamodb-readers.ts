/**
 * Read-only DynamoDB adapters for claims, history, and categories
 * (docs/aws-architecture.md, sections 6 and 13). The readers live in
 * `dynamodb-claim-reader.ts` and `dynamodb-category-reader.ts`, and what they
 * share in `dynamodb-read-support.ts`; this module re-exports them so existing
 * imports keep working. Write methods are separate adapters.
 */

export { DynamoDbCategoryReader } from './dynamodb-category-reader.js';
export { DynamoDbClaimReader } from './dynamodb-claim-reader.js';
export type {
  DynamoDbReaderOptions,
  ReadDocumentClient,
} from './dynamodb-read-support.js';
