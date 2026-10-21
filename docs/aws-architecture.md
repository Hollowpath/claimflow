# AWS architecture

This is the current-state reference for ClaimFlow's AWS deployment: how it is built, the guarantees it relies on, what was verified on the deployed environment, and what is deliberately deferred. Resource-level settings (function sizes, IAM statements, mappings, outputs, publishing steps) are in [the infrastructure README](../infrastructure/README.md); the HTTP contract is in [the API guide](api.md); tests and the dated manual verification are in [the testing guide](testing.md); the evidence behind public claims is in [the readiness record](engineering-readiness.md); and business rules are in [the domain model](domain-model.md).

ClaimFlow is a public-source portfolio project that holds only fabricated data. The stack is deployed manually in **`ap-southeast-1`** (Singapore) and is never deployed automatically, including from CI. The local runtime remains the default for development and is the only runnable one without AWS.

## Contents

1. [Principles](#1-principles)
2. [Local and AWS runtimes](#2-local-and-aws-runtimes)
3. [Domain model summary](#3-domain-model-summary)
4. [Architecture overview](#4-architecture-overview)
5. [DynamoDB table, keys, and indexes](#5-dynamodb-table-keys-and-indexes)
6. [Access patterns](#6-access-patterns)
7. [Items and codecs](#7-items-and-codecs)
8. [Transactional write model](#8-transactional-write-model)
9. [Conditional writes and category guards](#9-conditional-writes-and-category-guards)
10. [Idempotency](#10-idempotency)
11. [Receipt lifecycle](#11-receipt-lifecycle)
12. [Draft deletion and history cleanup](#12-draft-deletion-and-history-cleanup)
13. [Pagination and cursor validation](#13-pagination-and-cursor-validation)
14. [TTL policies](#14-ttl-policies)
15. [Outbox events, publication, and recovery](#15-outbox-events-publication-and-recovery)
16. [Event delivery guarantees and consumer behavior](#16-event-delivery-guarantees-and-consumer-behavior)
17. [Identity and authorization](#17-identity-and-authorization)
18. [Ports and adapters](#18-ports-and-adapters)
19. [Security boundaries](#19-security-boundaries)
20. [Consistency summary](#20-consistency-summary)
21. [Cost considerations](#21-cost-considerations)
22. [Operations](#22-operations)
23. [Testing and verification](#23-testing-and-verification)
24. [Deferred options](#24-deferred-options)
25. [Decisions](#25-decisions)

## 1. Principles

- **Adapters, not rewrites.** The domain rules and application services are shared; AWS support is added through new adapters and services, and the local runtime is unchanged.
- **One atomic commit per mutation.** Every accepted change, its audit history, its outbox events, and its idempotency result commit together or not at all.
- **The server decides.** Identity, roles, ownership, manager assignment, and status are always loaded on the server. Request bodies never carry identity.
- **Serverless only.** API Gateway, Lambda, DynamoDB, S3, CloudFront, Cognito, EventBridge, SQS, and SNS. No VPC, NAT gateway, EC2, ECS, RDS, OpenSearch, or Step Functions.

## 2. Local and AWS runtimes

| Concern     | Local runtime (default)                                                                     | AWS runtime                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| HTTP        | `node:http` server under `/api/v1`                                                          | API Gateway HTTP API (payload format 2.0) invoking one Lambda function, same route handlers |
| Persistence | A JSON file written atomically (write then rename); a claim and its history in one write    | One DynamoDB table with transactions (section 5 onward)                                     |
| Receipts    | Raw bytes uploaded to the API, measured on the server, stored as files; raw binary download | Presigned S3 POST upload and presigned GET download (section 11)                            |
| Identity    | Development sign-in cookie selecting a sample user; not production authentication           | Cognito user pool, authorization code with PKCE, JWT authorizer (section 17)                |
| Idempotency | `Idempotency-Key` claimed before execution, stored after, released on failure               | Result stored inside the business transaction (section 10)                                  |
| Events      | None                                                                                        | Transactional outbox, EventBridge, and a cleanup worker (section 15)                        |

Both runtimes serve the same API contract and use the same domain package. The AWS composition is `createAwsApplicationHandler` (`services/api/src/aws-composition.ts`), exposed as the Lambda `handler` in `services/api/src/adapters/aws/api-lambda.ts`; the local production composition does not register any AWS service.

## 3. Domain model summary

The full rules are in [the domain model](domain-model.md). The parts that shape the AWS design:

- **Claim:** owner, assigned manager, category, amount in integer minor units with a currency, expense date, merchant, business purpose, optional receipt, status, an optimistic `version`, and timestamps. Drafts may be incomplete; every rule is checked on submission.
- **Lifecycle:** `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → PAID`, and `UNDER_REVIEW → REJECTED → DRAFT` for resubmission. Other transitions are rejected.
- **History:** one entry per accepted claim change, numbered by the claim version it produced. Entries are never edited; the only removal is that an eligible draft (never submitted) is deleted together with its history.
- **Category:** administrator-managed currency, inclusive maximum, receipt threshold (a receipt is required strictly above it), and active state. Policy is evaluated when a claim is submitted or resubmitted.
- **Deletion:** an owner may delete a never-submitted draft with its history. An administrator may delete a category only when no claim uses it; otherwise it is deactivated.
- **Receipts:** PDF, JPEG, or PNG; 1 byte to 10 MB; SHA-256 checksum; the real file type is checked from the leading bytes.

## 4. Architecture overview

| Component        | AWS service                                                     | Purpose                                                                          |
| ---------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| API              | API Gateway HTTP API with a JWT authorizer, one Lambda function | Runs the existing routes through a shared request handler                        |
| Identity         | Cognito user pool                                               | Authenticates users; administrators create users (no self sign-up)               |
| Data             | One DynamoDB table, `ClaimFlow`, on-demand                      | Claims, history, categories, profiles, receipt metadata, idempotency, outbox     |
| Receipt files    | One private S3 bucket                                           | Pending uploads and final receipt copies                                         |
| Web hosting      | A separate private S3 bucket behind CloudFront                  | Serves the built React application over HTTPS                                    |
| Change stream    | DynamoDB Streams, `NEW_AND_OLD_IMAGES`                          | Feeds the outbox publisher and the receipt janitor                               |
| Outbox publisher | Lambda (stream trigger)                                         | Publishes new outbox events to EventBridge and marks them published              |
| Outbox sweeper   | Lambda (EventBridge schedule, every 15 minutes)                 | Republishes events still pending after the stream path failed or expired         |
| Receipt janitor  | Lambda (stream trigger)                                         | Deletes S3 objects for pending uploads whose metadata expired                    |
| Event bus        | EventBridge custom bus `claimflow`                              | Routes internal cleanup events to the cleanup queue                              |
| Cleanup worker   | SQS queue with a dead-letter queue, Lambda consumer             | Deletes replaced or removed receipt objects and purges history of deleted drafts |
| Alarms           | CloudWatch alarms and an SNS topic with an email subscription   | Signals faults by email (section 22)                                             |

### Deployment boundary

- Infrastructure is AWS CDK in TypeScript (`infrastructure/`), one stack (`ClaimFlowStack`, ID `ClaimFlow`). Every component above is defined in it and deployed. Deployment is manual and never automatic.
- The built web files are published to the web bucket manually (`npm run release -w @claimflow/web`, then upload and invalidation; see [the infrastructure README](../infrastructure/README.md#publishing-the-web-application)). The web app finds the API through the `apiBaseUrl` in its deployed `config.json`.
- The local runtime is not connected to this infrastructure.
- The web bucket is private and readable only by the CloudFront distribution through Origin Access Control (HTTPS redirect, `GET` and `HEAD` only). CloudFront cannot list the bucket, so a missing key returns `403`; `403` and `404` are answered with `/index.html` and status `200` for client-side routes. The default `*.cloudfront.net` domain is used; a custom domain is deferred (section 24).

### Verified deployed state

- **Manual browser verification, 21 October 2026.** The web application was published and opened through CloudFront. In a browser: `/config.json` loaded; Cognito PKCE sign-in and the `/auth/callback` exchange worked; the protected session, claim list, and claim detail requests succeeded; receipt upload, download, replacement, and removal worked. The replaced and removed receipts' S3 objects were deleted asynchronously and all four ClaimFlow queues were empty afterwards (details in [the testing guide](testing.md#manual-aws-browser-verification)).
- **Alarms.** 17 CloudWatch alarms and the sweeper's metric are deployed. The SNS subscription was confirmed, and a manual `claimflow-api-errors` ALARM transition delivered an email on 21 October 2026.
- **Limits.** The asynchronous deletions support the publisher → EventBridge → cleanup-worker path only. The receipt janitor, the scheduled outbox sweeper, and the S3 lifecycle rule were not separately verified. The alarm's return to OK was not exercised (no OK action exists). Only the listed flows were exercised, manually; none of this is automated.

## 5. DynamoDB table, keys, and indexes

- **Table:** `ClaimFlow`, keys `PK` and `SK` (strings), on-demand capacity, point-in-time recovery and deletion protection on, stream `NEW_AND_OLD_IMAGES`, TTL attribute `expiresAt` (Unix epoch seconds).
- **Why one table:** every claim change (claim, history, category counter, receipt metadata, outbox, idempotency result) can share one transaction, one set of permissions, and one set of backups and alarms.

| Item                   | PK                              | SK                              | Notes                                                        |
| ---------------------- | ------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| Claim                  | `CLAIM#<claimId>`               | `CLAIM`                         | Get by ID is one `GetItem`                                   |
| History entry          | `CLAIM#<claimId>`               | `HISTORY#<version>`             | Version zero-padded to 10 digits                             |
| Claim outbox event     | `CLAIM#<claimId>`               | `OUTBOX#<occurredAt>#<eventId>` | Publishable claim events and the `internal.*` cleanup events |
| Category               | `CATEGORIES`                    | `CATEGORY#<categoryId>`         | One small, bounded partition                                 |
| Category outbox event  | `CATEGORIES`                    | `OUTBOX#<occurredAt>#<eventId>` | Same transaction as the category change                      |
| User profile           | `USER#<cognitoSub>`             | `PROFILE`                       | Roles and manager assignment                                 |
| Receipt metadata       | `RECEIPT#<receiptId>`           | `RECEIPT`                       | Exists before any claim refers to it                         |
| Idempotency record     | `IDEMPOTENCY#<actorId>#<key>`   | `IDEMPOTENCY`                   | Scoped per user                                              |
| Consumer dedupe record | `CONSUMED#<consumer>#<eventId>` | `CONSUMED`                      | Reserved for future event consumers                          |

History reads use `SK begins_with HISTORY#` and category reads `SK begins_with CATEGORY#`, so outbox items in the same partitions never appear in those results.

**Global secondary indexes.** Only claim items and pending outbox items carry GSI attributes; all indexes project all attributes, so list pages need no second read.

| Index | Partition key value        | Sort key value            | Items                                     | Serves                                 |
| ----- | -------------------------- | ------------------------- | ----------------------------------------- | -------------------------------------- |
| GSI1  | `EMPLOYEE#<employeeId>`    | `<updatedAt>#<claimId>`   | Every claim                               | An employee's claims, newest first     |
| GSI2  | `MANAGER#<managerId>#OPEN` | `<submittedAt>#<claimId>` | Claims `SUBMITTED` or `UNDER_REVIEW` only | A manager's review queue, oldest first |
| GSI3  | `STATUS#<status>`          | `<updatedAt>#<claimId>`   | Every claim                               | Claims in one status, newest first     |
| GSI4  | `CLAIM`                    | `<updatedAt>#<claimId>`   | Every claim                               | All claims, newest first               |
| GSI4  | `OUTBOX#PENDING`           | `<occurredAt>#<eventId>`  | Unpublished outbox items only             | Recovery of unpublished events         |

GSI2 is sparse (decided claims leave the queue automatically), GSI3 follows status, and GSI4 holds two item types under different partition values that are never queried together. Sort keys end in the item ID for a stable order. `GSI4PK = CLAIM` and `OUTBOX#PENDING` each concentrate writes in one index partition (about 1,000 writes per second); that is far above the expected volume, and sharding is deferred (section 24). Whether a category is in use is answered by a `claimCount` attribute on the category item, not an index.

## 6. Access patterns

Reads used for write decisions are strongly consistent; GSI queries are always eventually consistent. **No access pattern uses a table scan or a filter expression.**

| Area        | Pattern                                                                    | Operation                                                                                 |
| ----------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Claims      | Get a claim; a claim's history in version order                            | `GetItem`; `Query PK, SK begins_with HISTORY#` (strong)                                   |
| Claims      | An employee's claims; a manager's open queue; claims by status; all claims | `Query` GSI1, GSI2, GSI3, GSI4 (eventual)                                                 |
| Claims      | Create, update at an expected version, delete a never-submitted draft      | Transactions (sections 8 and 12)                                                          |
| Categories  | Get, list, create, update, delete; "is a category used?"                   | `GetItem` and `Query` (strong); transactions; `claimCount` on the category                |
| Users       | Profile on every request; display names for a response                     | `GetItem` (strong); `BatchGetItem` of only the needed profiles (eventual)                 |
| Receipts    | Create pending metadata; read metadata; inspect, copy, download            | Transaction; `GetItem`; S3 `HeadObject`, ranged `GetObject`, `CopyObject`, presigned GET  |
| Idempotency | Look up a result; store a completed or rejected result                     | Strong `GetItem`; `Put` inside the transaction; standalone conditional `Put` (rejections) |
| Outbox      | Find unpublished events; mark published                                    | `Query GSI4 OUTBOX#PENDING` older than 5 minutes; conditional `UpdateItem`                |
| Cleanup     | Purge a deleted draft's history                                            | `Query HISTORY#`, then `BatchWriteItem` deletes                                           |

## 7. Items and codecs

Every item carries an `entityType` discriminator and is read and written through a strict codec (`services/api/src/adapters/aws/dynamodb-*-items.ts`). Reads reject malformed stored items (wrong keys or entity type, unexpected or missing attributes, impossible values) with an integrity error that echoes no stored value, rather than guessing; strict decoding is a safety feature and is never bypassed. Money is stored as integer minor units, timestamps as canonical ISO-8601 UTC strings, and `expiresAt` as whole epoch seconds. Receipt metadata has the states `PENDING`, `ATTACHED`, `REPLACED`, and `REMOVED`; outbox items are `PENDING` or `PUBLISHED`; idempotency records are `COMPLETED` (a response snapshot or a result reference) or `REJECTED`. Event `schemaVersion` versions only event payloads, not stored item shapes; evolving stored shapes (expand and contract) is a trigger-based future concern ([readiness record](engineering-readiness.md#triggers-for-further-work)).

## 8. Transactional write model

Every accepted mutation is one `TransactWriteItems` call (up to 100 operations and 4 MB, never the same item twice) containing the business writes with their conditions, the history entry for claim changes, any outbox events, and the completed idempotency record. No state exists in which a change lacks its history, its events, or its stored result.

| Operation                                  | In the transaction                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create claim                               | Claim, history v1, category `claimCount +1` with guard (only if a category is set), idempotency                                                                                                 |
| Edit draft                                 | Claim update, history, old category `-1` and new category `+1` with guard (only if the category changed), idempotency                                                                           |
| Submit or resubmit                         | Claim update, history, category `ConditionCheck`, outbox `claim.submitted`, idempotency                                                                                                         |
| Start review, approve, reject, reopen, pay | Claim update, history, outbox event, idempotency                                                                                                                                                |
| Attach, replace, or remove a receipt       | Claim update, history, receipt metadata updates; for replace and remove, outbox `internal.receipt-object-deletion-requested`; idempotency                                                       |
| Delete draft                               | Delete claim, category `-1`, receipt metadata to `REMOVED`, outbox `internal.claim-history-purge-requested` and (with a receipt) the receipt deletion event, idempotency (at most 6 operations) |
| Create receipt upload                      | Pending receipt metadata, idempotency                                                                                                                                                           |
| Create, update, or delete a category       | Category write, outbox `category.*`, idempotency                                                                                                                                                |

Updates that carry a publishable event also set `lastEventVersion`. The transaction is composed by `composeBusinessTransaction` and sent unchanged by `DynamoDbTransactionExecutor` (`services/api/src/adapters/aws/dynamodb-transaction.ts`, `dynamodb-transaction-executor.ts`), which add no retries and map no errors.

**Request tokens.** Each request carries a `ClientRequestToken` (at most 36 characters) derived from the canonical payload: the first 32 hex characters of a SHA-256 over the actor, the idempotency key, the request fingerprint, and the hash of the canonically serialized `TransactItems` (sorted keys, JSON values only). An identical payload always yields the same token, whether retried by the SDK, by the ambiguous-failure procedure, or rebuilt by a fresh invocation; any changed value yields a different token, so a token is never paired with a different payload. DynamoDB honors tokens only briefly and at the transport level; the conditional idempotency `Put` is what prevents two differently built transactions for one key from both committing, and that record stays the durable result for 24 hours.

## 9. Conditional writes and category guards

| Write                                 | Condition                                                                 | Protects                                                     |
| ------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Create claim, history, or outbox item | `attribute_not_exists(PK)`                                                | Written once; a duplicate fails the transaction              |
| Update claim                          | `#version = :expectedVersion`                                             | Optimistic concurrency                                       |
| Owner / manager operations            | Also `employeeId = :actor` / `assignedManagerId = :actor`                 | The write itself refuses the wrong user                      |
| Delete draft                          | version, owner, `status = DRAFT`, and `attribute_not_exists(submittedAt)` | The never-submitted rule at write time                       |
| Update or delete category             | `#version = :v`; delete also requires `claimCount` absent or zero         | Administrator conflicts; a category in use cannot be deleted |
| Decrement `claimCount`                | `attribute_exists(PK) AND claimCount >= :one`                             | The counter never underflows or is created by `ADD`          |
| Idempotency record                    | `attribute_not_exists(PK) OR expiresAt < :nowEpoch`                       | One result per key; expired leftovers count as absent        |
| Attach receipt                        | `ownerId = :actor AND #state = :pending`                                  | Only a pending receipt owned by the caller attaches          |

**Category guards.** A claim write that depends on category policy must fail if the category changed after the domain read it; every administrator change (including deactivation and limit changes) increments the category `version`. Creating a claim with a category, or moving a draft to a new one, guards the counter update with `#version = :readVersion AND active = :true`. Submission and resubmission use a `ConditionCheck` with the same guard (a transaction may not touch an item twice, so the guard sits on the counter update when there is one). Other edits, receipt changes, and review actions carry no guard because policy is evaluated at submission. Guards require an active category; `mustBeActive: false` is refused.

If a transaction is cancelled, the adapter does not work out which condition failed; the service runs the recovery below, which rereads state and maps the result to the API's existing errors (`VERSION_CONFLICT`, `CATEGORY_IN_USE`, `RECEIPT_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`). When recovery finds that the category changed, the category decision is rerun once with the reread category under the same request and key: a deactivated category or lowered limit then produces the normal `400 VALIDATION_FAILED`, and a second change returns `409 VERSION_CONFLICT`.

## 10. Idempotency

**Request flow.**

1. Look up the key with a strongly consistent `GetItem`: the same fingerprint replays the stored response and runs no business logic; a different fingerprint is `409 IDEMPOTENCY_CONFLICT`; absent or expired continues. Expiry is checked against the clock, never by relying on TTL deletion.
2. Execute the domain logic and build the response, which depends only on the new state and display names. The success status is fixed per route.
3. Commit one transaction with the business writes and the idempotency `Put`.
4. On cancellation, recover (below).
5. On a business rejection (a validation or domain error, or a conflict established by recovery), store the error response with a standalone conditional `Put`, so a retry gets the same answer. If that `Put` loses to an existing record, reread it: the same fingerprint replays, a different one is `IDEMPOTENCY_CONFLICT`.

There is no in-progress state, so nothing needs releasing after a failure. A crash before the commit leaves no record and the retry executes once; a crash after the commit leaves a completed record and the retry replays the original response; two simultaneous identical requests commit once and the other replays the winner.

**Recovery after a cancelled transaction.** Only `TransactionCanceledException`, identified by error type and never by message text or per-item reasons, enters recovery. Recovery rereads state, which is deterministic:

1. Strongly reread the idempotency record: the same fingerprint means a concurrent request won (replay); a different fingerprint is `IDEMPOTENCY_CONFLICT`.
2. Otherwise strongly reread every conditioned item and compare with what the request used:

   | Reread finding                                                       | Outcome                                                  |
   | -------------------------------------------------------------------- | -------------------------------------------------------- |
   | Claim missing or not visible to the actor                            | `404 NOT_FOUND`                                          |
   | Claim `version` differs from the expected version                    | `409 VERSION_CONFLICT`                                   |
   | A guarded category's version changed or it is no longer active       | Rerun the category decision once (section 9)             |
   | An administrator update or delete finds a different category version | `409 VERSION_CONFLICT`                                   |
   | A category being deleted now has `claimCount >= 1`                   | `409 CATEGORY_IN_USE`                                    |
   | Receipt metadata no longer `PENDING` or no longer owned by the actor | `400 VALIDATION_FAILED` with `RECEIPT_UNAVAILABLE`       |
   | A category to decrement is missing or has `claimCount < 1`           | Data-integrity error: generic `500`, logged, not retried |
   | Nothing differs                                                      | Unclassified cancellation: bounded retry                 |

3. An unclassified cancellation made no changes, so the whole operation (reread, decide, rebuild, derive the token) is retried with exponential backoff and jitter, up to 3 attempts, each logged with the retry count. It is never reported as a known conflict. If every attempt fails, the request returns the generic `500` (retries produce structured log events, but there is no dedicated metric or alarm for them); a later client retry with the same key is safe because nothing committed.

The reread state is authoritative: if another request changed an item in between, this request is evaluated against the latest state, as if it had arrived later.

**Other errors.** `ValidationException` and `IdempotentParameterMismatchException` are programming errors (generic `500`, logged, not retried). Throttling and capacity errors are retried by the SDK with the same token. `InternalServerError`, service-unavailable responses, timeouts, and lost connections are **ambiguous failures**: they do not prove whether the transaction committed, so the outcome is established, not assumed. Reread the idempotency record (a record means it committed: replay or conflict); if there is none, retry the identical transaction with the same token (DynamoDB will not apply it twice if it had committed); if the outcome still cannot be established, return the generic `500`, and a later client retry replays the committed result or executes the request.

**Stored results.** A completed record stores the full response snapshot, so a retried create returns exactly the original response (including the original `claimId`) even if the claim has since changed. Only a result with an expiring part is stored as a reference: `POST /receipts` returns a presigned form valid for 15 minutes, so its record holds `{ status: 201, resultRef: { receiptId } }`. A replay rereads the metadata and, while it is still `PENDING`, signs a new form for the same receipt, so no duplicate is created.

Implementation map (`services/api/src/adapters/aws/`): `dynamodb-lookups.ts` and `dynamodb-idempotency-writer.ts` (lookup and rejection write), `dynamodb-idempotency-coordinator.ts`, `dynamodb-idempotent-transaction-committer.ts` (commit and ambiguous-failure handling), `claim-mutation-coordinator.ts`, `receipt-upload-coordinator.ts` with `receipt-upload-replay-resolver.ts`, and the `aws-*-service.ts` files that add business-state recovery per operation.

## 11. Receipt lifecycle

S3 and DynamoDB cannot share a transaction. Correctness comes from three rules: DynamoDB is the source of truth, every S3 step can be repeated safely, and every possible orphan has a defined cleanup.

| Prefix                        | Contents               | Lifecycle                                |
| ----------------------------- | ---------------------- | ---------------------------------------- |
| `uploads/pending/<receiptId>` | Uploaded, not attached | Expires after 1 day (S3 lifecycle rule)  |
| `receipts/<receiptId>`        | Attached receipts      | Kept until deleted by the cleanup worker |

**Upload contract.** Uploads use a presigned S3 **POST policy**, not a presigned `PUT`, because a POST policy enforces the exact size with the documented `content-length-range` condition and browsers send it as ordinary `multipart/form-data`. The policy is valid for 15 minutes and fixes the bucket, the key `uploads/pending/<id>`, the declared content type, exactly the declared size, and the declared SHA-256 checksum (S3 rejects a body that does not match). The server separately verifies size, type, checksum, and the real file type before attachment.

1. **Upload.** `POST /receipts` with `{ fileName, contentType, sizeBytes, checksumSha256 }` and an idempotency key validates type and size, then in one transaction stores `PENDING` metadata (24-hour `expiresAt`) and the idempotency record, and returns the receipt ID and the signed form. The browser then posts the signed fields followed by the file to S3.
2. **Attach or replace.** Load the claim and metadata (strong reads; the metadata must belong to the caller and be `PENDING`, otherwise `RECEIPT_UNAVAILABLE`), check the expected version, and verify the object: `HeadObject` with checksum mode (size, type, and stored SHA-256 must equal the metadata; an object without a SHA-256 is rejected) and a ranged `GetObject` of bytes 0–15 whose detected type must match. Run the domain rule, `CopyObject` to `receipts/<id>` (a fixed key, so a repeat after an uncommitted copy overwrites the same object), then commit one transaction: claim update and history, metadata to `ATTACHED` (measured values, `attachedClaimId`, `expiresAt` removed), for a replacement the old metadata to `REPLACED` with a 30-day `expiresAt` plus a deletion event, and the idempotency record. Afterwards the pending object is deleted best effort.
3. **Remove.** One transaction updates the claim, writes history, sets the metadata to `REMOVED` (30-day `expiresAt`), writes the deletion event, and stores the result; the cleanup worker deletes the object.
4. **Download.** `GET /claims/{claimId}/receipt` returns `{ url, expiresAt }`, a presigned GET valid for 5 minutes with a `Content-Disposition` override. A redirect is not used because a browser following a plain link does not send the bearer token.

| Failure                                                             | Result                                    | Cleanup                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The browser never uploads, or S3 rejects the upload                 | Nothing stored; metadata stays `PENDING`  | TTL deletes the metadata                                                                        |
| Verification fails                                                  | Nothing committed                         | The lifecycle rule deletes the pending object                                                   |
| Copy succeeded, then the transaction failed or the function crashed | Orphaned final object; metadata `PENDING` | When TTL deletes the metadata, the janitor deletes `receipts/<id>` and `uploads/pending/<id>`   |
| Pending object not deleted after commit                             | Leftover pending object                   | The lifecycle rule                                                                              |
| Receipt replaced, removed, or its draft deleted                     | The old final object must be deleted      | Outbox event → cleanup queue → cleanup worker `DeleteObject`, retried, with a dead-letter queue |

**Abandoned uploads are cleaned up by two independent paths, not one sequence.** When DynamoDB TTL deletes pending metadata, the stream delivers a `REMOVE` record to the **receipt janitor**, which deletes the receipt's objects (a missing object counts as deleted). Separately, the **S3 lifecycle rule** expires `uploads/pending/` objects after a day, which also catches a pending object whose best-effort deletion failed after a successful attach. Neither path was separately verified on the deployed environment.

The janitor's stream filter admits only `REMOVE` events made by the DynamoDB service whose old image is a `PENDING` receipt. The janitor's and the cleanup worker's function settings are in [the infrastructure README](../infrastructure/README.md).

## 12. Draft deletion and history cleanup

Deleting a never-submitted draft is one transaction (section 8) that deletes the claim, decrements the category counter, retires the receipt metadata, and writes the cleanup events, but deletes no history. Logical deletion is immediate: every history read loads the claim first, so the API answers `404` for the claim and its history as soon as the transaction commits. Physical cleanup is eventually consistent: the cleanup worker consumes `internal.claim-history-purge-requested`, queries the claim's `HISTORY#` keys page by page, and deletes them with `BatchWriteItem` (25 per call, retrying unprocessed items), treating an already-missing item as success so a retried or duplicated event is harmless. Failed messages retry through SQS into a dead-letter queue that has an alarm. History rows may remain briefly but are unreachable through the API; the claim's outbox items are not deleted by the worker and expire after publication (section 14).

## 13. Pagination and cursor validation

`limit` is 1–100 (default 20). The adapter queries `limit + 1` items and issues a `nextCursor` only when the extra item exists, so a final page is never empty, and no filter expressions are used. A cursor is canonical base64url JSON of at most 512 characters holding a version, the list, the index, and the exclusive start key. Before use it must decode, carry version 1, name the requested list and that list's index, contain exactly the expected key attribute names with string values, carry partition values equal to the ones this request expects (so a cursor with `OUTBOX#PENDING` or another caller's partition is rejected), match the key shapes, and re-encode to exactly the same text. Any failure is `400 VALIDATION_FAILED` with `INVALID_CURSOR`, before any query is sent (`dynamodb-cursor.ts`). Signing cursors with an HMAC is deferred (section 24).

## 14. TTL policies

| Item                                       | `expiresAt`                                  |
| ------------------------------------------ | -------------------------------------------- |
| Idempotency record (completed or rejected) | 24 hours after creation                      |
| Pending receipt metadata                   | 24 hours after upload; removed on attachment |
| Replaced or removed receipt metadata       | 30 days after the state change               |
| Outbox item, `PENDING`                     | None; an unpublished event never expires     |
| Outbox item, `PUBLISHED`                   | 7 days after `publishedAt`                   |
| Consumer dedupe record                     | 14 days after processing                     |
| Claims, history, categories, user profiles | None                                         |

TTL deletion can lag well behind `expiresAt`, so every condition that depends on expiry treats `expiresAt < now` as absent instead of relying on deletion.

## 15. Outbox events, publication, and recovery

**Why a separate outbox.** History is the audit record, not an event contract. Each publishable or cleanup event is its own outbox item written in the same transaction as the change, with a stable envelope and a deliberately chosen payload.

**Envelope.** `eventId` (unique, the consumers' deduplication key), `eventType`, `schemaVersion` (starting at 1), `occurredAt` (assigned just before the transaction), `source` (`claimflow.api`), `aggregate` (`type`, `id`, `version`, and `previousEventVersion`), `correlationId`, `causationId`, `actorId`, and `payload`. `previousEventVersion` exists because draft edits and receipt changes bump the claim version without publishing, so published versions are not consecutive; the claim or category stores `lastEventVersion`, updated in the same transaction as each publishable event and copied into the next event's `previousEventVersion`. Cleanup events use the same envelope under the claim, carry the requesting mutation's claim version (a draft deletion writes no history entry, so its events carry the deleted claim's version plus one), always have `previousEventVersion: null`, and do not change `lastEventVersion`.

**Payload policy.** Payloads carry identifiers, amounts, categories, and status timestamps only. Free text (merchant, business purpose, comments) and names are excluded because they may be personal data; a consumer that needs them reads the claim through the authorized API.

| Event                                                                                                           | Kind        | Payload beyond identifiers, amount, and category                            |
| --------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `claim.submitted`, `claim.review-started`, `claim.approved`, `claim.rejected`, `claim.reopened`, `claim.paid`   | Publishable | Timestamps (`submittedAt`, `reviewedAt`, `paidBy`, `paidAt`) where relevant |
| `category.created`, `category.policy-changed`, `category.deactivated`, `category.activated`, `category.deleted` | Publishable | `categoryId`, `version`, changed fields only                                |
| `internal.receipt-object-deletion-requested`                                                                    | Internal    | `claimId`, `receiptId`, `objectKey`                                         |
| `internal.claim-history-purge-requested`                                                                        | Internal    | `claimId`                                                                   |

Draft creation, draft edits, and receipt attachment are recorded in history but not published. Internal events are routed only to the cleanup worker.

**Publisher (stream path).** The table stream, through an event source mapping filtered to `INSERT` records whose `SK` begins `OUTBOX#`, invokes the publisher in batches of at most 10. For each batch it rereads each event strongly and skips any already `PUBLISHED`, calls `PutEvents` on the `claimflow` bus (`Source = claimflow.api`, `DetailType = eventType`, `Detail` = the envelope), and marks each successful entry with a conditional `UpdateItem` (`PENDING` to `PUBLISHED`, `publishedAt`, a 7-day `expiresAt`, and the `GSI4` attributes removed; if the condition fails another path already marked it). It reports partial failures with `ReportBatchItemFailures`, returning the first failed sequence number so Lambda retries from there; later records may be redelivered, which skipping and consumer deduplication absorb. The mapping splits batches on error, retries a bounded number of times, expires records after 24 hours, and sends exhausted-batch metadata to a failure queue (the events themselves stay pending for the sweeper).

**Sweeper (recovery path).** Stream records are retained for 24 hours, so a longer publication outage cannot be recovered from the stream. The sweeper runs every 15 minutes, reads the clock once, queries `GSI4` for pending events older than 5 minutes (the grace period avoids racing the stream path), takes at most 10, publishes and marks them exactly as the publisher does, and throws on any failure so the next run retries. Pending items never expire, so an unpublished event is never lost. Before publishing, it reports the age of the oldest selected event (0 when none is overdue) as the `ClaimFlow/OldestPendingOutboxAge` metric, written as one Embedded Metric Format log line; a failure to write that line never stops the publication.

**Routing.** The only rule on the `claimflow` bus routes the two `internal.*` events to the cleanup queue; publishable events have no consumer today.

## 16. Event delivery guarantees and consumer behavior

- **At least once.** An event is published and then marked, so a crash between the two, or both paths handling one event, publishes it twice. Consumers deduplicate by `eventId`.
- **No cross-item ordering.** DynamoDB Streams orders only modifications to one item key, and EventBridge does not guarantee order. Events are independent facts ("claim X was approved at time T"), and no current consumer needs ordering.
- **Gap detection, not reordering.** A consumer that tracks the last version per aggregate can compare it with `previousEventVersion` to notice a missing earlier event. Strict ordering would need a dedicated design (section 24).
- **Consumers.** The cleanup worker is the only consumer and is idempotent by construction (deleting a missing object or item succeeds). A future consumer would have its own rule, SQS queue, and dead-letter queue, would write a `CONSUMED#<consumer>#<eventId>` record in the same transaction as any DynamoDB effect, and for external effects (email, SNS) would check the record, send, then record, accepting a rare duplicate rather than a lost notification.

## 17. Identity and authorization

| Concern           | Local runtime                                        | AWS runtime                                                                                 |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Authentication    | Development sign-in cookie selecting a sample user   | Cognito user pool; API Gateway JWT authorizer validates the access token before Lambda runs |
| User identifier   | Sample user ID                                       | Cognito `sub` claim                                                                         |
| Roles and manager | Seed directory                                       | `USER#<sub>` profile item in DynamoDB                                                       |
| User creation     | Defined in code                                      | Created by an administrator, with a profile item; no self sign-up                           |
| Session endpoints | `PUT` and `DELETE /session` select or clear the user | Not available; `GET /session` returns the signed-in user only                               |

The actor is built on the server from the profile on every request, so roles and manager assignments never come from the client or from token claims or groups. A missing subject, or a subject without a profile, is unauthenticated.

**Cognito.** The app client `ClaimFlowWeb` is a public client with no secret; it allows only the authorization code grant (used with PKCE), refresh as its only direct flow, and the `openid` and `email` scopes. Sign-in returns to `/auth/callback` and sign-out to `/` on the CloudFront origin (or `http://localhost:5173`). Access and ID tokens last 1 hour and refresh tokens 30 days. The hosted UI is Cognito's classic hosted UI on a prefix domain `claimflow-<account ID>`, with default appearance. There is no Identity Pool, no social or federated provider, and no custom branding.

**HTTP API authorizer.** Every route except `GET /api/v1/health` uses the JWT authorizer, which checks the issuer, the audience (the web client), and the `openid` scope. Only Cognito **access** tokens carry a `scope` claim, so requiring a scope also refuses ID tokens. A dedicated resource-server scope would be stricter and is a possible later change. CORS allows the CloudFront origin only and the throttle is bounded; the route list and settings are in [the infrastructure README](../infrastructure/README.md#http-api).

**Web sign-in.** The web app enables Cognito sign-in only when the deployment provides `/config.json` (`apiBaseUrl`, `cognito.hostedUiUrl`, `cognito.clientId`). Development sign-in is a fallback only on `localhost` and `127.0.0.1`; on any other host a missing or invalid file shows a configuration error. It uses the authorization code flow with PKCE and a random `state`, keeps the verifier and tokens in `sessionStorage` (never `localStorage`) and does not store the ID token, sends the access token as the Bearer token, refreshes shortly before expiry or once after a `401`, returns to sign-in when a refresh is rejected, and signs out through the Cognito logout endpoint. AWS receipt uploads send no bearer token or credentials to S3, and downloads navigate to an https presigned URL. These behaviors are covered by fake-network tests ([testing guide](testing.md)); only the flows listed in section 4 were verified against the deployment.

## 18. Ports and adapters

The application services depend on ports (`services/api/src/application/ports.ts`): `ClaimRepository`, `CategoryRepository`, `UserDirectory`, `ReceiptStorage`, `IdempotencyStore`, `Clock`, `IdGenerator`, and `Logger`, plus the development-only `DevelopmentUserCatalogue`. The AWS path reuses the domain and the services' business logic but is not a drop-in implementation of every local port:

- **Reads:** `DynamoDbClaimReader`, `DynamoDbCategoryReader`, and the DynamoDB user directory implement the repository read methods and the directory (`get`, `getMany`); the AWS runtime has no user catalogue.
- **Writes, idempotency, and receipts:** the local `ClaimRepository`, `ReceiptStorage`, and `IdempotencyStore` write interfaces are not used on AWS. Instead the AWS services (`aws-*-service.ts`) prepare transactions with the DynamoDB writers, commit them with the idempotent committer, and use the S3 adapters (`s3-upload-form.ts`, `s3-receipt-inspector.ts`, `s3-receipt-objects.ts`, `s3-download-url.ts`) for objects. The request pipeline selects them through opt-in registrations, and a registered operation never falls back to a local service.
- **Shared:** `Clock`, `IdGenerator`, and `Logger` are the same; logs go to standard output and CloudWatch Logs.

**Commit options.** Write paths accept a commit envelope built by the services: the outbox events, the completed idempotency record (actor, key, fingerprint, response, `createdAt`, `expiresAt`), and an optional category guard (`services/api/src/application/commit.ts`). The local JSON database already applies each write atomically, so the local runtime has the same all-or-nothing behavior.

**Request pipeline.** A transport-neutral handler (`services/api/src/http/api-handler.ts`) owns routing, body limits, idempotency, error conversion, request and correlation IDs, headers, and request logging, and receives authentication through an injected resolver. The `node:http` server and the API Gateway payload-2.0 adapter (`lambda-adapter.ts`) are thin wrappers; the adapter passes on only the authorizer-validated `sub` as the verified subject.

## 19. Security boundaries

- **Edge:** the JWT authorizer rejects requests without a valid Cognito access token before any code runs; throttling is set on the API stage.
- **Application:** every operation loads the actor from the profile and applies the domain authorization rules; inaccessible claims return `404`.
- **Data:** conditional writes repeat the ownership and assignment checks inside the transaction.
- **Least privilege:** each function has its own IAM role limited to the table, indexes, bucket prefixes, bus, and queues it uses. The API function cannot read the stream or delete final receipts; the janitor can only delete receipt objects; the cleanup worker can only delete history items and receipt objects; no role has a CloudWatch permission. The statements are in [the infrastructure README](../infrastructure/README.md).
- **Receipt bucket:** public access blocked, non-TLS requests denied, server-side encryption, and CORS limited to `POST` from the web origin; upload policies last 15 minutes and download URLs 5 minutes.
- **Web hosting:** the web bucket is private and holds only the built web application, never user data.
- **Encryption:** DynamoDB, S3, SQS, and CloudWatch Logs are encrypted at rest with AWS-managed keys; TLS in transit.
- **Events:** no free text in payloads.
- **History:** IAM cannot restrict updates by sort key, so "never edited" relies on code that never updates history items, the `attribute_not_exists` condition on every history `Put`, and point-in-time recovery.

## 20. Consistency summary

| Area                                 | Guarantee                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Claim, category, and receipt changes | Atomic with history, outbox events, and the idempotency result                            |
| Reads used for write decisions       | Strongly consistent                                                                       |
| List views (GSI1–GSI4)               | Eventually consistent; usually visible within a second                                    |
| Event publication                    | At least once; no cross-item ordering                                                     |
| History purge after draft deletion   | Logically immediate; physically eventually consistent                                     |
| Receipt object cleanup               | Eventually consistent, through the cleanup worker, the janitor, and the S3 lifecycle rule |

## 21. Cost considerations

- **No always-on compute:** Lambda, API Gateway, DynamoDB on-demand, EventBridge, and SQS are billed per use. The API is an HTTP API (lower request price) and functions run on arm64.
- **Charges without traffic (low, not zero):** DynamoDB storage and point-in-time recovery, S3 storage, CloudWatch Logs, metrics, and alarms, retained data within retention periods, and the sweeper's scheduled invocations every 15 minutes, which query `GSI4` even when nothing is pending.
- **Writes:** a transactional write costs twice a standard write, and each claim write also updates up to four index entries and usually one outbox item.
- **Web:** CloudFront is billed per request and per byte, with no fixed charge; the default domain avoids certificate and DNS costs.
- **Retention:** log groups keep 30 days, and the lifecycle rule and TTL keep abandoned uploads, idempotency records, and published outbox items from accumulating.
- **Not assessed:** budgets and cost-anomaly alerts, and cost under abuse or sustained failure ([readiness record](engineering-readiness.md)).

## 22. Operations

- **Backups:** point-in-time recovery and deletion protection on the table. A restore has not been exercised, so recovery is not claimed. S3 versioning is not used because attached receipts are never modified.
- **Alarms (deployed):** 17 CloudWatch alarms at standard resolution, treating missing data as not breaching: the HTTP API 5xx rate (5% in 2 of 3 five-minute periods, no minimum request count); Lambda errors and throttles for all five functions; iterator age for the publisher and janitor; visible-message depth for the cleanup dead-letter queue and the publisher and janitor failure queues; and the age of the oldest pending outbox event (30 minutes in 2 consecutive 15-minute periods), from the sweeper's `ClaimFlow/OldestPendingOutboxAge` metric. Thresholds and periods are in [the infrastructure README](../infrastructure/README.md#cloudwatch-alarms).
- **Notifications (deployed):** one standard SNS topic `claimflow-alarms` (TLS-only publishing, no customer-managed key) whose policy lets CloudWatch publish only for this account's `claimflow-*` alarms, and one email subscription whose address is the required `NoEcho` stack parameter `AlarmNotificationEmail`. Every alarm sends only its `ALARM` transition; no OK or insufficient-data action is configured, so recovery sends nothing. There is no dashboard.
- **Logs:** structured JSON with request and correlation IDs plus the Lambda request ID; request bodies, receipt contents, tokens, and presigned URLs are never logged.
- **Recovery paths:** unpublished events are republished by the sweeper; failed cleanup messages are retried from their dead-letter queues after the cause is fixed. There are no written runbooks, and failure-queue messages are inspected and replayed by hand.

## 23. Testing and verification

All automated tests run without AWS: the adapters and services are tested against fakes, the stack is tested by synthesizing it locally, and the web app is tested with a faked network. The deployed environment has only the dated manual browser verification in section 4, which is not automated. See [the testing guide](testing.md) for the layers, what each proves, and the notice-delivery checks. Two things earlier designs called for are **not implemented**: a shared adapter contract suite run against both runtimes, and an opt-in integration suite against a real table and bucket (including negative upload tests: wrong length, wrong checksum, wrong content type). The upload conditions are therefore verified by unit tests of the policy and by successful real uploads, not by real rejection tests.

## 24. Deferred options

These are recorded for later and are not part of the current design.

- **HMAC-signed cursors:** structural validation is mandatory today; signing would make cursors tamper-evident.
- **Sharding GSI4 partitions:** if write volume ever approaches one partition's limit.
- **Strict per-claim event ordering:** a dedicated design for a future consumer that needs it, for example buffering by `previousEventVersion`.
- **Customer-managed KMS keys:** only if a requirement calls for them; AWS-managed encryption is used.
- **Custom web domain:** an alternate domain with an ACM certificate in `us-east-1` and DNS records.
- **A dedicated resource-server scope** for the API authorizer instead of `openid`.
- **Real-AWS integration tests, restore drills, runbooks, access logging, a WAF, and budget alerts:** not built; they become relevant as the triggers in [the readiness record](engineering-readiness.md#triggers-for-further-work) occur.

## 25. Decisions

Decisions that shaped the design, all settled; there are no open decisions. (The testing-approach and design-only-phase decisions, D8 and D9, are superseded and omitted.)

| #   | Decision                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | AWS receipt uploads use a presigned S3 POST policy with exact size, type, and SHA-256 conditions, and downloads use presigned URLs. The local runtime keeps its raw upload and binary download. |
| D2  | A `claimCount` usage counter on categories, with category guards built on it                                                                                                                    |
| D3  | Store rejected (4xx) requests under their idempotency key                                                                                                                                       |
| D4  | Exclude free text from event payloads                                                                                                                                                           |
| D5  | The event catalog in section 15; draft and receipt steps are not published                                                                                                                      |
| D6  | When a category guard fails, rerun the decision once automatically, then return `409`                                                                                                           |
| D7  | Retention: published outbox items 7 days after publication; pending outbox items never expire; replaced or removed receipt metadata 30 days                                                     |
| D10 | `lastEventVersion` on claims and categories and `previousEventVersion` on events, for gap detection                                                                                             |
| D11 | Outbox sweeper every 15 minutes with a 5-minute grace period                                                                                                                                    |
| D12 | Recovery from cancelled transactions by strongly rereading the idempotency record and conditioned items, without per-item cancellation reasons                                                  |
| D13 | A deterministic `ClientRequestToken` from the canonical payload; ambiguous failures resolved through the idempotency record and identical retries                                               |
| D14 | Receipt attachment requires `PENDING` metadata only; committed attachments are retried only through idempotent replay                                                                           |
| D15 | Web hosting: a private S3 bucket behind CloudFront with Origin Access Control, HTTPS redirection, and `/index.html` served for missing paths                                                    |

**Settled choices:** Region `ap-southeast-1`; one API Lambda behind an HTTP API; Cognito User Pool with JWT authorization, administrator-created users, and roles and manager in DynamoDB profiles; infrastructure as code in AWS CDK (TypeScript) with manual deployment; the default `*.cloudfront.net` domain.
