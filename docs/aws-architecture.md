# AWS architecture

This document defines the approved target architecture for running ClaimFlow on AWS. The architecture is being implemented in increments. The TypeScript CDK application exists in `infrastructure/`. The `ClaimFlow` DynamoDB table, the `ClaimFlow` Cognito User Pool with its web app client and classic hosted UI domain, the receipt bucket, and web hosting are defined and deployed in `ap-southeast-1`. The application is not connected to any of them yet, and no built web application files are uploaded. All other components, including the application's AWS adapters, are future increments (see section 4).

The document distinguishes three things throughout:

- **Current local implementation:** what the repository runs today.
- **Approved target architecture:** what will be built on AWS, through new adapters, without removing the local runtime.
- **Deferred options:** ideas recorded for later that are **not** part of the approved design.

**AWS Region:** `ap-southeast-1` (Singapore). All resources in this design are deployed to this Region.

## Contents

1. [Principles](#1-principles)
2. [Current local implementation](#2-current-local-implementation)
3. [Domain model summary](#3-domain-model-summary)
4. [Target architecture overview](#4-target-architecture-overview)
5. [DynamoDB table, keys, and indexes](#5-dynamodb-table-keys-and-indexes)
6. [Access patterns](#6-access-patterns)
7. [Example items](#7-example-items)
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
23. [Testing strategy](#23-testing-strategy)
24. [Deferred options](#24-deferred-options)
25. [Decisions](#25-decisions)

## 1. Principles

- **Adapters, not rewrites.** The domain rules are unchanged and the application services keep their responsibilities. AWS support is added through new implementations of the ports, and the local runtime remains the default for development.
- **One atomic commit per mutation.** Every accepted change, its audit history, its outbox events, and its idempotency result commit together or not at all.
- **The server decides.** Identity, roles, ownership, manager assignment, and status are always loaded on the server. Request bodies never carry identity.
- **Serverless only.** API Gateway, Lambda, DynamoDB, S3, CloudFront, Cognito, EventBridge, and SQS. No VPC, NAT gateway, EC2, ECS, RDS, OpenSearch, or Step Functions.

## 2. Current local implementation

| Concern     | Current implementation                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP        | A `node:http` server under `/api/v1` with thin route handlers (`services/api/src/http`).                                                                                                                                                                                          |
| Persistence | A JSON file (`.local/claimflow.json`) written through a serialized, atomic write-then-rename. A claim and its history entry are stored in one write.                                                                                                                              |
| Receipts    | Raw file bytes are uploaded to the API, measured and checked on the server, and stored as files in `.local/receipts/`.                                                                                                                                                            |
| Identity    | Development sign-in: an HMAC-signed `HttpOnly` cookie that selects one of the sample users in `services/api/src/adapters/local/seed.ts`. This is not production authentication.                                                                                                   |
| Idempotency | An `Idempotency-Key` header on every mutation. A key is claimed before execution (`begin`), the response is stored afterwards (`complete`), and the key is released after an unexpected failure (`abandon`).                                                                      |
| Events      | None.                                                                                                                                                                                                                                                                             |
| Ports       | `ClaimRepository`, `CategoryRepository`, `UserDirectory`, `ReceiptStorage`, `IdempotencyStore`, `Clock`, `IdGenerator`, `Logger`, and the development-only `DevelopmentUserCatalogue` that lists the sample users for the user chooser (`services/api/src/application/ports.ts`). |

The local runtime will continue to work throughout the AWS work. Where this design changes a port, the local adapters are updated to the same semantics, so both runtimes share one contract and one test suite.

## 3. Domain model summary

The complete rules are in [domain-model.md](domain-model.md). The parts that shape the AWS design:

- **Claim:** owner, assigned manager, category, amount in integer minor units with a currency, expense date, merchant, business purpose, optional receipt, status, an optimistic `version`, and timestamps. Drafts may be incomplete; every rule is checked on submission.
- **Lifecycle:** `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → PAID`, and `UNDER_REVIEW → REJECTED → DRAFT` for resubmission. All other transitions are rejected.
- **History:** one immutable entry per accepted claim change, numbered by the claim version it produced.
- **Category:** administrator-managed currency, inclusive maximum amount, receipt threshold (a receipt is required strictly above it), and active state. Policy is evaluated when a claim is submitted or resubmitted.
- **Deletion:** an owner may delete a draft that was never submitted, together with its history. An administrator may delete a category only when no claim uses it; otherwise it is deactivated.
- **Receipts:** PDF, JPEG, or PNG; 1 byte to 10 MB; SHA-256 checksum; the real file type is checked from the file's leading bytes.

## 4. Target architecture overview

| Component        | AWS service                                                     | Purpose                                                                          |
| ---------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| API              | API Gateway HTTP API with a JWT authorizer, one Lambda function | Runs the existing routes through a shared request handler                        |
| Identity         | Cognito user pool                                               | Authenticates users; administrators create users (no self sign-up)               |
| Data             | One DynamoDB table, `ClaimFlow`, on-demand capacity             | Claims, history, categories, profiles, receipt metadata, idempotency, outbox     |
| Receipt files    | One private S3 bucket                                           | Pending uploads and final receipt copies                                         |
| Web hosting      | A separate private S3 bucket behind CloudFront                  | Serves the built React web application over HTTPS                                |
| Change stream    | DynamoDB Streams, `NEW_AND_OLD_IMAGES`                          | Feeds the outbox publisher and the receipt janitor                               |
| Outbox publisher | Lambda (stream trigger)                                         | Publishes new outbox events to EventBridge and marks them published              |
| Outbox sweeper   | Lambda (EventBridge schedule, every 15 minutes)                 | Republishes events still pending after the stream path failed or expired         |
| Receipt janitor  | Lambda (stream trigger)                                         | Deletes S3 objects for pending uploads that expired without being attached       |
| Event bus        | EventBridge custom bus `claimflow`                              | Routes published events to consumer queues                                       |
| Cleanup worker   | SQS queue with a dead-letter queue, Lambda consumer             | Deletes replaced or removed receipt objects and purges history of deleted drafts |

### Deployment boundary

- Infrastructure is defined with AWS CDK in TypeScript in the `infrastructure/` workspace, as one stack (`ClaimFlowStack`, stack ID `ClaimFlow`).
- Defined in the stack and deployed in `ap-southeast-1`: the `ClaimFlow` DynamoDB table (section 5), the `ClaimFlow` Cognito User Pool (section 17), and the receipt bucket (section 11) without CORS rules yet.
- Defined in the stack and deployed in `ap-southeast-1`: web hosting (the web assets bucket and the CloudFront distribution, described below). No built web application files are uploaded yet, so the application is not available through CloudFront.
- Defined in the stack and deployed in `ap-southeast-1`: the Cognito web app client `ClaimFlowWeb` and the classic hosted UI domain (section 17). The web application has no Cognito integration yet and still uses development sign-in locally.
- The application is not connected to this infrastructure yet: it still runs locally with development sign-in and local adapters, so receipt uploads do not reach the bucket.
- All other approved components remain future increments: the API and its Lambda function, the receipt bucket's CORS rules, the event bus, the publisher, sweeper, janitor, and cleanup functions, and their queues.
- Phase 0 produced this design only; infrastructure is added in separate, reviewed increments.
- Deployment is manual. It must never run automatically, including from CI, without explicit authorization.

### Web application hosting

The built React web application is hosted as static files in a private S3 bucket behind a CloudFront distribution (decision D15 in section 25):

- **Web assets bucket:** separate from the receipt bucket; all public access blocked, S3 managed encryption, a bucket policy that denies non-TLS requests, no S3 website hosting, and a `RETAIN` removal policy without automatic object deletion.
- **Origin access:** CloudFront reads the bucket through Origin Access Control (OAC), signing every request with SigV4. The bucket policy allows only `s3:GetObject`, only for the `cloudfront.amazonaws.com` service principal, and only for requests from this distribution. There is no origin access identity and no public object access.
- **Viewer access:** HTTP requests are redirected to HTTPS; only `GET` and `HEAD` are allowed, with the managed caching-optimized cache policy.
- **Client-side routes:** `index.html` is the default root object. Because CloudFront has no permission to list the bucket, S3 answers a missing key with `403` rather than `404`; both are answered with `/index.html` and status `200`, so that React `BrowserRouter` routes such as `/claims/<id>` load the application, which then resolves the route.
- **Domain:** the distribution's default `*.cloudfront.net` domain with CloudFront's default certificate. A custom domain is deferred (section 24).

The distribution's HTTPS origin is the web origin for the Cognito app client's callback and sign-out URLs (section 17) and for the receipt bucket's CORS rules, which are added when the application starts using the bucket.

Publishing the built web application to the bucket, and how the web application reaches the HTTP API from the CloudFront origin, are decided in later increments. Locally, the web application still runs from the Vite development server or as built files served by the local API.

## 5. DynamoDB table, keys, and indexes

### Table

- Name: `ClaimFlow`. Keys: `PK` (string) and `SK` (string).
- Capacity: on-demand.
- Point-in-time recovery and deletion protection enabled.
- Stream: `NEW_AND_OLD_IMAGES`. The publisher reads the new image of inserted outbox items; the receipt janitor reads the old image of TTL deletions, which have no new image.
- TTL attribute: `expiresAt` (Unix epoch seconds).

A single table keeps every claim change (claim, history, category counter, receipt metadata, outbox, idempotency result) in one transaction and one set of permissions, backups, and alarms.

### Item keys

| Item                   | PK                              | SK                              | Notes                                                                |
| ---------------------- | ------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| Claim                  | `CLAIM#<claimId>`               | `CLAIM`                         | Get by ID is one `GetItem`                                           |
| History entry          | `CLAIM#<claimId>`               | `HISTORY#<version>`             | Version zero-padded to 10 digits so text order matches numeric order |
| Claim outbox event     | `CLAIM#<claimId>`               | `OUTBOX#<occurredAt>#<eventId>` | Publishable claim events and both `internal.*` cleanup events        |
| Category               | `CATEGORIES`                    | `CATEGORY#<categoryId>`         | All categories form one small, bounded partition                     |
| Category outbox event  | `CATEGORIES`                    | `OUTBOX#<occurredAt>#<eventId>` | Written in the same transaction as the category change               |
| User profile           | `USER#<cognitoSub>`             | `PROFILE`                       | Roles and manager assignment                                         |
| Receipt metadata       | `RECEIPT#<receiptId>`           | `RECEIPT`                       | Exists before any claim refers to it                                 |
| Idempotency record     | `IDEMPOTENCY#<actorId>#<key>`   | `IDEMPOTENCY`                   | Scoped per user                                                      |
| Consumer dedupe record | `CONSUMED#<consumer>#<eventId>` | `CONSUMED`                      | Written by event consumers                                           |

`eventId` comes from the existing `IdGenerator` (a random UUID). The `<occurredAt>` prefix in outbox sort keys gives chronological key order inside a partition.

Every outbox item is written in the same transaction as the mutation it describes. The cleanup events `internal.receipt-object-deletion-requested` and `internal.claim-history-purge-requested` are always claim outbox items: `PK = CLAIM#<claimId>`, `SK = OUTBOX#<occurredAt>#<eventId>`. No outbox items are written to receipt partitions.

History reads use `SK begins_with HISTORY#` and category reads use `SK begins_with CATEGORY#`, so outbox items in the same partitions never appear in those results.

### Global secondary indexes

Only claim items and pending outbox items carry GSI attributes. History, category, profile, receipt, idempotency, and consumer dedupe items never appear in an index. All indexes project all attributes, so list pages need no second read.

| Index | Partition key value        | Sort key value            | Items                                        | Serves                                       |
| ----- | -------------------------- | ------------------------- | -------------------------------------------- | -------------------------------------------- |
| GSI1  | `EMPLOYEE#<employeeId>`    | `<updatedAt>#<claimId>`   | Every claim                                  | An employee's claims, newest first           |
| GSI2  | `MANAGER#<managerId>#OPEN` | `<submittedAt>#<claimId>` | Claims in `SUBMITTED` or `UNDER_REVIEW` only | A manager's review queue, oldest first       |
| GSI3  | `STATUS#<status>`          | `<updatedAt>#<claimId>`   | Every claim                                  | Claims in one status, newest first           |
| GSI4  | `CLAIM`                    | `<updatedAt>#<claimId>`   | Every claim                                  | All claims, newest first                     |
| GSI4  | `OUTBOX#PENDING`           | `<occurredAt>#<eventId>`  | Unpublished outbox items only                | Recovery of unpublished events, oldest first |

- **GSI2 is sparse.** The adapter sets `GSI2PK`/`GSI2SK` only while a claim is `SUBMITTED` or `UNDER_REVIEW` and removes them for every other status, so decided claims leave the queue automatically.
- **GSI3 follows status.** Changing `GSI3PK` moves the claim between status partitions; DynamoDB maintains the index.
- **GSI4 holds two item types** under different partition values. Each query names exactly one partition, so claims and outbox items never mix.
- **Sort keys end in the item ID,** so items with the same timestamp still have a stable, unique order.
- **Hot partitions.** `GSI4PK = CLAIM` and `GSI4PK = OUTBOX#PENDING` each concentrate writes in one index partition, which supports roughly 1,000 writes per second. This is far above the expected volume; outbox items leave the pending partition as soon as they are published.

Whether a category is in use is answered by a `claimCount` attribute on the category item, not by an index (see section 9).

## 6. Access patterns

"Strong" means a strongly consistent read, used wherever a write decision depends on the result. GSI queries are always eventually consistent.

### Claims and history

| #   | Access pattern                                                   | Operation                                                 | Consistency |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------- | ----------- |
| A1  | Get a claim by ID                                                | `GetItem PK=CLAIM#<id>, SK=CLAIM`                         | Strong      |
| A2  | Create a claim with its first history entry                      | Transaction (section 8)                                   | —           |
| A3  | Update a claim at an expected version and append a history entry | Transaction (section 8)                                   | —           |
| A4  | Delete a never-submitted draft                                   | Transaction plus history purge (section 12)               | —           |
| A5  | Is a category used by any claim?                                 | `GetItem` on the category, read `claimCount`              | Strong      |
| A6  | An employee's claims, newest activity first                      | `Query GSI1 GSI1PK=EMPLOYEE#<id>`, descending             | Eventual    |
| A7  | A manager's open review queue, oldest submission first           | `Query GSI2 GSI2PK=MANAGER#<id>#OPEN`, ascending          | Eventual    |
| A8  | Claims in one status, newest activity first                      | `Query GSI3 GSI3PK=STATUS#<status>`, descending           | Eventual    |
| A9  | All claims, newest activity first                                | `Query GSI4 GSI4PK=CLAIM`, descending                     | Eventual    |
| A10 | A claim's history in version order                               | `Query PK=CLAIM#<id>, SK begins_with HISTORY#`, ascending | Strong      |

### Categories and users

| #   | Access pattern                                         | Operation                                                            | Consistency |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------- | ----------- |
| C1  | Get a category                                         | `GetItem PK=CATEGORIES, SK=CATEGORY#<id>`                            | Strong      |
| C2  | List all categories                                    | `Query PK=CATEGORIES, SK begins_with CATEGORY#`                      | Strong      |
| C3  | Create a category                                      | Transaction with outbox and idempotency                              | —           |
| C4  | Update a category at an expected version               | Transaction with outbox and idempotency                              | —           |
| C5  | Delete an unused category at an expected version       | Transaction with outbox and idempotency                              | —           |
| U1  | Get a user's profile (roles, manager) on every request | `GetItem PK=USER#<sub>, SK=PROFILE`                                  | Strong      |
| U2  | Display names for the users shown in a response        | `BatchGetItem` of only the needed profiles (up to 100 keys per call) | Eventual    |

### Receipts

| #   | Access pattern                                         | Operation                                                                    |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| R1  | Create pending receipt metadata                        | Transaction: Put metadata plus idempotency                                   |
| R2  | Get receipt metadata                                   | `GetItem PK=RECEIPT#<id>, SK=RECEIPT`, strong                                |
| R3  | Inspect an uploaded object                             | S3 `HeadObject` with checksum mode, ranged `GetObject` of the first 16 bytes |
| R4  | Copy a verified upload to its final key                | S3 `CopyObject`                                                              |
| R5  | Attach, replace, or remove a receipt                   | Part of the claim transaction (section 8)                                    |
| R6  | Download a receipt                                     | S3 presigned `GET` URL                                                       |
| R7  | Detect pending uploads that expired without attachment | Stream `REMOVE` records created by TTL (section 11)                          |

### Idempotency, outbox, and cleanup

| #   | Access pattern                            | Operation                                                                     |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| I1  | Look up a stored result                   | `GetItem PK=IDEMPOTENCY#<actor>#<key>`, strong                                |
| I2  | Store a completed result                  | Put inside the business transaction                                           |
| I3  | Store a rejected result                   | Standalone conditional Put                                                    |
| E1  | Write outbox events                       | Put inside the business transaction                                           |
| E2  | Read newly inserted outbox items          | DynamoDB Streams `INSERT` records with `SK` beginning `OUTBOX#`               |
| O1  | Find unpublished outbox events            | `Query GSI4 GSI4PK=OUTBOX#PENDING, GSI4SK < <now − 5 minutes>`, ascending     |
| O2  | Mark an outbox event published            | Conditional `UpdateItem` (section 15)                                         |
| X1  | Purge a deleted draft's history           | `Query PK=CLAIM#<id>, SK begins_with HISTORY#`, then `BatchWriteItem` deletes |
| K1  | Record that a consumer processed an event | Conditional Put of `CONSUMED#<consumer>#<eventId>`                            |

No access pattern uses a table scan or a filter expression.

## 7. Example items

All values are fictional. Money is stored in integer minor units.

### Claim

```json
{
  "PK": "CLAIM#4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
  "SK": "CLAIM",
  "entityType": "Claim",
  "claimId": "4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
  "employeeId": "sub-aisha",
  "assignedManagerId": "sub-ben",
  "categoryId": "travel",
  "amount": { "amountMinor": 45000, "currency": "MYR" },
  "expenseDate": "2026-10-08",
  "merchant": "Regional Airline",
  "businessPurpose": "Client workshop",
  "receipt": {
    "receiptId": "r-7731",
    "fileName": "flight.pdf",
    "contentType": "application/pdf",
    "sizeBytes": 52144,
    "checksumSha256": "9f2c…",
    "attachedAt": "2026-10-14T10:40:00.000Z"
  },
  "status": "SUBMITTED",
  "version": 4,
  "lastEventVersion": 4,
  "createdAt": "2026-10-14T10:30:00.000Z",
  "updatedAt": "2026-10-14T10:41:00.000Z",
  "submittedAt": "2026-10-14T10:41:00.000Z",
  "GSI1PK": "EMPLOYEE#sub-aisha",
  "GSI1SK": "2026-10-14T10:41:00.000Z#4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
  "GSI2PK": "MANAGER#sub-ben#OPEN",
  "GSI2SK": "2026-10-14T10:41:00.000Z#4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
  "GSI3PK": "STATUS#SUBMITTED",
  "GSI3SK": "2026-10-14T10:41:00.000Z#4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
  "GSI4PK": "CLAIM",
  "GSI4SK": "2026-10-14T10:41:00.000Z#4ce0c74b-9c64-46d6-87ba-07fb71b0628c"
}
```

`lastEventVersion` is the claim version of the most recent publishable event for this claim (section 15).

### History entry

```json
{
  "PK": "CLAIM#4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
  "SK": "HISTORY#0000000004",
  "entityType": "ClaimHistory",
  "claimId": "4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
  "version": 4,
  "action": "SUBMIT",
  "fromStatus": "DRAFT",
  "toStatus": "SUBMITTED",
  "actorId": "sub-aisha",
  "occurredAt": "2026-10-14T10:41:00.000Z"
}
```

### Category

```json
{
  "PK": "CATEGORIES",
  "SK": "CATEGORY#travel",
  "entityType": "Category",
  "categoryId": "travel",
  "name": "Travel",
  "active": true,
  "currency": "MYR",
  "maxAmountMinor": 200000,
  "receiptRequiredAboveMinor": 20000,
  "version": 3,
  "lastEventVersion": 3,
  "claimCount": 17,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-09-30T08:00:00.000Z",
  "updatedBy": "sub-dan"
}
```

`version` changes only when an administrator changes the category. `claimCount` changes when claims start or stop using the category and never changes `version`.

### Item codecs

`services/api/src/adapters/aws/dynamodb-items.ts` converts claims, history entries, and categories to and from these items without sending any commands. Persistence-only attributes stay out of the domain values: decoding returns the claim with its optional `lastEventVersion`, and the category with its `claimCount` and optional `lastEventVersion`. Encoding omits absent optional attributes and derives every key and index attribute as specified in section 5; it refuses a claim that cannot be indexed correctly, such as a `SUBMITTED` or `UNDER_REVIEW` claim without an assigned manager or submission time, and a history version outside 1 to 9,999,999,999. Decoding validates every attribute, the keys against the IDs, the exact index values, the presence of GSI2 only for open claims, and the absence of index attributes on history and category items. It rejects any other attribute. Malformed items raise `ItemIntegrityError`, which names the item key only when it has a well-formed ClaimFlow key shape (otherwise a generic identifier) and the kind of problem, never a stored value. Receipt file names must already be in the domain's sanitized form and category names already trimmed. Free text such as merchants, purposes, file names, and comments never appears in a key or index attribute.

Idempotency records and outbox events have their own pure codecs, which share the same validation and safe error messages:

- **Idempotency records** (`dynamodb-idempotency-items.ts`): a `COMPLETED` result has a 2xx status and a `REJECTED` result a 4xx status. A `204` response has no `body` attribute; every other response has a JSON-compatible body that DynamoDB can store, nested at most 30 levels deep and at most 300 KB of UTF-8 canonical JSON; its shape is checked with bounded work before it is serialized. The actor ID and idempotency key come from the key and are validated with the API's ID and `Idempotency-Key` rules. The fingerprint is lower-case SHA-256 hex, and `expiresAt` is whole epoch seconds exactly 24 hours after `createdAt` (`idempotencyRetentionMs`).
- **Outbox events** (`dynamodb-outbox-items.ts`): the application envelope is kept separate from the persistence state. A `PENDING` event has `GSI4PK = OUTBOX#PENDING` and `GSI4SK = <occurredAt>#<eventId>`, with no `publishedAt` or `expiresAt`. A `PUBLISHED` event has no index attributes, a `publishedAt` no earlier than `occurredAt`, and `expiresAt` exactly 7 days later. Claim and cleanup events use `PK = CLAIM#<claimId>` and category events `PK = CATEGORIES`. Decoding checks every event type's exact payload fields, so no free text can be stored. Payload identities must match the aggregate, `previousEventVersion` must be `null` or below the aggregate version and `null` for internal events, correlation and causation IDs follow the `X-Correlation-Id` rule, and the cleanup `objectKey` must be `receipts/<receiptId>`.

### User profile

```json
{
  "PK": "USER#sub-aisha",
  "SK": "PROFILE",
  "entityType": "UserProfile",
  "userId": "sub-aisha",
  "displayName": "Aisha Rahman",
  "title": "Sales executive",
  "roles": ["EMPLOYEE"],
  "managerId": "sub-ben"
}
```

### Receipt metadata

Pending, before attachment:

```json
{
  "PK": "RECEIPT#r-7731",
  "SK": "RECEIPT",
  "entityType": "Receipt",
  "receiptId": "r-7731",
  "ownerId": "sub-aisha",
  "state": "PENDING",
  "fileName": "flight.pdf",
  "declaredContentType": "application/pdf",
  "declaredSizeBytes": 52144,
  "declaredChecksumSha256": "9f2c…",
  "objectKey": "uploads/pending/r-7731",
  "uploadedAt": "2026-10-14T10:35:00.000Z",
  "expiresAt": 1792062900
}
```

After attachment, the same item has `state: ATTACHED`, `attachedClaimId`, `objectKey: receipts/r-7731`, the measured `contentType`, `sizeBytes`, and `checksumSha256`, and no `expiresAt`. A replaced or removed receipt has `state: REPLACED` or `REMOVED` and an `expiresAt` 30 days later.

### Idempotency record

```json
{
  "PK": "IDEMPOTENCY#sub-aisha#5b0d6a8e-retry-key",
  "SK": "IDEMPOTENCY",
  "entityType": "IdempotencyRecord",
  "fingerprint": "sha256-of-method-path-and-body",
  "outcome": "COMPLETED",
  "response": {
    "status": 200,
    "body": { "claimId": "4ce0c74b-…", "version": 4 }
  },
  "createdAt": "2026-10-14T10:41:00.000Z",
  "expiresAt": 1792060860
}
```

The stored `body` is the full response snapshot (shortened here). A rejected request stores `"outcome": "REJECTED"` with the error response. A receipt-upload record stores a reference instead of a URL (section 10).

### Outbox event

```json
{
  "PK": "CLAIM#4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
  "SK": "OUTBOX#2026-10-14T10:41:00.000Z#8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f",
  "entityType": "OutboxEvent",
  "eventId": "8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f",
  "eventType": "claim.submitted",
  "schemaVersion": 1,
  "occurredAt": "2026-10-14T10:41:00.000Z",
  "source": "claimflow.api",
  "aggregate": {
    "type": "claim",
    "id": "4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
    "version": 4,
    "previousEventVersion": null
  },
  "correlationId": "c0ffee00-1111-2222-3333-444455556666",
  "causationId": "request-7d3e",
  "actorId": "sub-aisha",
  "payload": {
    "claimId": "4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
    "employeeId": "sub-aisha",
    "assignedManagerId": "sub-ben",
    "categoryId": "travel",
    "amount": { "amountMinor": 45000, "currency": "MYR" },
    "submittedAt": "2026-10-14T10:41:00.000Z"
  },
  "state": "PENDING",
  "GSI4PK": "OUTBOX#PENDING",
  "GSI4SK": "2026-10-14T10:41:00.000Z#8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f"
}
```

After publication: `state: PUBLISHED`, `publishedAt`, `expiresAt` 7 days after `publishedAt`, and no `GSI4PK`/`GSI4SK`.

### Cleanup outbox event

Written when a receipt is replaced at claim version 6:

```json
{
  "PK": "CLAIM#4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
  "SK": "OUTBOX#2026-10-14T11:05:00.000Z#1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c",
  "entityType": "OutboxEvent",
  "eventId": "1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c",
  "eventType": "internal.receipt-object-deletion-requested",
  "schemaVersion": 1,
  "occurredAt": "2026-10-14T11:05:00.000Z",
  "source": "claimflow.api",
  "aggregate": {
    "type": "claim",
    "id": "4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
    "version": 6,
    "previousEventVersion": null
  },
  "correlationId": "c0ffee00-1111-2222-3333-444455556667",
  "causationId": "request-8a41",
  "actorId": "sub-aisha",
  "payload": {
    "claimId": "4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
    "receiptId": "r-7731",
    "objectKey": "receipts/r-7731"
  },
  "state": "PENDING",
  "GSI4PK": "OUTBOX#PENDING",
  "GSI4SK": "2026-10-14T11:05:00.000Z#1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c"
}
```

## 8. Transactional write model

Every accepted mutation is one DynamoDB `TransactWriteItems` call. A transaction allows up to 100 operations and 4 MB, and may not touch the same item twice. Each transaction contains:

1. the business writes (claim, category, receipt metadata) with their conditions;
2. the immutable history entry, for claim changes;
3. outbox events, if the change is publishable or needs asynchronous cleanup;
4. the completed idempotency record: fingerprint plus the final response.

There is no state in which a change exists without its history, its events, or its stored result.

| Operation                                  | Operations in the transaction                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create claim                               | Put claim; Put history v1; category `claimCount +1` with guard (only if a category is set); Put idempotency                                                                                                                                                                                                                |
| Edit draft                                 | Update claim; Put history; old category `claimCount −1` and new category `claimCount +1` with guard (only if the category changed); Put idempotency                                                                                                                                                                        |
| Submit or resubmit                         | Update claim; Put history; category `ConditionCheck`; Put outbox `claim.submitted`; Put idempotency                                                                                                                                                                                                                        |
| Start review, approve, reject, reopen, pay | Update claim; Put history; Put outbox event; Put idempotency                                                                                                                                                                                                                                                               |
| Attach or replace receipt                  | Update claim; Put history; Update new receipt metadata; when replacing, Update old receipt metadata and Put outbox `internal.receipt-object-deletion-requested`; Put idempotency                                                                                                                                           |
| Remove receipt                             | Update claim; Put history; Update receipt metadata; Put outbox `internal.receipt-object-deletion-requested`; Put idempotency                                                                                                                                                                                               |
| Delete draft                               | Delete claim; category `claimCount −1` (if the draft has a category); Update receipt metadata to `REMOVED` (if the draft has a receipt); Put outbox `internal.claim-history-purge-requested`; Put outbox `internal.receipt-object-deletion-requested` (if the draft has a receipt); Put idempotency. At most 6 operations. |
| Create receipt upload                      | Put pending receipt metadata; Put idempotency                                                                                                                                                                                                                                                                              |
| Create, update, or delete category         | Put, Update, or Delete category; Put outbox `category.*`; Put idempotency                                                                                                                                                                                                                                                  |

Writes that carry a publishable event also set `lastEventVersion` on the claim or category in the same update.

### Transaction request tokens

Every `TransactWriteItems` request carries a `ClientRequestToken` of at most 36 characters.

The token is derived from the transaction payload itself:

1. Build the complete `TransactItems` payload first, without `ClientRequestToken`.
2. Serialize it canonically, with object keys in a stable order, so the same payload always produces the same bytes.
3. Compute the SHA-256 of that canonical payload.
4. The token is the first 32 hexadecimal characters of the SHA-256 over the actor ID, the application idempotency key, the request fingerprint, and the payload hash. Consumer transactions use the consumer name and `eventId` in place of the actor ID and the idempotency key.

Rules:

- **Same payload, same token.** An identical transaction payload always produces the same token. This holds whether the SDK retries the request automatically, the ambiguous-failure procedure retries it (section 10), or a fresh service invocation rebuilds an identical payload. No in-memory counter is needed, so determinism does not depend on state surviving a later client request or Lambda invocation.
- **Changed payload, new token.** Any rebuilt payload that differs in any transaction value, such as a different category version, timestamp, generated event ID, claim ID, or other value, produces a different token automatically.
- **One token, one payload.** Because the token is derived from the payload, a token is never paired with a different payload. If DynamoDB ever reports `IdempotentParameterMismatchException`, it is treated as a programming error.
- **Canonical form.** Object keys are sorted at every level and array order is kept. Only JSON values are accepted: `undefined`, functions, symbols, big integers, non-finite numbers, sparse arrays, cycles, and objects other than plain objects and arrays are rejected, so no payload can produce an unstable token. The four hashed values are encoded as a JSON array, so they cannot run into each other.
- **Implementation.** `transactionRequestToken` and `canonicalJson` in `services/api/src/adapters/aws/transaction-token.ts` are pure functions with no AWS client, time, or randomness.
- **Two layers of idempotency.** DynamoDB honors a request token only for a short window and only at the transport level, so a resent identical request is not applied twice. Differently constructed transactions for the same application idempotency key carry different tokens, so DynamoDB does not deduplicate them; the conditional `Put` of the idempotency record in the table is what prevents two of them from both committing. That record remains the durable application result for 24 hours and is what client retries are answered from.

## 9. Conditional writes and category guards

### Conditions

| Write                                                    | Condition                                                                                            | Protects                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Create claim                                             | `attribute_not_exists(PK)`                                                                           | Never overwrite an existing claim                                                                                   |
| Update claim                                             | `#version = :expectedVersion`                                                                        | Optimistic concurrency; any change bumps the version                                                                |
| Owner operations (edit, receipt, submit, reopen, delete) | Also `employeeId = :actorId`                                                                         | The write itself refuses a non-owner                                                                                |
| Manager operations (start review, approve, reject)       | Also `assignedManagerId = :actorId`                                                                  | The write itself refuses anyone but the assigned manager                                                            |
| Delete draft                                             | `#version = :v AND employeeId = :actorId AND #status = :draft AND attribute_not_exists(submittedAt)` | Never-submitted rule enforced at write time                                                                         |
| Put history entry, Put outbox event                      | `attribute_not_exists(PK)`                                                                           | Written once; a duplicate fails the whole transaction                                                               |
| Update category                                          | `#version = :v`                                                                                      | Administrator edit conflicts                                                                                        |
| Delete category                                          | `#version = :v AND (attribute_not_exists(claimCount) OR claimCount = :zero)`                         | A category in use cannot be deleted, with no race                                                                   |
| Decrement category `claimCount`                          | `attribute_exists(PK) AND claimCount >= :one`                                                        | The category exists and the counter can never underflow                                                             |
| Put idempotency (success)                                | `attribute_not_exists(PK) OR expiresAt < :nowEpoch`                                                  | One result per key; expired leftovers count as absent                                                               |
| Update receipt metadata on attach                        | `ownerId = :actorId AND #state = :pending`                                                           | Only a pending receipt owned by the actor can be attached; `ATTACHED`, `REPLACED`, and `REMOVED` receipts never can |

When a transaction is cancelled, the adapter does not try to determine which condition failed. It reports the cancellation, and the service runs the deterministic recovery procedure in section 10, which rereads the affected items and maps the result to the existing errors (`VERSION_CONFLICT`, `CATEGORY_IN_USE`, `RECEIPT_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`). Services and the HTTP layer keep their current error contract.

### Category guards

A claim write that depends on category policy must fail if the category changed after the domain read it. Every administrator change, including deactivation and changes to limits or thresholds, increments the category `version`.

| Claim operation                                                       | Policy read by the domain?                        | Guard                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Create with a category, or change a draft's category (new category)   | Yes: must exist and be active                     | On the counter update: `ADD claimCount :one` with `#version = :readVersion AND active = :true` |
| Change a draft's category (old category)                              | No                                                | `ADD claimCount :minusOne` with `attribute_exists(PK) AND claimCount >= :one`                  |
| Submit or resubmit                                                    | Yes: active, currency, maximum, receipt threshold | `ConditionCheck` on the category with `#version = :readVersion AND active = :true`             |
| Edit other fields, receipt changes, review actions, reopen, mark paid | No (policy is evaluated at submission)            | None                                                                                           |
| Delete draft (if the draft has a category)                            | No                                                | `ADD claimCount :minusOne` with `attribute_exists(PK) AND claimCount >= :one`                  |

**ConditionCheck or counter condition.** A transaction may not operate on the same item twice. When the transaction already updates a category's `claimCount`, the guard is placed on that update. When it does not (submission), a separate `ConditionCheck` on the category item is used.

**Counter decrements** always require `attribute_exists(PK) AND claimCount >= :one`. `ADD` on a missing item would otherwise create it, and a decrement below zero would hide a bookkeeping error.

**When recovery finds that the category changed** (section 10), the service runs the category decision once more with the reread category, within the same request and idempotency key; nothing was committed. A deactivated category or a lowered limit then produces the normal `400 VALIDATION_FAILED`. If the category changes again before the second commit, the request returns `409 VERSION_CONFLICT`.

## 10. Idempotency

### Request flow

1. **Look up** the key with a strongly consistent `GetItem` on `IDEMPOTENCY#<actorId>#<key>`.
   - Found with the same fingerprint: replay the stored response. No business logic runs.
   - Found with a different fingerprint: `409 IDEMPOTENCY_CONFLICT`.
   - Not found, or found with `expiresAt` in the past: continue.
2. **Execute** the domain logic and build the change and the response. The response depends only on the new state and display names, both known before the write. The success status (`201`, `200`, or `204`) is fixed per route and is supplied with the key.
3. **Commit** one transaction containing the business writes and `Put IDEMPOTENCY` (section 9 condition).
4. **If the transaction is cancelled,** follow the recovery procedure below.
5. **On a business rejection** (a validation or domain error before the commit, or a conflict established by recovery), store the error response with a standalone `Put` conditioned on `attribute_not_exists(PK) OR expiresAt < :nowEpoch`. A retry with the same key then receives the same answer. If that conditional Put fails because a record already exists, strongly reread the idempotency record:
   - same fingerprint: replay the stored response, whether it is a success or an earlier rejection;
   - different fingerprint: `409 IDEMPOTENCY_CONFLICT`.

There is no in-progress state, so there is nothing to release after a failure.

### Recovery after a cancelled transaction

A cancelled transaction is identified only by its SDK error type, `TransactionCanceledException`. Recovery does not use per-item cancellation reasons and never parses exception message text. Instead it rereads state, which is deterministic and does not depend on how the SDK exposes the cause.

1. **Reread the idempotency record** with a strongly consistent `GetItem`.
   - It exists with the same fingerprint: a concurrent request with the same key committed first. Replay its stored response.
   - It exists with a different fingerprint: `409 IDEMPOTENCY_CONFLICT`.
2. **If no record exists, reread every item the transaction conditioned on**, strongly consistent, and compare with the values the request used:

   | Reread finding                                                                                                                                 | Outcome                                                              |
   | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
   | The claim no longer exists or is no longer visible to the actor                                                                                | `404 NOT_FOUND`                                                      |
   | The claim `version` differs from the expected version (this covers any change of status, ownership, or assignment, which always increments it) | `409 VERSION_CONFLICT`                                               |
   | A guarded category's `version` changed or it is no longer active                                                                               | Run the category decision once more (section 9)                      |
   | An administrator update or deletion finds a different category `version`                                                                       | `409 VERSION_CONFLICT`                                               |
   | A category being deleted now has `claimCount >= 1`                                                                                             | `409 CATEGORY_IN_USE`                                                |
   | The receipt metadata is no longer `PENDING` or no longer owned by the actor                                                                    | `400 VALIDATION_FAILED` with `RECEIPT_UNAVAILABLE`                   |
   | A category to be decremented is missing or has `claimCount < 1`                                                                                | Data integrity error: generic `500`, logged and alarmed, not retried |
   | None of the above: every reread value matches what the request used                                                                            | Unclassified cancellation with unchanged state: retry (below)        |

3. **Unclassified cancellation with unchanged state.** Per-item cancellation reasons are not inspected, so unchanged reread state does not prove what caused the cancellation. It may have been a conflicting concurrent transaction, a capacity limit, or a transaction validation failure reported as a cancellation. The cause is therefore never reported as a known transaction conflict or as a version conflict.
   - A cancelled transaction made no changes, so a bounded retry is safe. The whole operation is retried with exponential backoff and jitter, up to 3 attempts: reread, run the domain logic, rebuild the payload, and derive its token (section 8). If the rebuilt payload is identical, it carries the same token; if any value changed, it carries a different token automatically.
   - Each unclassified cancellation is logged with the operation and the retry count.
   - If every attempt ends in an unclassified cancellation, the request returns the generic `500` response and an alarm metric is emitted. A later client retry with the same idempotency key is safe because no attempt committed.

The reread state is authoritative. If another request changed an item between the cancellation and the reread, the request is evaluated against the latest state, exactly as if it had arrived later.

### Other DynamoDB errors

Errors are distinguished by their SDK error type, never by message text. Only `TransactionCanceledException` enters the cancellation recovery procedure; no other error is treated as a business conflict.

| Error                                                                                                                    | Handling                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValidationException`, `IdempotentParameterMismatchException`                                                            | A programming error (for example, a malformed request, the same item twice in a transaction, or a reused token); generic `500`, logged and alarmed, not retried |
| Throttling and capacity errors (`ThrottlingException`, `ProvisionedThroughputExceededException`, `RequestLimitExceeded`) | Retried by the SDK's standard retry strategy with the same request token; if still failing, handled as an ambiguous failure (below)                             |
| `InternalServerError`, service-unavailable responses, timeouts, and connection failures                                  | Ambiguous failure (below)                                                                                                                                       |

### Ambiguous failures

An internal error, a service-unavailable response, a timeout, or a lost connection does not prove whether the transaction committed. The outcome is established instead of assumed:

1. **Strongly reread the idempotency record.**
   - It exists with the same fingerprint: the transaction committed (or a concurrent request with the same key did). Replay the stored response.
   - It exists with a different fingerprint: `409 IDEMPOTENCY_CONFLICT`.
2. **If no record exists, retry the identical transaction with the same `ClientRequestToken`,** bounded by the normal retry policy. If the earlier attempt had in fact committed, DynamoDB recognizes the token and does not apply the change a second time. A cancellation on retry enters the cancellation recovery procedure.
3. **If the outcome still cannot be established,** return the generic `500` response. A later client retry with the same application idempotency key either replays the committed result from the idempotency record or executes the request, because the record is the durable source of truth.

### Crash behavior

| Failure point                               | What a retry sees       | Effect                                 |
| ------------------------------------------- | ----------------------- | -------------------------------------- |
| Before the commit                           | No record               | Executes once                          |
| After the commit, before the client sees it | Completed record        | Original response replayed; no rewrite |
| Two identical requests at the same time     | One transaction commits | The other replays the winner's result  |

### Create retries

A completed record stores the full response snapshot, including the original `claimId`. A retried create returns exactly the original response, even if the claim has changed since. A claim response is a few kilobytes, far below the 400 KB item limit.

### Reconstructed results

A stored response is replaced by a reference only when part of it expires. `POST /receipts` returns a presigned upload form (a URL and form fields) valid for 15 minutes. Its record stores `{ "status": 201, "resultRef": { "receiptId": "…" } }`. A replay re-reads the receipt metadata and, while it is still `PENDING`, issues a new upload form for the same receipt with the same conditions. The same receipt is returned, so no duplicate is created.

## 11. Receipt lifecycle

S3 operations and DynamoDB writes cannot be one atomic transaction. Correctness comes from three rules: DynamoDB is the source of truth, every S3 step can be repeated safely, and every possible orphan has a defined cleanup.

### Bucket layout

| Prefix                        | Contents               | Lifecycle                                |
| ----------------------------- | ---------------------- | ---------------------------------------- |
| `uploads/pending/<receiptId>` | Uploaded, not attached | Expires after 1 day (S3 lifecycle rule)  |
| `receipts/<receiptId>`        | Attached receipts      | Kept until deleted by the cleanup worker |

### Upload contract: presigned POST policy

Uploads use a presigned S3 POST policy, not a presigned `PUT` URL. Binding the exact declared `Content-Length` into a presigned `PUT` signature depends on signer and browser behavior that this design does not rely on. A POST policy enforces the size with the documented `content-length-range` condition, and browsers submit it as an ordinary `multipart/form-data` upload.

The policy is valid for 15 minutes and contains these conditions:

| Condition                                       | Effect                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `{ "bucket": "<receipt bucket>" }`              | Only the receipt bucket                                           |
| `["eq", "$key", "uploads/pending/<id>"]`        | Only this receipt's pending key                                   |
| `["eq", "$Content-Type", "<declared type>"]`    | Only the declared content type                                    |
| `["content-length-range", <size>, <size>]`      | Exactly the declared size in bytes; any other length is rejected  |
| `["eq", "$x-amz-checksum-algorithm", "SHA256"]` | SHA-256 checksum required                                         |
| `["eq", "$x-amz-checksum-sha256", "<base64>"]`  | Only the declared checksum; S3 rejects a body that does not match |

Independently of the upload conditions, the server verifies size, content type, SHA-256 checksum, and the real file type before attachment (step 4). An object is attached only after that verification passes.

### Upload

1. `POST /receipts` with `{ fileName, contentType, sizeBytes, checksumSha256 }` and an idempotency key.
   - The server validates type and size.
   - Transaction: Put receipt metadata (`state = PENDING`, declared values, `objectKey = uploads/pending/<id>`, `expiresAt` 24 hours later) and Put idempotency.
   - The response contains the receipt ID and the upload form: the S3 POST URL and the signed form fields, including the policy and its conditions.
2. The browser submits a `multipart/form-data` `POST` to S3 with the signed fields followed by the file. S3 rejects the upload if any condition fails.

### Attach or replace

3. Load the claim and the receipt metadata with strongly consistent reads. The metadata must belong to the caller and be `PENDING`; a receipt that is `ATTACHED`, `REPLACED`, or `REMOVED` returns `RECEIPT_UNAVAILABLE` and can never be attached by a new transaction. Check the expected claim version. A retry of an attachment that already committed never reaches this step: it is replayed from the completed idempotency record (section 10).
4. Verify the object:
   - `HeadObject` with checksum mode enabled: size, content type, and the stored SHA-256 checksum must equal the metadata; an object without a stored SHA-256 checksum is rejected;
   - ranged `GetObject` of bytes 0–15: the real file type must be PDF, JPEG, or PNG and match the declared type;
   - a missing object returns `RECEIPT_UNAVAILABLE`.
5. Run the domain `attachReceipt` rule against the measured values.
6. `CopyObject` from `uploads/pending/<id>` to `receipts/<id>`, preserving the SHA-256 checksum. The destination key is fixed, so if an earlier attempt copied the object but did not commit, the copy overwrites the same object.
7. Commit one transaction (section 8):
   - claim update and history entry;
   - receipt metadata to `ATTACHED`, with `objectKey = receipts/<id>`, the measured values, `attachedClaimId`, and `expiresAt` removed;
   - when replacing, the old receipt metadata to `REPLACED` with a 30-day `expiresAt`, and outbox `internal.receipt-object-deletion-requested` for the old object;
   - idempotency.
8. After the commit, delete `uploads/pending/<id>` as a best effort. If that fails, the lifecycle rule removes it within a day.

### Remove

One transaction updates the claim, writes history, sets the receipt metadata to `REMOVED` with a 30-day `expiresAt`, writes outbox `internal.receipt-object-deletion-requested`, and stores the idempotency result. The cleanup worker deletes the object.

### Download

`GET /claims/{claimId}/receipt` returns `{ "url": "…", "expiresAt": "…" }`, a presigned `GET` URL valid for 5 minutes with a `Content-Disposition` override. A redirect is not used because a browser following a plain link does not send the bearer token.

### Failure handling

| Failure                                                             | Result                                                       | Cleanup                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| The browser never uploads                                           | Metadata stays `PENDING`                                     | TTL deletes the metadata                                                                                                               |
| S3 rejects the upload (size, type, or checksum condition)           | Nothing stored; metadata stays `PENDING`                     | TTL deletes the metadata                                                                                                               |
| Verification fails                                                  | Nothing committed                                            | The lifecycle rule deletes the pending object                                                                                          |
| Copy succeeded, then the transaction failed or the function crashed | Orphaned final object `receipts/<id>`; metadata `PENDING`    | When TTL deletes the pending metadata, the receipt janitor deletes `receipts/<id>` and `uploads/pending/<id>`                          |
| Retry after a copy whose transaction did not commit                 | Metadata still `PENDING`; the copy repeats onto the same key | None needed                                                                                                                            |
| Pending object not deleted after commit                             | Leftover pending object                                      | The lifecycle rule                                                                                                                     |
| Receipt replaced, removed, or its draft deleted                     | The old final object must be deleted                         | Outbox `internal.receipt-object-deletion-requested` → cleanup queue → cleanup worker `DeleteObject`, retried, with a dead-letter queue |

### Receipt janitor

The janitor is triggered by the table stream and receives only TTL deletions of pending receipt metadata:

```json
{
  "eventName": ["REMOVE"],
  "userIdentity": {
    "type": ["Service"],
    "principalId": ["dynamodb.amazonaws.com"]
  },
  "dynamodb": {
    "OldImage": {
      "entityType": { "S": ["Receipt"] },
      "state": { "S": ["PENDING"] }
    }
  }
}
```

For each record it reads `receiptId` from the old image and deletes `receipts/<receiptId>` and `uploads/pending/<receiptId>`. Deleting a missing object succeeds, so retries are safe.

### Upload verification test

Before the AWS receipt adapter is relied on, the opt-in integration suite (section 23) must prove against a real bucket in `ap-southeast-1` that:

1. a file matching the declared size, type, and checksum uploads successfully;
2. a body of a different length is rejected;
3. a body whose SHA-256 checksum differs from the declared value is rejected;
4. a body uploaded with a different content type is rejected;
5. a correct upload passes `HeadObject` and ranged-`GetObject` inspection and can be attached to a claim.

## 12. Draft deletion and history cleanup

1. **Transaction.** For every draft deletion, regardless of how many history entries it has: delete the claim, decrement the category counter if the draft has a category, update receipt metadata if the draft has a receipt, write the cleanup outbox events, and store the idempotency result (section 8). No history entries are deleted in the transaction.
2. **Logical deletion is immediate.** The claim item is gone, and every history read first loads the claim, so the API returns `404` for the claim and its history as soon as the transaction commits.
3. **Physical cleanup is eventually consistent.** The cleanup worker consumes `internal.claim-history-purge-requested { claimId }` and deletes every history entry:
   - query `PK = CLAIM#<claimId>, SK begins_with HISTORY#` page by page;
   - delete with `BatchWriteItem`, 25 keys per call, retrying `UnprocessedItems` with backoff;
   - deleting an already-missing item succeeds, so a retried or duplicated purge event is harmless;
   - failed messages are retried through SQS and end in a dead-letter queue with an alarm.

History rows may remain briefly after the deletion commits. They are unreachable through the API. The claim's outbox items are not deleted by the worker; they expire after publication (section 14).

## 13. Pagination and cursor validation

### Pages

- `limit` is 1–100 (default 20). The adapter queries `limit + 1` items and issues a `nextCursor` only when the extra item exists, so a final page is never empty.
- No filter expressions are used, so a page is never shorter than requested while more items exist.

### Cursor format

A cursor is base64url-encoded JSON of at most 512 characters:

```json
{
  "v": 1,
  "list": "employee",
  "index": "GSI1",
  "key": {
    "PK": "CLAIM#4ce0c74b-9c64-46d6-87ba-07fb71b0628c",
    "SK": "CLAIM",
    "GSI1PK": "EMPLOYEE#sub-aisha",
    "GSI1SK": "2026-10-14T10:41:00.000Z#4ce0c74b-9c64-46d6-87ba-07fb71b0628c"
  }
}
```

### Mandatory validation

Before a cursor is used as `ExclusiveStartKey`, all of the following must hold. Any failure returns `400 VALIDATION_FAILED` with the field error `INVALID_CURSOR`.

1. It decodes as base64url and parses as a JSON object.
2. `v` equals `1`.
3. `list` equals the list being requested.
4. `index` equals that list's index:

   | List     | Index      | Expected partition value             |
   | -------- | ---------- | ------------------------------------ |
   | employee | GSI1       | `GSI1PK = EMPLOYEE#<caller>`         |
   | queue    | GSI2       | `GSI2PK = MANAGER#<caller>#OPEN`     |
   | status   | GSI3       | `GSI3PK = STATUS#<requested status>` |
   | all      | GSI4       | `GSI4PK = CLAIM` exactly             |
   | history  | base table | `PK = CLAIM#<requested claimId>`     |

5. `key` contains exactly the expected attribute names (the table keys plus that index's keys), and every value is a string.
6. The partition values equal the expected values for this request (table above). A cursor carrying `OUTBOX#PENDING` or any other value is rejected.
7. Key shapes match: `PK` is `CLAIM#<id>`; `SK` is `CLAIM` (or `HISTORY#` followed by ten digits for history); index sort keys match `<ISO-8601 instant>#<id>`.

The JSON is canonical: object keys are sorted at every level, with no whitespace, and the base64url text has no padding. A cursor that does not re-encode to exactly the same text, or whose JSON is not in canonical form, is rejected. History cursors use `"index": "table"` for the base table.

### Implementation

`services/api/src/adapters/aws/dynamodb-cursor.ts` encodes and validates cursors; an invalid cursor produces the same `ValidationError` with `INVALID_CURSOR` as the local runtime, before any query is sent. The read adapters in `services/api/src/adapters/aws/dynamodb-readers.ts` implement A1, A5–A10, C1, and C2 with `GetItem` and `Query` only, decode every item with the item codecs (section 7), and match the repository read methods; write methods are not implemented yet. A page query asks for `limit + 1` items and keeps querying from `LastEvaluatedKey` when DynamoDB returns a partial response, so a page is full whenever more items exist. Its cursor is the key of the last item returned, never of the look-ahead item. Category listing reads every page of the bounded `CATEGORIES` partition.

Signing cursors with an HMAC is optional hardening (section 24).

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

TTL deletion can lag well behind `expiresAt`. Every condition that depends on expiry treats `expiresAt < now` as absent instead of relying on deletion.

## 15. Outbox events, publication, and recovery

### Why a separate outbox

History entries are the immutable audit record and are not an event contract. Each publishable or cleanup event is written as its own outbox item in the same transaction as the change, with a stable envelope and a deliberately selected payload.

### Envelope

| Field                            | Meaning                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `eventId`                        | Unique ID from the existing `IdGenerator`; the deduplication key for consumers                                        |
| `eventType`                      | For example `claim.submitted`                                                                                         |
| `schemaVersion`                  | Payload schema version, starting at `1`                                                                               |
| `occurredAt`                     | Application timestamp assigned immediately before the transaction; DynamoDB does not return an exact commit timestamp |
| `source`                         | `claimflow.api`                                                                                                       |
| `aggregate.type`, `aggregate.id` | `claim` or `category` and its ID                                                                                      |
| `aggregate.version`              | The aggregate version this event describes                                                                            |
| `aggregate.previousEventVersion` | The version of the previous publishable event for this aggregate, or `null` for the first one                         |
| `correlationId`, `causationId`   | Request tracing                                                                                                       |
| `actorId`                        | The user who made the change                                                                                          |
| `payload`                        | Event-specific data (below)                                                                                           |

`previousEventVersion` exists because draft edits and receipt changes increment the claim version without publishing an event, so published versions are not consecutive. The claim or category item stores `lastEventVersion`, updated in the same transaction as each publishable event and copied into the next event's `previousEventVersion`.

**Cleanup events** (`internal.receipt-object-deletion-requested`, `internal.claim-history-purge-requested`) use the same envelope with these rules:

- they are stored with `PK = CLAIM#<claimId>` and `SK = OUTBOX#<occurredAt>#<eventId>`, in the transaction of the claim mutation that requested the cleanup;
- `aggregate.type` is `claim` and `aggregate.id` is the claim ID;
- `aggregate.version` is the claim version produced by that mutation. A draft deletion writes no history entry, so its cleanup events carry the deleted claim's version plus one;
- `aggregate.previousEventVersion` is `null`, and cleanup events do not change `lastEventVersion`, because they are not part of the published sequence that consumers track.

### Payload policy

Payloads contain identifiers, amounts, categories, and status timestamps only. Free text (merchant, business purpose, decision comments) is excluded because it may contain personal data. A consumer that needs those details reads the claim through the API, which applies the normal authorization rules.

### Event catalog

| Event                                                                                                           | Kind        | Payload beyond identifiers, amount, and category |
| --------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| `claim.submitted`                                                                                               | Publishable | `submittedAt`                                    |
| `claim.review-started`                                                                                          | Publishable | —                                                |
| `claim.approved`                                                                                                | Publishable | `reviewedAt`                                     |
| `claim.rejected`                                                                                                | Publishable | `reviewedAt`                                     |
| `claim.reopened`                                                                                                | Publishable | —                                                |
| `claim.paid`                                                                                                    | Publishable | `paidBy`, `paidAt`                               |
| `category.created`, `category.policy-changed`, `category.deactivated`, `category.activated`, `category.deleted` | Publishable | `categoryId`, `version`, changed fields only     |
| `internal.receipt-object-deletion-requested`                                                                    | Internal    | `claimId`, `receiptId`, `objectKey`              |
| `internal.claim-history-purge-requested`                                                                        | Internal    | `claimId`                                        |

Draft creation, draft edits, and receipt attachment are recorded in history but are not published. Internal events are routed only to the cleanup worker.

### Publisher (stream path)

- **Trigger:** the table stream (`NEW_AND_OLD_IMAGES`) through a Lambda event source mapping with this filter:

  ```json
  {
    "eventName": ["INSERT"],
    "dynamodb": { "Keys": { "SK": { "S": [{ "prefix": "OUTBOX#" }] } } }
  }
  ```

- **Publish:** `PutEvents` to the `claimflow` bus, at most 10 entries per call, with `Source = claimflow.api`, `DetailType = eventType`, and `Detail` = the envelope.
- **Mark published** after each successful entry:
  `UpdateItem SET #state = :published, publishedAt = :now, expiresAt = :publishedPlus7Days REMOVE GSI4PK, GSI4SK` with the condition `#state = :pending`. If the condition fails, another path already marked it; the failure is ignored.
- **Partial batch responses:** the event source mapping must set `FunctionResponseTypes: [ReportBatchItemFailures]`. When any entry fails (reported through `FailedEntryCount`), the function returns `batchItemFailures` containing the sequence number of the first failed record. Lambda checkpoints before that record and retries from it.
- **Redelivery:** every record from that checkpoint onward may be delivered again, including later records in the batch that were already published. Before publishing, the publisher reads the item's current state and skips items already `PUBLISHED`; this reduces duplicates but does not eliminate them, and consumers deduplicate by `eventId`.
- **Mapping settings:** split the batch on error, bounded retries, maximum record age 24 hours, on-failure destination an SQS dead-letter queue.

### Sweeper (recovery path)

Stream records are retained for 24 hours. If publication fails for longer, the stream can no longer supply those events. The sweeper covers this case:

- an EventBridge schedule runs it every 15 minutes;
- it queries `GSI4PK = OUTBOX#PENDING AND GSI4SK < <now − 5 minutes>` (access pattern O1), oldest first; the grace period avoids racing the stream path on new events;
- it publishes and marks each event exactly as the stream publisher does.

Pending outbox items have no TTL, so an unpublished event is never lost.

## 16. Event delivery guarantees and consumer behavior

### Guarantees

- **At least once.** An event is published and then marked. A crash between the two steps, or both the stream publisher and the sweeper handling the same event, publishes it twice. Consumers deduplicate by `eventId`.
- **No cross-item ordering.** DynamoDB Streams orders modifications to the same item key only. Different outbox items are different keys, even within the same partition, so they can reach the publisher in any order. EventBridge does not guarantee delivery order either.
- **Events are independent facts.** Each event states what happened ("claim X was approved at time T"), not the current state of the claim. No current consumer requires ordering.
- **Gap detection, not reordering.** A consumer that tracks the last event version it processed per aggregate can compare it with `aggregate.previousEventVersion` to detect that an earlier event has not arrived yet. `aggregate.version` and `previousEventVersion` do not reorder events.

If a future consumer genuinely needs strict per-claim ordering, that consumer requires its own design (section 24). A FIFO queue alone cannot restore an order that is not guaranteed before publication, and none is part of this design.

### Consumers

- Each consumer has an EventBridge rule targeting its own SQS standard queue with a dead-letter queue. Consumer functions report partial batch failures.
- **Effects stored in DynamoDB:** the consumer writes `CONSUMED#<consumer>#<eventId>` with `attribute_not_exists(PK)` in the same transaction as its effect. The effect is applied exactly once.
- **External effects** (email or SNS):
  1. if a completed dedupe record exists for the `eventId`, skip;
  2. send;
  3. write the dedupe record as completed.

  A crash between sending and recording causes a duplicate on redelivery. Recording before sending is not used, because a crash would then lose the notification. Notifications are therefore at least once and may rarely be duplicated, unless the provider accepts an idempotency key, in which case `eventId` is passed as that key.

- The cleanup worker is a consumer of the internal events and is idempotent by construction: deleting a missing object or item succeeds.

## 17. Identity and authorization

| Concern           | Local runtime                                                 | AWS runtime                                                                                 |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Authentication    | Development sign-in cookie selecting a sample user            | Cognito user pool; API Gateway JWT authorizer validates the access token before Lambda runs |
| User identifier   | Sample user ID                                                | Cognito `sub` claim                                                                         |
| Roles and manager | Seed directory                                                | `USER#<sub>` profile item in DynamoDB                                                       |
| User creation     | Defined in code                                               | Created by an administrator, with a profile item; no self sign-up                           |
| Session endpoints | `PUT /session` and `DELETE /session` select or clear the user | Not available; `GET /session` returns the signed-in user only                               |

The actor is built on the server from the profile on every request, so roles and manager assignments are never taken from the client. Authorization rules in the domain package are unchanged.

### Web sign-in

Users sign in on Cognito's classic hosted UI, not in a form inside the web application:

- **App client:** `ClaimFlowWeb`, a public client without a client secret. It allows only the OAuth 2.0 authorization code grant (the web application will use it with PKCE); the implicit and client-credentials grants are disabled. Its only direct API flow is refreshing tokens, so passwords are entered only on the classic hosted UI.
- **Identity provider:** the user pool itself; there are no social or federated identity providers.
- **Scopes:** `openid` and `email`.
- **Redirects:** sign-in returns to `/auth/callback` and sign-out to `/`, on the CloudFront distribution's HTTPS origin (section 4) or on `http://localhost:5173` for local development against Cognito. The CloudFront callback is the default redirect.
- **Tokens:** access and ID tokens are valid for 1 hour and refresh tokens for 30 days. Refresh tokens can be revoked, and sign-in errors do not reveal whether a user exists.
- **Domain:** a Cognito prefix domain, `claimflow-<account ID>`, which is deterministic and unique across AWS accounts, with the classic hosted UI. The user pool's Lite feature plan supports the classic hosted UI but not the newer managed login. The hosted UI uses Cognito's default appearance; there is no custom CSS, logo, or branding.

The app client and domain are infrastructure only. Adding sign-in to the web application, and its use of the tokens with the API, is a later increment.

## 18. Ports and adapters

| Port                                                                                                                                  | Local adapter                                                                                                                                      | AWS adapter                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ClaimRepository`, `CategoryRepository` (write methods accept commit options)                                                         | JSON database                                                                                                                                      | DynamoDB transactions                                                                                            |
| `ReceiptRepository` (new: receipt metadata)                                                                                           | JSON database                                                                                                                                      | DynamoDB                                                                                                         |
| `ReceiptStorage` (bytes only): `createUploadTarget`, `inspectPending`, `promote`, `deletePending`, `createDownloadUrl`, `deleteFinal` | Files; HMAC-signed local POST upload forms that enforce the same exact size, content type, and SHA-256 conditions; HMAC-signed local download URLs | S3 presigned POST policies, presigned `GET` URLs, `HeadObject`, ranged `GetObject`, `CopyObject`, `DeleteObject` |
| `IdempotencyStore`: `find`, `recordRejection`                                                                                         | JSON database                                                                                                                                      | DynamoDB                                                                                                         |
| `UserDirectory`: `get`, `getMany`                                                                                                     | Seed directory, which is also the development-only `DevelopmentUserCatalogue` behind the local user chooser; the AWS runtime has no catalogue      | DynamoDB `GetItem` and `BatchGetItem`                                                                            |
| `Clock`, `IdGenerator`, `Logger`                                                                                                      | Unchanged                                                                                                                                          | Unchanged; logs are written to standard output and collected by CloudWatch Logs                                  |

### Commit options

Write methods accept a commit envelope built by the services:

```ts
interface CommitOptions {
  readonly events: readonly OutboxEvent[];
  readonly idempotency?: CompletedRequest; // actorId, key, fingerprint, response, createdAt, expiresAt
  readonly categoryGuard?: CategoryGuard; // categoryId, readVersion, mustBeActive
}
```

These types are defined in `services/api/src/application/commit.ts`, and the outbox envelope, event types, and payloads in `services/api/src/application/events.ts`. `expiresAt` is a TTL in whole Unix epoch seconds (`toEpochSeconds`, `expiresAfter`), never an ISO string. `aggregate.previousEventVersion` is a number or `null`, and always `null` for internal cleanup events. Event payloads carry identifiers, amounts, categories, and timestamps only, never merchants, business purposes, comments, or names. Repositories, idempotency, and services do not use these types yet.

The local JSON database already applies each write atomically, so the local adapters provide the same all-or-nothing behavior as the DynamoDB adapters.

### Code impact

**Unchanged:** `packages/domain`; route definitions other than the receipt routes; error mapping; the logger.

**Done:** the request pipeline is a transport-neutral API handler (`services/api/src/http/api-handler.ts`) with normalized requests and responses. It owns routing, body parsing and size limits, idempotency, error conversion, request and correlation IDs, response headers, and request logging, and receives authentication through an injected resolver. The `node:http` server is a thin adapter around it that also serves the built web app locally; the local runtime injects the development session-cookie resolver. An API Gateway HTTP API transport adapter (`services/api/src/http/lambda-adapter.ts`) converts payload format 2.0 events to the same normalized requests, decoding base64 bodies, and returns binary responses base64-encoded. It passes on only the `sub` claim validated by the JWT authorizer, as the request's verified subject; roles still come from the DynamoDB profile. The AWS API handler (`services/api/src/http/aws-api.ts`) combines the AWS route set, which has no `PUT` or `DELETE /session` and whose `GET /session` lists no other users, with a Cognito identity resolver. That resolver reads only the verified subject and loads the actor for it through the session service from the user directory; a missing subject or a subject without a profile is unauthenticated. The Lambda entry point and AWS composition root will connect this handler and the adapter to the DynamoDB user directory. The `UserDirectory` port has only `get` and `getMany`, so the DynamoDB adapter needs only `GetItem` and `BatchGetItem` (U2 in section 6). `presenters.loadNames` requests, once each, only the employees, assigned managers, and history actors of the claims or entries being presented, and matches profiles by ID because `BatchGetItem` returns them in any order. Listing users is a separate, development-only `DevelopmentUserCatalogue`, which only the local session description uses. The DynamoDB `UserDirectory` adapter (`services/api/src/adapters/aws/dynamodb-user-directory.ts`) implements U1 with a strongly consistent `GetItem` and U2 with eventually consistent `BatchGetItem` calls of at most 100 deduplicated keys. It retries unprocessed keys with capped exponential backoff and fails after a fixed number of attempts rather than returning incomplete names. It validates every stored profile item (keys, `entityType`, non-empty `userId`, `displayName`, and `title`, `roles` as a list of `EMPLOYEE`, `MANAGER`, or `ADMIN`, and an optional non-empty `managerId`) and rejects malformed items instead of using their authorization data. The document client and table name are injected; the adapter is not yet wired into a composition root.

**Changed in later phases:**

- services build outbox events and commit options;
- the idempotency wrapper uses `find`, commit-time completion, and `recordRejection`;
- port signatures as listed above, with the local adapters updated to match;
- receipt routes and contracts move to presigned POST upload forms and presigned download URLs in both runtimes;
- the web app adds Cognito User Pool sign-in for the AWS runtime and uses the presigned receipt flow.

**New, AWS only:**

- DynamoDB and S3 adapters for the ports above;
- an identity resolver that reads the `sub` claim validated by API Gateway's Cognito User Pool JWT authorizer and loads the DynamoDB user profile;
- Cognito User Pool sign-in integration in the web application;
- the AWS composition root and the API Lambda entry point;
- the publisher, sweeper, receipt janitor, and cleanup worker functions, with EventBridge publishing in the publisher and sweeper.

The design uses a Cognito User Pool for authentication only. It does not use or define a Cognito Identity Pool.

## 19. Security boundaries

- **Edge:** API Gateway's JWT authorizer rejects requests without a valid Cognito User Pool access token before any code runs. Throttling limits are set on the API stage.
- **Application:** every operation loads the actor from the profile and applies the domain authorization rules; inaccessible claims return `404`.
- **Data:** conditional writes repeat the ownership and assignment checks inside the transaction.
- **Least privilege:** each function has its own IAM role, limited to the table, indexes, bucket prefixes, bus, and queues it uses. The API function cannot read the stream; the janitor can only delete receipt objects; the cleanup worker can only delete history items and receipt objects.
- **Receipt bucket:** all public access blocked, a bucket policy that denies non-TLS requests, server-side encryption, and CORS limited to `POST` from the web application's origin (the CloudFront distribution's HTTPS origin, section 4). Upload POST policies are valid for 15 minutes and restricted to one key, the exact declared size, the declared content type, and the declared SHA-256 checksum; download URLs are valid for 5 minutes.
- **Web hosting:** the web assets bucket is private and readable only by the ClaimFlow CloudFront distribution through Origin Access Control; viewers are redirected to HTTPS. The bucket holds only the built web application, never user data.
- **Encryption:** DynamoDB, S3, SQS, and CloudWatch Logs encrypted at rest; TLS in transit.
- **Event bus:** no free text in payloads; consumers fetch details through the authorized API.
- **History immutability:** IAM cannot restrict updates by sort key, so immutability relies on code that never updates history items, the `attribute_not_exists` condition on every history Put, and point-in-time recovery.

## 20. Consistency summary

| Area                                 | Guarantee                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Claim, category, and receipt changes | Atomic with history, outbox events, and idempotency result                                |
| Reads used for write decisions       | Strongly consistent                                                                       |
| List views (GSI1–GSI4)               | Eventually consistent; usually visible within a second                                    |
| Event publication                    | At least once; no cross-item ordering                                                     |
| History purge after draft deletion   | Logically immediate; physically eventually consistent                                     |
| Receipt object cleanup               | Eventually consistent, through the cleanup worker, the janitor, and the S3 lifecycle rule |

## 21. Cost considerations

- **No always-on compute.** Lambda, API Gateway, DynamoDB on-demand requests, EventBridge, and SQS are billed per use.
- **Charges without request traffic.** Some costs continue even when nobody uses the application, and may be low but are not zero:
  - DynamoDB storage and point-in-time recovery;
  - S3 storage for receipts and the built web application;
  - CloudWatch Logs storage, metrics, and alarms;
  - retained data in general, including history, profiles, and outbox items within their retention periods;
  - the outbox sweeper's scheduled invocations every 15 minutes.
- **Writes.** Transactional writes cost twice a standard write, and each claim write also updates up to four index entries and usually one outbox item.
- **Lambda.** Functions run on arm64. Stream reads by Lambda triggers are not billed separately, and records removed by event filters do not invoke functions.
- **API.** HTTP API is used instead of REST API for its lower request price.
- **Web hosting.** CloudFront is billed per request and per byte transferred, with no fixed charge for the distribution; the default `*.cloudfront.net` domain avoids certificate and DNS costs.
- **Retention.** Every log group has a retention period (for example 30 days), and the S3 lifecycle rule and TTL keep abandoned uploads, idempotency records, and published outbox items from accumulating.

## 22. Operations

- **Backups:** point-in-time recovery and deletion protection on the table; S3 versioning is not required because receipts are immutable once attached.
- **Alarms:** API 5xx rate; Lambda errors and throttles for every function; stream iterator age for the publisher and janitor; dead-letter queue depth for the publisher, cleanup worker, and each consumer; age of the oldest pending outbox item.
- **Logs:** structured JSON with request and correlation IDs, as in the local runtime, plus the Lambda request ID.
- **Recovery:** unpublished events are republished by the sweeper; failed cleanup messages are retried from their dead-letter queues after the cause is fixed.

## 23. Testing strategy

- **Domain and contracts:** the existing unit tests continue unchanged.
- **Shared adapter contract tests:** one test suite describes the behavior of each port (atomic commits, conditions, idempotency, pagination, cursor validation). It runs against the local adapters in every build and against the AWS adapters as described below.
- **AWS adapter unit tests:** the AWS SDK is mocked to verify the exact keys, conditions, transaction contents, and error mapping each adapter produces. These run in CI without AWS access.
- **Transaction recovery tests:** with a mocked SDK raising `TransactionCanceledException` without per-item reasons, verify each row of the recovery table in section 10: idempotency replay and conflict, version conflict, category rerun, `CATEGORY_IN_USE`, `RECEIPT_UNAVAILABLE`, integrity errors, and bounded retries of unclassified cancellations. Unclassified cancellations must never be reported as known transaction conflicts or version conflicts, and exhausting the retries must log and emit the alarm metric. Throttling, capacity, `ValidationException`, and `InternalServerError` must never be mapped to business conflicts.
- **Receipt attachment condition tests:** a receipt in `ATTACHED`, `REPLACED`, or `REMOVED` state fails the attachment condition and returns `RECEIPT_UNAVAILABLE`, and a repeated attachment request with the same idempotency key is replayed from the idempotency record without running a transaction.
- **Request token tests:**
  1. identical canonical transaction payloads produce the same `ClientRequestToken`;
  2. changing any transaction value produces a different token;
  3. reconstructing the request in a fresh service invocation produces the same token for an identical payload;
  4. a token is never paired with a different payload;
  5. every token is at most 36 characters.
- **Ambiguous failure tests:** after a mocked `InternalServerError`, service-unavailable response, or timeout, the outcome is resolved through the idempotency record (replay or `IDEMPOTENCY_CONFLICT`) or by an identical retry with the same token, and otherwise ends in the generic `500` without claiming that nothing committed.
- **Rejection record race tests:** when the conditional rejection `Put` loses to an existing record, the record is reread and replayed for a matching fingerprint or answered with `IDEMPOTENCY_CONFLICT` for a different one.
- **Opt-in integration suite:** the same contract tests run against a real development table and bucket in `ap-southeast-1`. It includes the receipt upload verification in section 11: a matching file uploads; a different-length body, a wrong SHA-256 checksum, and a different content type are rejected; and a correct upload can be inspected and attached. This suite is run deliberately by the operator, never automatically in CI.
- **Function tests:** the publisher, sweeper, janitor, and cleanup worker are tested with recorded stream and queue events, including partial failures, duplicate delivery, and missing items. Publisher tests verify that `batchItemFailures` reports the first failed sequence number and that redelivered, already-published records are skipped.
- **No Docker requirement:** none of the above requires containers or local AWS emulators.

## 24. Deferred options

These are recorded for later and are **not** part of the approved design.

- **HMAC-signed cursors:** structural validation is mandatory today; signing would additionally make cursors tamper-evident.
- **Sharding GSI4 partitions:** splitting `CLAIM` or `OUTBOX#PENDING` across several partition values if write volume ever approaches a single partition's limit.
- **Strict per-claim event ordering:** a dedicated design for a future consumer that requires it, for example buffering by `previousEventVersion` or reading the authoritative claim state when an event arrives.
- **Customer-managed KMS keys:** if a compliance requirement calls for them; the approved design uses AWS-managed encryption.
- **Custom web domain:** an alternate domain name for the CloudFront distribution, with an ACM certificate in `us-east-1` and DNS records; the default `*.cloudfront.net` domain is used until then.
- **Remaining infrastructure:** every approved component beyond the DynamoDB table, the Cognito User Pool with its web app client and classic hosted UI domain, the receipt bucket, and web hosting is a future increment, defined in the CDK application and deployed manually (section 4).

## 25. Decisions

All decisions below are approved.

### Final decision table

| #   | Decision                                                                                                                                                                                                         | Outcome  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D1  | One receipt contract for both runtimes: presigned S3 POST policy uploads (exact size, type, and SHA-256 conditions) and presigned downloads; the local runtime emulates it with HMAC-signed local forms and URLs | Approved |
| D2  | `claimCount` usage counter on categories, with category guards built on it                                                                                                                                       | Approved |
| D3  | Store rejected (4xx) requests under their idempotency key                                                                                                                                                        | Approved |
| D4  | Exclude free text from event payloads                                                                                                                                                                            | Approved |
| D5  | Event catalog as listed in section 15; draft and receipt steps are not published                                                                                                                                 | Approved |
| D6  | When a category guard fails, retry once automatically, then return `409`                                                                                                                                         | Approved |
| D7  | Retention: published outbox items 7 days after publication; pending outbox items never expire; replaced or removed receipt metadata 30 days                                                                      | Approved |
| D8  | Adapter testing without Docker: mocked AWS SDK unit tests and an opt-in suite against a real development table                                                                                                   | Approved |
| D9  | Record the design in `docs/aws-architecture.md`; design only, no infrastructure code                                                                                                                             | Approved |
| D10 | `lastEventVersion` on claims and categories and `aggregate.previousEventVersion` on events, for gap detection                                                                                                    | Approved |
| D11 | Outbox sweeper every 15 minutes with a 5-minute grace period                                                                                                                                                     | Approved |
| D12 | Recovery from cancelled transactions by strongly rereading the idempotency record and conditioned items, without per-item cancellation reasons                                                                   | Approved |
| D13 | Deterministic `ClientRequestToken` derived from the canonical transaction payload; ambiguous failures resolved through the idempotency record and identical retries with the same token                          | Approved |
| D14 | Receipt attachment requires `PENDING` metadata only; committed attachments are retried only through idempotent replay                                                                                            | Approved |
| D15 | Web hosting: the built React application in a separate private S3 bucket behind CloudFront with Origin Access Control, HTTPS redirection, and `/index.html` served for missing paths                             | Approved |

### Open decisions

None. Web application hosting, previously open, is settled by D15.

### Settled architecture choices

| Choice                | Outcome                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS Region            | `ap-southeast-1`                                                                                                                                                                                                                    |
| API compute           | One API Lambda function behind an HTTP API                                                                                                                                                                                          |
| Identity              | Cognito User Pool with API Gateway JWT authorization; administrator-created users; roles and manager in DynamoDB profiles; no Cognito Identity Pool                                                                                 |
| Receipt upload        | Presigned S3 POST policy with exact `content-length-range` and SHA-256 checksum conditions                                                                                                                                          |
| Web hosting           | Private S3 bucket behind CloudFront with Origin Access Control; default `*.cloudfront.net` domain                                                                                                                                   |
| Infrastructure        | AWS CDK in TypeScript (`infrastructure/`); the DynamoDB table, the Cognito User Pool with its web app client and classic hosted UI domain, the receipt bucket, and web hosting are deployed; other components are future increments |
| Data model            | Single DynamoDB table with GSI1–GSI4; GSI4 also holds pending outbox items                                                                                                                                                          |
| Stream                | `NEW_AND_OLD_IMAGES`                                                                                                                                                                                                                |
| Write model           | One transaction per mutation, including history, outbox events, and the idempotency result                                                                                                                                          |
| Event publication     | Stream publisher Lambda to EventBridge, with the scheduled sweeper for recovery                                                                                                                                                     |
| Event identifiers     | Existing `IdGenerator`; outbox sort key `OUTBOX#<occurredAt>#<eventId>`                                                                                                                                                             |
| Draft history cleanup | All history purged by the cleanup worker after the deletion transaction                                                                                                                                                             |
| Local runtime         | Kept as the default development runtime, with adapters matching the new port semantics                                                                                                                                              |
