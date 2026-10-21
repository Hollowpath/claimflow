# AWS architecture

This document defines the approved target architecture for running ClaimFlow on AWS. The architecture is being implemented in increments. The TypeScript CDK application exists in `infrastructure/`. The `ClaimFlow` DynamoDB table, the `ClaimFlow` Cognito User Pool with its web app client and classic hosted UI domain, the receipt bucket, and web hosting are defined and deployed in `ap-southeast-1`. The application is not connected to any of them yet, and no built web application files are uploaded.

The repository distinguishes three states. **Deployed:** the infrastructure listed in section 4. **Implemented and fake-tested, not wired:** the application's DynamoDB and S3 adapters and the AWS application services built on them (readers, writers, idempotency orchestration, claim creation, editing, lifecycle, receipt attachment, removal, deletion, the receipt upload-target and download flows, and the opt-in request-pipeline seams that expose them), all exercised only against fake AWS dependencies and none registered in the production composition. **Not built:** the production composition, the API Gateway HTTP API and its Lambda function, the web application's Cognito integration, the upload-target route and browser upload flow, publishing the web application, and the CloudWatch metric and alarm wiring. Nothing implemented has been exercised against a deployed environment, and the local runtime remains the only runnable one (see section 4).

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
- Defined in the stack and deployed in `ap-southeast-1`: the `ClaimFlow` DynamoDB table (section 5), the `ClaimFlow` Cognito User Pool (section 17), and the receipt bucket (section 11). The receipt bucket's single CORS rule (section 11) is deployed too: the CloudFront HTTPS origin only, `POST` only, allowed headers `*`, no exposed headers, and no max age. It permits the browser to send presigned POST uploads from the web application but grants no S3 authorization: every upload still needs a valid presigned POST policy. The AWS application runtime and the browser upload flow are not implemented yet, so nothing uploads receipts to the bucket.
- Defined in the stack and deployed in `ap-southeast-1`: web hosting (the web assets bucket and the CloudFront distribution, described below). No built web application files are uploaded yet, so the application is not available through CloudFront.
- Defined in the stack and deployed in `ap-southeast-1`: the Cognito web app client `ClaimFlowWeb` and the classic hosted UI domain (section 17). The web application has no Cognito integration yet and still uses development sign-in locally.
- The application is not connected to this infrastructure yet: it still runs locally with development sign-in and local adapters, so receipt uploads do not reach the bucket.
- Defined in the stack and deployed in `ap-southeast-1`: the `claimflow` event bus, the cleanup queue and its dead-letter queue, and the rule routing the two internal cleanup events to the cleanup queue (section 15). Nothing publishes to them yet.
- Defined in the stack and deployed in `ap-southeast-1`: the cleanup worker Lambda function `claimflow-cleanup-worker` with its execution role, its log group, and the SQS event-source mapping from the cleanup queue (sections 12 and 19). Nothing currently produces outbox events, so the cleanup path stays idle until the AWS application runtime exists.
- Defined in the stack and deployed in `ap-southeast-1`: the outbox publisher Lambda function `claimflow-outbox-publisher` with its execution role, its log group, its failure queue `claimflow-outbox-publisher-failures`, and the DynamoDB stream event-source mapping (section 15). The receipt janitor and the sweeper are deployed as well, but the AWS application runtime does not exist yet, so nothing produces outbox events and the publisher stays idle.
- Defined in the stack and deployed in `ap-southeast-1`: the receipt janitor Lambda function `claimflow-receipt-janitor` with its execution role, its log group, its failure queue `claimflow-receipt-janitor-failures`, and the DynamoDB stream event-source mapping (section 11). The AWS application runtime does not exist yet, so nothing creates pending receipt records and the janitor stays idle.
- Defined in the stack and deployed in `ap-southeast-1`: the outbox sweeper Lambda function `claimflow-outbox-sweeper` with its execution role, its log group, the EventBridge schedule that invokes it every 15 minutes, and the Lambda invocation permission for that rule (section 15). The enabled schedule runs every 15 minutes and queries `GSI4` even while no outbox events exist. The AWS application runtime is not implemented, so the publisher and sweeper currently have no application-created outbox events to process.
- All other approved components remain future increments: the API and its Lambda function.
- Phase 0 produced this design only; infrastructure is added in separate, reviewed increments.
- Deployment is manual. It must never run automatically, including from CI, without explicit authorization.

### Web application hosting

The built React web application is hosted as static files in a private S3 bucket behind a CloudFront distribution (decision D15 in section 25):

- **Web assets bucket:** separate from the receipt bucket; all public access blocked, S3 managed encryption, a bucket policy that denies non-TLS requests, no S3 website hosting, and a `RETAIN` removal policy without automatic object deletion.
- **Origin access:** CloudFront reads the bucket through Origin Access Control (OAC), signing every request with SigV4. The bucket policy allows only `s3:GetObject`, only for the `cloudfront.amazonaws.com` service principal, and only for requests from this distribution. There is no origin access identity and no public object access.
- **Viewer access:** HTTP requests are redirected to HTTPS; only `GET` and `HEAD` are allowed, with the managed caching-optimized cache policy.
- **Client-side routes:** `index.html` is the default root object. Because CloudFront has no permission to list the bucket, S3 answers a missing key with `403` rather than `404`; both are answered with `/index.html` and status `200`, so that React `BrowserRouter` routes such as `/claims/<id>` load the application, which then resolves the route.
- **Domain:** the distribution's default `*.cloudfront.net` domain with CloudFront's default certificate. A custom domain is deferred (section 24).

The distribution's HTTPS origin is the web origin for the Cognito app client's callback and sign-out URLs (section 17) and for the receipt bucket's CORS rule, which allows `POST` from that origin only.

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
- **Receipt metadata** (`dynamodb-receipt-items.ts`): a persistence lifecycle separate from the domain `Receipt` and `UploadedReceipt`. Every state has the receipt ID, owner, a file name already in the domain's sanitized form, and the upload time, and no index attributes. A `PENDING` item has the declared type, size, and checksum, `objectKey = uploads/pending/<receiptId>`, and `expiresAt` exactly 24 hours after `uploadedAt`. An `ATTACHED` item has the measured values, `attachedClaimId`, and `objectKey = receipts/<receiptId>`, with no `expiresAt`. `REPLACED` and `REMOVED` items keep the measured values and claim and add an `expiresAt`, which `retiredReceiptExpiresAt` derives 30 days after the state change. Each state's required attributes are enforced and every other state's attributes are rejected; types are PDF, JPEG, or PNG, and sizes run from 1 byte to 10 MB.
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
  "expiresAt": 1792060500
}
```

After attachment, the same item has `state: ATTACHED`, `attachedClaimId`, `objectKey: receipts/r-7731`, the measured `contentType`, `sizeBytes`, and `checksumSha256`, and no `expiresAt`. A replaced or removed receipt has `state: REPLACED` or `REMOVED` and an `expiresAt` 30 days later.

Only a `PENDING` item carries the `declared*` attributes; the update that attaches the receipt removes them, so `ATTACHED`, `REPLACED`, and `REMOVED` items carry only the measured values.

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

### Transaction envelope

`composeBusinessTransaction` in `services/api/src/adapters/aws/dynamodb-transaction.ts` builds, but never sends, the `TransactWriteItems` input common to every mutation. It contains the business operations supplied by a repository builder, in order, then one outbox `Put` per event with `attribute_not_exists(PK)`, in order, then the completed idempotency `Put`. Outbox items are encoded as `PENDING` by the outbox codec. The idempotency record is encoded by the idempotency codec with the shared condition `attribute_not_exists(PK) OR expiresAt < :nowEpoch` (`idempotencyWriteCondition`, also used by the rejection writer), with `:nowEpoch` taken from the record's `createdAt`. The `ClientRequestToken` is then derived from the complete `{ TransactItems }` payload, which never contains the token. Before returning, it requires at least one business operation, at most 100 operations in all, exactly one `Put`, `Update`, `Delete`, or `ConditionCheck` per entry on the supplied table, string `PK` and `SK` keys, and no item touched twice, including between business, outbox, and idempotency items. Business conditions and category guards are the business builders' responsibility. The 4 MB request size is not estimated; the item codecs and body limits bound it.

`DynamoDbTransactionExecutor` in `services/api/src/adapters/aws/dynamodb-transaction-executor.ts` sends a composed transaction with one `TransactWriteCommand` on an injected document client, exactly as composed: same items, same order, same `ClientRequestToken`. It returns the SDK output and adds no retries, logging, or error mapping. Every SDK error, including `TransactionCanceledException` and `IdempotentParameterMismatchException`, propagates unchanged and its cancellation reasons are not inspected; recovery (section 10) belongs to the idempotency orchestration.

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

**Category operation builders.** `services/api/src/adapters/aws/dynamodb-category-operations.ts` builds these category operations as transaction items for the transaction envelope (section 8), without sending them:

- **Create:** `Put` of the codec-encoded item at version 1, with `claimCount = 0` and `lastEventVersion = 1`, conditioned on `attribute_not_exists(PK)`.
- **Update:** an `Update`, not a replacing `Put`, at `expectedVersion`. The new version must be `expectedVersion + 1`. It sets every mutable field, `version`, `updatedAt`, and `updatedBy`, and never `claimCount` or `createdAt`, so a concurrent counter change is kept. It also sets `lastEventVersion`, but only when the caller says the change publishes at least one event; a change to the name alone publishes none and leaves `lastEventVersion` as it was.
- **Delete:** a `Delete` with the version and `claimCount` condition above.
- **Counter:** `ADD claimCount :one` with the guard `#version = :readVersion AND #active = :true`, and `ADD claimCount :minusOne` with the decrement condition. Neither changes `version` or `lastEventVersion`.
- **Guard check:** the same guard as a `ConditionCheck`, for submissions without a counter change.

The condition texts are exported constants. Guards must require an active category; a `CategoryGuard` with `mustBeActive: false` is refused rather than reinterpreted. Category IDs and versions are validated before an operation is returned, and category values are validated by the category codec.

**Category writer.** `DynamoDbCategoryWriter` in `services/api/src/adapters/aws/dynamodb-category-writer.ts` is the write side of the category repository (access patterns C3 to C5), not yet wired into any service or composition. `create(category, options)`, `update(category, expectedVersion, options)`, and `delete(categoryId, expectedVersion, options)` each take `CommitOptions`, build the category operation with the builders above, compose it with the supplied outbox events and the completed idempotency record through `composeBusinessTransaction` (category item, then outbox items, then the idempotency item, with the composer's deterministic `ClientRequestToken`), and send the result once through `DynamoDbTransactionExecutor`. `options.idempotency` is required and `options.categoryGuard` is refused, both before any command, because category administration is an idempotent HTTP operation without a claim-write guard. An update passes whether the options carry events to the operation builder, so a name-only change keeps `lastEventVersion`. Constructor and option errors are fixed messages that echo no supplied value; invalid categories, versions, events, and idempotency data are rejected by the existing builders, codecs, and composer before sending. The writer inspects no cancellation reason, retries nothing, and rereads nothing: every executor and SDK error propagates unchanged for the later idempotency orchestration.

**Claim operation builders.** `services/api/src/adapters/aws/dynamodb-claim-operations.ts` builds the claim and history operations, without sending them:

- **Create:** `Put` of the codec-encoded claim, which must be a `DRAFT` at version 1, with a `CREATE` history entry that has no `fromStatus` and results in `DRAFT`, both conditioned on `attribute_not_exists(PK)`. There is no `lastEventVersion`, because creation is not published.
- **Update:** an `Update` that `SET`s every attribute of the codec-encoded new claim and `REMOVE`s every other claim attribute. This covers optional fields and the sparse GSI2, so the stored item becomes exactly the encoded claim; `PK` and `SK` are never touched, and every attribute is named through `ExpressionAttributeNames` in a fixed order. It is followed by the history `Put`. The new version must be `expectedVersion + 1`. The history entry must match the claim's ID, version, and status, and the action's transition in `claimTransitions` (draft and receipt changes stay in `DRAFT`). Lifecycle actions set `lastEventVersion` to the new version; draft and receipt changes keep the stored value. The stored value, read with the claim at `expectedVersion`, must be absent or a whole number from 0 to `expectedVersion` for every action.
- **Conditions:** owner actions (edit, receipt changes, submit, reopen) require `#version = :expectedVersion AND #employeeId = :actorId`; review actions (start review, approve, reject) require the assigned manager instead. Marking paid requires only the version, because the administrator role is checked by the application.
- **Delete draft:** a `Delete` of an owned draft that was never submitted, at its current version, with the condition in the table above. History is purged afterwards by the cleanup worker (section 12).

**Receipt operation builders.** `services/api/src/adapters/aws/dynamodb-receipt-operations.ts` builds the receipt metadata operations, without sending DynamoDB or S3 commands. Every record is validated by the receipt codec.

- **Create:** `Put` of the codec-encoded `PENDING` item, conditioned on `attribute_not_exists(PK)`; the codec fixes the 24-hour TTL and the pending object key.
- **Attach:** an `Update` from `PENDING` to `ATTACHED` that sets the measured values, `attachedClaimId`, and `objectKey = receipts/<receiptId>`, and removes the `declared*` attributes and `expiresAt`. Both records must describe the same receipt, owner, file name, and upload time, the measured type, size, and checksum must equal the declared ones, and the actor must be the owner. Condition: `ownerId = :actorId AND #state = :pending`.
- **Replace or remove:** an `Update` from `ATTACHED` to `REPLACED` or `REMOVED` that sets only the state and an `expiresAt` exactly 30 days after the change. The records must otherwise be identical, including the measured values and claim, and the change time must be canonical and not before the upload. Condition: `#state = :attached AND attachedClaimId = :claimId`.

Cleanup events for replaced and removed objects are passed to the transaction envelope with these operations.

**Receipt upload writer.** `DynamoDbReceiptUploadWriter` in `services/api/src/adapters/aws/dynamodb-receipt-upload-writer.ts` commits the metadata of a pending upload (access pattern R1), not yet wired into any service, route, or composition. `createPending(record, options)` builds the pending receipt `Put` with `createPendingReceiptOperation`, composes it with the completed idempotency record through `composeBusinessTransaction` (the pending receipt item, then the idempotency item, with the composer's deterministic `ClientRequestToken`), and sends the result once through `DynamoDbTransactionExecutor`. `options.idempotency` is required, `options.events` must be empty because creating an upload target publishes no event, and `options.categoryGuard` is refused, all before any command. Constructor and option errors are fixed messages that echo no supplied or stored value; the receipt record and idempotency data are validated by the existing codecs, builder, and composer. The writer performs no S3 operation, creates no upload form, and inspects no cancellation reason, retries nothing, and rereads nothing: every executor and SDK error propagates unchanged. Attachment, replacement, and removal are not written here; they are committed with their claim mutation.

**Claim writer.** `DynamoDbClaimWriter` in `services/api/src/adapters/aws/dynamodb-claim-writer.ts` is the creation side of the claim repository (access pattern A2), not yet wired into any service, route, or composition. `create(change, options)` builds the claim `Put` and the first history `Put` with `createClaimOperations`, adds `incrementClaimCountOperation` only for a categorized claim, composes them with the completed idempotency record through `composeBusinessTransaction` (claim, history, optional counter increment, idempotency, with the composer's deterministic `ClientRequestToken`), and sends the result once through `DynamoDbTransactionExecutor`. `options.idempotency` is required and `options.events` must be empty. A categorized claim requires a `categoryGuard` for the same category with `mustBeActive: true`, and an uncategorized claim must have none; the guard is applied by the counter increment, so there is no separate `ConditionCheck`. All of this is checked before any command with fixed messages that echo no supplied or stored value; the claim, history, guard values, and idempotency data are validated by the existing builders, codecs, and composer. The writer inspects no cancellation reason, retries nothing, and rereads nothing: every executor and SDK error propagates unchanged. `updateDraft(previousClaim, change, storedLastEventVersion, options)` commits a draft edit (access pattern A3, draft edits only): it accepts only an `UPDATE` history action with both claims in `DRAFT`, for the same claim and owner, validates the previous claim with the claim codec, and expects `previousClaim.version`. The transaction holds the `updateClaimOperations` update and history entry, then `decrementClaimCountOperation` for the old category and `incrementClaimCountOperation` for the new one, each only when the category changed (so adding, removing, and switching are supported and an unchanged category touches no counter), then the idempotency record. A matching `mustBeActive: true` guard is required only when entering a different, defined category and is applied through the increment; in every other case a guard is refused. Events must be empty, `storedLastEventVersion` is preserved by the update builder, and no read, retry, or cancellation-reason inspection is added. `updateLifecycle(previousClaim, change, storedLastEventVersion, options)` commits `START_REVIEW`, `APPROVE`, `REJECT`, `REOPEN`, and `MARK_PAID` (access pattern A3); `SUBMIT`, draft edits, and receipt actions are refused. It requires an unchanged claim ID, owner, and category, a previous claim whose status equals `history.fromStatus` and that passes the claim codec, and takes the expected version from `previousClaim.version`. `options.idempotency` is required, a `categoryGuard` is refused, and exactly one event is required; that event must equal `buildClaimLifecycleEvent(change, ids, storedLastEventVersion)` with the event, correlation, and causation IDs taken from the supplied event, compared with `canonicalJson`, so its type, aggregate version chain, actor, timestamp, and payload are all checked and the writer generates no ID or timestamp. The transaction is the `updateClaimOperations` update (whose actor condition and `lastEventVersion` advance come from the builder) and history entry, the outbox event, then the idempotency record. Business authorization stays in the domain and application layers. `submit(previousClaim, change, storedLastEventVersion, options)` commits `SUBMIT` from `DRAFT` to `SUBMITTED`, covering first submission and resubmission after reopening. It requires the same claim ID, owner, and defined category, a previous claim in `DRAFT` that passes the claim codec, an idempotency record, a `categoryGuard` for the claim's category with `mustBeActive: true`, and exactly one event that equals the rebuilt `claim.submitted` event (the same canonical comparison as `updateLifecycle`). The transaction is the `updateClaimOperations` update at `previousClaim.version` and history entry, a `categoryGuardCheckOperation` `ConditionCheck`, the outbox event, then the idempotency record; no category counter is changed, because submission does not change which claims use a category. Policy evaluation and authorization stay in the domain and application layers. `attachReceipt(previousClaim, change, pendingReceipt, attachedReceipt, storedLastEventVersion, options)` commits the first receipt of a draft (`ATTACH_RECEIPT`, access patterns A3 and R5). Both claims must be `DRAFT` with the same claim ID, owner, and category, the previous claim must have no receipt (and pass the claim codec), and the new claim must have one that matches the attached record's receipt ID, file name, content type, size, and checksum, with `attachedAt` equal to the history time. The attached record must name this claim and be owned by the claim owner, who must be the history actor. The transaction is the `updateClaimOperations` update at `previousClaim.version` (keeping `storedLastEventVersion`) and history entry, the `attachReceiptOperation` update from `PENDING` to `ATTACHED`, then the idempotency record. Events must be empty and a category guard is refused, so no counter, `ConditionCheck`, or outbox item is written. The writer performs no S3 operation: inspection and promotion of the upload happen elsewhere before the write. `replaceReceipt(input, options)` commits a receipt replacement (`REPLACE_RECEIPT`, access patterns A3 and R5). `input` names the previous claim, the change, the new pending and attached records, the old attached and `REPLACED` retired records, and `storedLastEventVersion`. Both claims must be `DRAFT` with the same claim ID, owner, and category; both must have receipts with different IDs; the old attached record must match the previous claim's receipt, owner, and claim; the old retired record must be `REPLACED`; and the new attached record is linked to the new claim receipt exactly as in `attachReceipt`, including `attachedAt` equal to the history time. The transaction is the claim update at `previousClaim.version` and history entry, the new receipt's `PENDING` to `ATTACHED` update, `retireReceiptOperation` for the old receipt at `history.occurredAt` (the builders enforce the retained metadata and the 30-day TTL), the cleanup outbox event, then the idempotency record. The one event must equal `buildReceiptDeletionEvent` for the old receipt's final object (history actor and time, new claim version, claim ID, supplied IDs), compared canonically; because a cleanup event is outside the published sequence, `storedLastEventVersion` is kept. A category guard is refused, and no S3 operation is performed. `removeReceipt(input, options)` commits a receipt removal (`REMOVE_RECEIPT`, access patterns A3 and R5). `input` names the previous claim, the change, the attached and `REMOVED` retired records, and `storedLastEventVersion`. Both claims must be `DRAFT` with the same claim ID, owner, and category; the previous claim must have a receipt and the changed claim none; the attached record must match the previous receipt's ID, file name, content type, size, and checksum, its claim, and its owner, who must be the history actor (the old attachment time is not compared with the removal time); and the retired record must be `REMOVED`. The transaction is the claim update at `previousClaim.version`, which removes the `receipt` attribute, the history entry, `retireReceiptOperation` at `history.occurredAt` (the builders enforce the retained metadata and the 30-day TTL), the cleanup outbox event, then the idempotency record. The one event must equal `buildReceiptDeletionEvent` for the removed receipt's final object, compared canonically with the same shared check as replacement, and `storedLastEventVersion` is kept. A category guard is refused, no category operation is written, and no S3 operation is performed. `deleteDraft(input, options)` commits the deletion of a never-submitted draft (access pattern A4, section 12). `input` names the claim, the actor, the deletion time `changedAt` (canonical and not before `claim.updatedAt`), and, only when the claim has a receipt, its attached record and a `REMOVED` retired record, which must match the claim receipt, claim, and owner. The transaction is `deleteDraftOperation` at `claim.version` (which enforces an owned `DRAFT` that was never submitted), `decrementClaimCountOperation` when the draft has a category, `retireReceiptOperation` at `changedAt` when it has a receipt, the `internal.claim-history-purge-requested` event, the `internal.receipt-object-deletion-requested` event when it has a receipt, then the idempotency record: at most six operations, with no guard or `ConditionCheck`. The events must be exactly those, in that order, with distinct IDs, and each must equal the event rebuilt by `buildHistoryPurgeEvent` or `buildReceiptDeletionEvent` from its own IDs, the actor, `changedAt`, the claim ID, the receipt's final object key, and `claim.version + 1` as the aggregate version, compared canonically. No history entry is written or deleted here and no lifecycle event is published; the cleanup worker purges history afterwards. A category guard is refused and no S3 operation is performed.

Every write method of the claim writer has a synchronous preparation counterpart: `prepareCreate`, `prepareUpdateDraft`, `prepareUpdateLifecycle`, `prepareSubmit`, `prepareAttachReceipt`, `prepareReplaceReceipt`, `prepareRemoveReceipt`, and `prepareDeleteDraft`. Each takes the same arguments as its write method, performs all of its validation and composition, and returns the `TransactWriteCommandInput` without executing anything; the write method then executes that prepared transaction once, so behavior, messages, ordering, tokens, and error propagation are unchanged. This lets an orchestration commit a prepared transaction through `DynamoDbIdempotentTransactionCommitter`, as `DynamoDbReceiptUploadWriter.preparePending` already allows. Neither the committer nor any service is wired to these methods yet.

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

The lookup in step 1, and the receipt metadata read in section 11, are implemented by `DynamoDbIdempotencyReader` and `DynamoDbReceiptMetadataReader` in `services/api/src/adapters/aws/dynamodb-lookups.ts`. Each sends one strongly consistent `GetItem` on the codec's key and decodes the item with its codec; a malformed item raises `ItemIntegrityError`, and SDK errors propagate unchanged. The idempotency lookup takes the current time in epoch seconds and treats a record with `expiresAt` before it as absent, while a record expiring exactly now is still returned, matching the `expiresAt < :nowEpoch` write condition, so it never depends on TTL deletion.

The conditional `Put` of step 5 is `DynamoDbRejectionWriter` in `services/api/src/adapters/aws/dynamodb-idempotency-writer.ts`. It accepts only `REJECTED` records and the current time in epoch seconds, encodes the record with the idempotency codec, and sends one `PutItem` with `attribute_not_exists(PK) OR expiresAt < :nowEpoch`. An existing record therefore blocks the write until its `expiresAt` is strictly before now, exactly where the lookup stops returning it. The new record must itself still be unexpired by the same rule, so one with `expiresAt` before now is refused, while one expiring exactly now is written. A rejection created now expires 24 hours later, so this only matters at the boundary. Invalid times and records are refused before any command is sent. `ConditionalCheckFailedException` and every other SDK error propagate unchanged; the strong reread that follows a failed condition belongs to the idempotency orchestration.

`DynamoDbIdempotencyCoordinator` in `services/api/src/adapters/aws/dynamodb-idempotency-coordinator.ts` is the first, isolated part of the orchestration: steps 1 and 5 only. It is built from the reader's `find` and the rejection writer's `recordRejection` and nothing else. `lookup(actorId, key, fingerprint, nowEpoch)` validates its inputs before any call, then returns `undefined` for an absent or expired record, the stored record for the same fingerprint (completed or rejected), and throws the existing `IdempotencyConflictError` with a fixed message for another fingerprint. `recordRejection(record, nowEpoch)` validates the record with the idempotency codec before any call and writes once. Only when the SDK reports `ConditionalCheckFailedException` (identified by error name, never by message) does it reread once with `find`: the same fingerprint returns the winner, whether it completed or was rejected; another fingerprint throws the conflict; and when no unexpired record is found the original conditional failure is rethrown unchanged. Every other dependency error propagates unchanged. Stored records are returned as stored and are not assumed to be permanent HTTP response snapshots, because receipt-upload results will store a reference.

The coordinator is not wired into any service, route, or runtime. Still deferred: executing the domain logic, handling the success transaction and its stored result, the recovery after a cancelled transaction below, the ambiguous-failure retry, the clock and ID inputs, logging, and the receipt-upload result reference. The local `Idempotency` class and the idempotency port are unchanged.

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

`DynamoDbIdempotentTransactionCommitter` in `services/api/src/adapters/aws/dynamodb-idempotent-transaction-committer.ts` is the isolated implementation of the two procedures above, without business-state recovery. `commit(transaction, completed, nowEpoch)` takes an already composed transaction, its `CompletedRequest`, and an explicit time. Before any call it checks that the record is codec-valid and not expired (a record expiring exactly now is still valid), that the transaction is exactly a composed one (only `TransactItems` and `ClientRequestToken`), that its last item is the completed idempotency `Put` of the supplied record with the section 9 condition, and that the `ClientRequestToken` equals the token derived from its items. It then sends the transaction once and returns the `COMPLETED` record. After `TransactionCanceledException` it only looks the idempotency record up (through the coordinator's `lookup`): a winner is returned as stored (completed, rejected, or a result reference), a fingerprint conflict propagates, and with no winner the original cancellation is rethrown, leaving the business-state recovery above to a later increment; cancellation reasons are never inspected. After an ambiguous failure (error names `InternalServerError`, `ServiceUnavailable`, `ServiceUnavailableException`, `TimeoutError`, `RequestTimeout`, `ThrottlingException`, `ProvisionedThroughputExceededException`, `RequestLimitExceeded`, or transport codes `ECONNRESET`, `ECONNABORTED`, `EPIPE`, `ETIMEDOUT`; never message text) it looks the record up, and with no winner retries the identical transaction, with the same items and `ClientRequestToken`, exactly once. If that retry fails with a cancellation or another ambiguous failure, one final lookup returns a winner or the retry failure is rethrown unchanged. Every other failure, such as `ValidationException`, `IdempotentParameterMismatchException`, or a programming error, propagates without a lookup or retry, and lookup errors propagate unchanged. It generates no ID or timestamp, rebuilds nothing, logs nothing, and maps nothing to HTTP.

The committer is not wired into any service, route, or runtime. Still deferred: the business-state recovery after a cancellation without a winner, the services that compose and commit transactions, and the HTTP error mapping and generic `500`.

`ReceiptUploadCoordinator` in `services/api/src/adapters/aws/receipt-upload-coordinator.ts` orchestrates the creation of a pending receipt upload from a prebuilt pending record, a prebuilt completed `201` result reference, and an explicit time; it is built from `DynamoDbReceiptUploadWriter.preparePending` (the synchronous composition that `createPending` now delegates to), the idempotency coordinator's `lookup`, `DynamoDbIdempotentTransactionCommitter.commit`, and `ReceiptUploadReplayResolver.resolve`. `create(pending, completed, nowEpoch)` validates both records through their codecs (unexpired, pending receipt owned by the completed result's actor, result referencing that receipt) before any call. It looks the key up first; a stored record is used as is, with no preparation or commit. Otherwise it prepares once, with no events and no category guard, and commits through the committer. The record that wins, whether this request's, an earlier one that references another receipt, or a concurrent rejection or snapshot, governs: a result reference is resolved into a fresh upload form, and a snapshot is returned intact without the resolver. The result is `{ record, upload? }` and does not say whether this request committed or replayed. A signing or resolution failure after the commit removes nothing, so a retry finds the stored reference through the lookup. Errors propagate unchanged, and the coordinator persists no rejection and adds no retry or recovery.

It is not wired into any service, route, or runtime. Still deferred: request authorization and validation, ID and time generation, the HTTP contract, business-state recovery after a cancellation, and persistence of rejections for this flow.

`ClaimMutationCoordinator` in `services/api/src/adapters/aws/claim-mutation-coordinator.ts` joins steps 1 to 3 for claim mutations, without any domain logic. `run(request, prepare)` takes `{ actorId, key, fingerprint, nowEpoch }` and a lazy async `prepare` callback that returns `{ transaction, completed }` (for example from a `DynamoDbClaimWriter.prepare…` method). It validates the request and the callback before any call, then looks the key up first: a stored record is returned without calling `prepare` or committing, and a fingerprint conflict propagates. Otherwise it calls `prepare` once, requires the completed request to pass the idempotency codec, to belong to the same actor, key, and fingerprint, to be unexpired (a record expiring exactly now is valid), and to be a response snapshot rather than a receipt reference, and commits the exact transaction and completed request once through `DynamoDbIdempotentTransactionCommitter`. The actual winning record is returned intact, including a concurrent rejection. Preparation and dependency errors propagate unchanged; it recovers no business state, retries nothing, generates no ID or timestamp, logs nothing, and maps nothing to HTTP.

**Explicit business rejections (step 5).** `prepare` may instead return `{ rejection }`, a `RejectedIdempotencyRecord` that the caller built explicitly. The coordinator requires exactly one of the two shapes (a rejection mixed with a transaction or completed request is refused), then requires the rejection to pass the idempotency codec, to be `REJECTED`, to belong to the request's actor, key, and fingerprint, and to be unexpired (exactly now is valid). It then calls `DynamoDbIdempotencyCoordinator.recordRejection` once and returns the record that call returns, which can be a concurrent completed or rejected winner; the race handling stays in that coordinator, so there is no extra lookup, retry, or commit, and a conflict or unresolved conditional failure propagates unchanged. A thrown domain or application error is never caught and turned into a response: the preparation must construct the rejection record itself.

It is not wired into any service or runtime. Still deferred: integration with the domain services that decide and build the change and their rejection records, the business-state recovery after a cancellation without a winner, and the wiring of any route.

`AwsClaimCreationService` in `services/api/src/adapters/aws/aws-claim-creation-service.ts` is the first domain use of these pieces: claim creation only, as an isolated service. `create(actor, input, context)` takes the trusted server-resolved `Actor`, the raw create input, and a context of idempotency key, fingerprint, canonical `now`, and request ID, all validated before any dependency call; the identity comes only from the actor, and `nowEpoch` and the 24-hour expiry are derived from `now` with the existing helpers. It runs through `ClaimMutationCoordinator`, so a replay returns the stored record before anything is parsed, read, generated, decided, or presented. Only inside the lazy preparation does it parse the input with `createClaimRequestSchema`, read the category through `getStored`, generate the claim ID, apply `createDraftClaim`, present the claim with the existing presenter and scoped user-directory reads, and call `DynamoDbClaimWriter.prepareCreate` with no events and, for a categorized claim, a `mustBeActive` guard at the category version it read. The stored result is `{ status: 201, body: ClaimDto }`, the body the current create route returns. Only expected business errors from parsing and the domain decision (schema, domain, and application errors that the HTTP error mapping turns into a client status) become an explicit `REJECTED` record, built with that same `toErrorReply` mapping and the request ID; dependency, codec, preparation, and programming failures propagate unchanged and store nothing. The result is the actual winning record, including a concurrent rejection or completed winner.

**Cancellation recovery.** When the commit of a prepared creation is cancelled (`TransactionCanceledException`, identified by SDK error name only; cancellation reasons and messages are never inspected), the service recovers within at most three prepared business-transaction commits per create, category rebuilds included. Every recovery attempt runs inside a coordinator run, so the idempotency record is rechecked first: a winner is returned and a fingerprint conflict propagates. It then strongly rereads every conditioned item: the generated claim ID, which must still be absent (a claim already at that ID without a stored result is a `ClaimCreationIntegrityError` with a fixed message, with no overwrite, no new ID, and no business rejection), and, for a categorized creation, the guarded category. A missing, inactive, or newer category re-runs the existing category and domain decision once with the reread category, the original claim ID, and the same context and retention: an invalid category persists the domain's normal business rejection, and a valid one rebuilds the presentation and commits the new transaction with its new guard and its own derived `ClientRequestToken`. A second category change persists `VERSION_CONFLICT` through the existing safe mapper. When the claim is still absent and the category (if any) unchanged, the same parsed input, claim ID, and context are prepared again (rereading the presentation data) and committed after an exponential backoff of 50 ms doubling up to 500 ms, with equal jitter from an injected random source and an injected sleep. After the third cancellation, one last idempotency and state check runs before exhaustion: a winner is returned first; a claim at the generated ID is an integrity failure; a category that changed after an earlier change was already re-evaluated is persisted as `VERSION_CONFLICT`; a category changed for the first time has the category and domain decision re-run with the reread category and the original inputs, which persists the normal business rejection (missing, inactive, and so on) and otherwise, with no commit left, falls through; and anything else is an unresolved cancellation, rethrown unchanged after the exhaustion log event, with no fourth commit and never labelled as a conflict. The injected `Logger` receives only `claim.create.retry` with `{ operation, retries }` and `claim.create.retries_exhausted` with the same fields; nothing else is logged, and no store, metric, or alarm resource exists. Reread, presentation, preparation, sleep, and final-check failures propagate unchanged and store no rejection. The committer's identical retry after ambiguous failures is unchanged.

Limitations that remain: the CloudWatch metric and alarm wiring for retries and exhaustion is deferred (only the structured log events exist), the other claim mutations have no AWS service yet, and the service is not wired into any route or composition; the existing `ClaimService` and local behavior are unchanged.

`AwsClaimDraftEditingService` in `services/api/src/adapters/aws/aws-claim-draft-editing-service.ts` applies the same pattern to draft edits, as an isolated service that no route uses. `update(actor, claimId, input, context)` takes the trusted `Actor`, the claim ID, the raw update, and the same request context as creation, and runs through `ClaimMutationCoordinator`, so a replay returns the stored record before the input is parsed or any claim, category, or user is read. Inside the lazy preparation it validates the claim ID, parses `updateClaimRequestSchema`, strongly reads the claim with its `lastEventVersion` (`getStored`), and applies the existing rules: a missing or invisible claim is the same `NOT_FOUND`, then `assertVersion`, then `updateDraftClaim` with its ownership and draft checks. The category policy is read only when the edit enters a different defined category, so an unchanged category stays editable even when inactive. It presents the claim with the existing presenter, stores `{ status: 200, body: ClaimDto }` (the body the current update returns), and calls `DynamoDbClaimWriter.prepareUpdateDraft` with the previous claim, the stored `lastEventVersion`, no events, and a `mustBeActive` guard at the version read only when entering a different defined category. Only expected input, access, and domain errors become explicit `REJECTED` records with the safe mapping and request ID; dependency, codec, presentation, and preparation failures propagate unchanged and store nothing. The actual winning record is returned.

**Cancellation recovery for edits.** A cancelled commit (`TransactionCanceledException`, by SDK error name only) is recovered within the same cap of three prepared commits per update, with the same injected sleep, random source, and `Logger` (`claim.update.retry` and `claim.update.retries_exhausted`, carrying only the operation and retry counts) and the same bounded, jittered backoff. Each attempt first rechecks the idempotency record (a winner is returned, a fingerprint conflict propagates), then strongly rereads every conditioned item. The claim is reread with its metadata and judged by the same rules as the first attempt: a missing or invisible claim is the `NOT_FOUND` rejection and a version other than the original `expectedVersion` is a persisted `VERSION_CONFLICT`, so an edit is never applied to a newer claim. The category whose counter is decremented (the source of a removal or switch) must still exist with `claimCount >= 1`, otherwise a `ClaimEditIntegrityError` with a fixed message is thrown, with no retry and no stored rejection. The guarded destination category, when entering one, is compared with the version used: a first change (missing, inactive, or newer) re-runs the domain decision with the reread category and persists its normal rejection or rebuilds the transaction with the new guard and token, and a second change is a persisted `VERSION_CONFLICT`. With unchanged state the same decision and presentation are rebuilt and retried. At exhaustion one last recheck and reread runs, with the creation service's distinction: a repeated destination change is `VERSION_CONFLICT`, a first change is decided once more (a rejection is persisted; a still valid edit with no commit left rethrows the unresolved cancellation after the exhaustion event, with no fourth commit), and unchanged state rethrows the cancellation unchanged. The expected version, inputs, actor, timestamps, retention, and stored event version are preserved, no ID is generated, and dependency and codec failures propagate unchanged and store no rejection.

Limitations that remain: metric and alarm wiring is deferred (only the structured log events exist), the lifecycle, receipt, and deletion mutations have no AWS service yet, and nothing is wired into a route or composition.

`AwsClaimSubmissionService` in `services/api/src/adapters/aws/aws-claim-submission-service.ts` covers first submission and resubmission after reopening, as an isolated service that no route uses. `submit(actor, claimId, input, context)` takes the trusted `Actor`, the claim ID, the raw action request, and the creation context plus a `correlationId`, validated before any dependency call; the request ID becomes the event's causation ID. It runs through `ClaimMutationCoordinator`, so a replay returns the stored record before anything is parsed, read, generated, or decided. Inside the lazy preparation it validates the claim ID, parses `claimActionRequestSchema`, strongly reads the claim with its `lastEventVersion`, applies the existing visibility rule (missing and invisible claims are the same `NOT_FOUND`) and `assertVersion`, reads the claim's category through `getStored`, and applies `submitClaim` (ownership, manager assignment, current policy, receipt threshold, and the resubmission rules). It presents the claim, stores `{ status: 200, body: ClaimDto }`, generates one event ID, builds the `claim.submitted` event with `buildClaimLifecycleEvent` (chained to the stored `lastEventVersion`), and calls `DynamoDbClaimWriter.prepareSubmit` with exactly that event and a `mustBeActive` guard at the category version read. Only expected input, access, and domain errors become explicit `REJECTED` records; dependency, codec, presentation, event-building, and preparation failures propagate unchanged and store nothing. The actual winning record is returned.

`AwsClaimSubmissionService` is now a thin entry point that delegates to `AwsClaimLifecycleService` (`services/api/src/adapters/aws/aws-claim-lifecycle-service.ts`), which covers all six lifecycle actions: SUBMIT, START_REVIEW, APPROVE, REJECT, REOPEN, and MARK_PAID. `perform(actor, claimId, action, input, context)` works exactly as described for submission: lazy preparation behind the idempotency lookup, `claimActionRequestSchema` (or `claimDecisionRequestSchema` with its required comment for APPROVE and REJECT), the existing visibility and version rules, the existing domain function of the action (so ownership, assigned-manager, self-review, payment, policy, and resubmission rules are those of `ClaimService.perform`), the same `200` `ClaimDto` snapshot, and one lifecycle event with a lazily generated event ID, the supplied correlation ID, and the request ID as causation ID. SUBMIT commits through `prepareSubmit` with the category guard; the other five commit through `prepareUpdateLifecycle` with no guard and no category read. Expected business errors become explicit rejections; infrastructure and programming failures propagate unchanged.

**Cancellation recovery for lifecycle actions.** A cancelled commit (by SDK error name only) is recovered within the same cap of three prepared commits per call, with the same injected sleep, random source, and `Logger` (`claim.lifecycle.retry` and `claim.lifecycle.retries_exhausted`, carrying only the route operation name and retry counts). Each attempt rechecks the idempotency record first, then strongly rereads the claim with its metadata (missing or invisible is `NOT_FOUND`, a version other than the original `expectedVersion` is `VERSION_CONFLICT`, so the action is never applied to a newer claim). For SUBMIT it also rereads the guarded category with the established rule: a first change re-runs the domain decision with the reread category (a rejection is persisted, a valid one is rebuilt with the new guard), and a second change is a persisted `VERSION_CONFLICT`. Unchanged state rebuilds the decision and presentation and retries after a bounded, jittered backoff. The event ID is generated once per call and reused by every rebuild, and the actor, input, expected version, context, and retention never change. At exhaustion the same recheck and rereads run: a winner is returned, a repeated category change is `VERSION_CONFLICT`, a first change is decided once more (a rejection is persisted), and otherwise the last cancellation is rethrown unchanged after the exhaustion event, with no fourth commit and no invented conflict.

Limitations that remain: metric and alarm wiring is deferred (only the structured log events exist), the receipt and deletion mutations have no AWS service yet, and nothing is wired into a route or composition.

**Opt-in request pipeline integration (`POST /claims`).** The transport-neutral pipeline in `services/api/src/http/api-handler.ts` has one new, optional seam: `ApiHandlerOptions.mutations`, a map from a route operation (for example `claim.create`) to an `IdempotentMutation`, and an optional `now` clock. When an idempotent route has an entry, the pipeline still authenticates the actor, reads the body within the existing limits, validates the `Idempotency-Key` header, and computes the existing fingerprint, then calls the mutation with the actor, the parsed JSON body, the key, the fingerprint, the canonical server time, and the server-generated request and correlation IDs, and replies with the `{ status, body }` it returns. It then does not run the route handler or the local `Idempotency.begin`, `complete`, or `abandon`, and, because the coordinator cannot say whether the request committed or replayed, it sets no `Idempotent-Replayed` header. An operation without an entry keeps the route handler and the local idempotency, and an entry never falls back to the local path: a failure is converted by the existing error mapping (a generic `500` for infrastructure failures, which are logged by the existing request log without the body, key, or fingerprint). `claimCreationMutation` (`services/api/src/adapters/aws/claim-creation-mutation.ts`) adapts `AwsClaimCreationService` to this seam and refuses a result reference as a programming error; no persistence type reaches the browser contracts. The seam also carries the matched route's decoded path parameters (`params`), never taken from the body. `services/api/src/adapters/aws/claim-mutations.ts` holds all the adapters: `claimCreationMutation`, `claimEditMutation` (`claim.update`, with the claim ID from `params.claimId`), and `claimLifecycleMutations`, which registers the six lifecycle operations (`claim.submit`, `claim.start-review`, `claim.approve`, `claim.reject`, `claim.reopen`, `claim.mark-paid`) on the server, each bound to its own action, so neither the action nor the identity nor the claim ID can come from the body (the strict request schemas refuse such fields). Each adapter forwards the existing server context (key, fingerprint, time, request ID, and for lifecycle actions the correlation ID), and a shared `storedResponse` returns the stored `{ status, body }` and refuses an unexpected result reference as a programming error. The seam is exercised only by tests through `ApiHandler` with fake AWS dependencies, for creation, draft editing, all six lifecycle actions, receipt attachment and replacement, receipt removal, and draft deletion. The last three are bound by `receiptAttachMutation` (`receipt.attach`, `PUT /claims/:claimId/receipt`), `receiptRemoveMutation` (`receipt.remove`, `DELETE /claims/:claimId/receipt`), and `claimDeleteMutation` (`claim.delete`, `DELETE /claims/:claimId`), which take the claim ID only from the route parameters and forward the server-generated context, including the correlation ID of the cleanup events; the stored `200` snapshots and the `204` are returned unchanged, replay is answered from the stored record, and a registered mutation never falls back to the local handler. Deletion triggers no direct cleanup: the services have no S3 or history-purge capability, and the cleanup worker acts on the events.

**Receipt download (AWS path only).** `AwsReceiptDownloadService` (`services/api/src/adapters/aws/aws-receipt-download-service.ts`), registered as the opt-in read `receipt.read` through `receiptDownloadRead`, serves the documented `GET /claims/:claimId/receipt` reply `{ "url", "expiresAt" }`. It loads the claim with the existing visibility rule (a claim the actor cannot see is a missing one, and a claim without a receipt is `NOT_FOUND` with the local message), requires the receipt metadata to be the `ATTACHED` record of this claim, owned by its employee, with the claim's file name (a record that contradicts the claim is a fixed integrity error and a generic `500`, never a URL), and asks `S3DownloadUrlGenerator` for the five-minute presigned `GET` URL for `receipts/<receiptId>`, signed locally. The reply carries `Cache-Control: no-store` because the URL is a short-lived capability. The local binary download is unchanged and remains the behavior wherever the read is not registered. Upload contracts, production composition, and resources are unchanged. The production composition, the Lambda entry point, API Gateway, and every other endpoint are unchanged, so no deployed behavior uses it yet.

**Opt-in claim reads.** The five claim reads (`claim.get`, `claim.history`, `claim.list_mine`, `claim.list_review_queue`, and `claim.list_all`) can be served from DynamoDB through a second optional seam, `ApiHandlerOptions.reads`, a map from a non-idempotent route operation to a `ReadOperation` that receives the authenticated actor, the decoded path parameters, and the query. A registered read replaces the route handler and never falls back to it (an unauthenticated actor is refused, never routed locally), and an operation without an entry is unchanged. `claimReadOperations` (`services/api/src/adapters/aws/claim-reads.ts`) parses the path parameter and query exactly as the routes do (`idSchema` giving `NOT_FOUND`, `claimListQuerySchema`, `adminClaimListQuerySchema`) and calls the new `ClaimQueryService` (`services/api/src/application/claim-query-service.ts`). That service is the five read methods moved out of `ClaimService`, which now delegates to it, so the local runtime and the AWS readers share one set of role restrictions, invisible-as-missing behavior, pagination, and presentation; it needs only the repository's read methods, the category list, and the scoped user lookups, which `DynamoDbClaimReader`, `DynamoDbCategoryReader.list`, and the user directory provide. Response shapes, cursors, and local defaults are unchanged, and the production composition does not register the reads, so nothing deployed uses them yet.

**Receipt upload target flow.** `AwsReceiptUploadTargetService` (`services/api/src/adapters/aws/aws-receipt-upload-target-service.ts`) is the application flow of section 11, "Upload": `create(actor, input, context)` turns a declaration `{ fileName, contentType, sizeBytes, checksumSha256 }` into pending receipt metadata, an idempotency record that holds only the reference `{ status: 201, resultRef: { receiptId } }`, and a fresh presigned upload form, as an isolated flow that no route, composition, or browser contract uses yet (the raw-byte local `POST /receipts` is unchanged). It runs through `ReceiptUploadCoordinator.run(request, prepare)`, the lazy counterpart of `create`: the key is looked up first (a stored record is used as is, a fingerprint conflict propagates), and only then is the preparation called, once. Inside it the service checks that the actor is an employee, parses the declaration with a strict schema (so no owner, identity, receipt ID, or upload time can come from the input), applies the existing receipt rules (`validateReceiptFile`, the checksum rule) and `sanitizeFileName`, and only then generates the receipt ID and builds the pending record with the actor as owner and the request time as upload time and a 24-hour expiry. The coordinator validates the candidate through the codecs and commits it with `DynamoDbReceiptUploadWriter.preparePending` through the idempotent committer, then resolves whichever record governs with `ReceiptUploadReplayResolver`: this request's, a replay's, or a concurrent winner's, which can reference another receipt. Expected authorization and declaration errors become explicit `REJECTED` records through the same safe mapping as the claim services and are stored through the idempotency coordinator (`recordRejection`, which returns a concurrent winner); a replayed rejection has no form. Dependency, codec, and signing failures propagate unchanged and store nothing as a rejection, and a signing failure after the commit leaves the metadata in place so that a retry recovers through the lookup. Neither the URL nor any form field is persisted.

Limitations that remain: no cancellation-state recovery for this flow (an unresolved cancellation propagates unchanged), no HTTP route or composition, and the attach, replace, and remove flows that verify and promote the object are still to be built.

**Receipt attachment and replacement flow.** `AwsReceiptAttachmentService` (`services/api/src/adapters/aws/aws-receipt-attachment-service.ts`) implements section 11, "Attach or replace", as an isolated service that no route or composition uses yet (the local attach, the routes, and the production composition are unchanged). `attach(actor, claimId, input, context)` runs through `ClaimMutationCoordinator`, so a replay returns the stored claim snapshot before the input is parsed, before any claim or receipt is read, and before any object is inspected or promoted. Inside the lazy preparation the order is: validate the claim ID and parse the strict `attachReceiptRequestSchema`; strongly read the claim and apply the visibility and `expectedVersion` rules; apply the domain's owner-and-draft rule (`assertEditable`, now exported by the domain package, so a non-owner gets `FORBIDDEN` before any receipt is touched); strongly read the receipt metadata, which must be a `PENDING`, unexpired (exactly at its expiry is still valid) receipt owned by the actor, otherwise the existing `RECEIPT_UNAVAILABLE` rejection; for a replacement read the old receipt's metadata, which must be `ATTACHED` to this claim and owned by its employee (otherwise a `ReceiptAttachmentIntegrityError` with a fixed message, with no rejection stored); inspect the pending object with `S3ReceiptInspector` (a missing or unverifiable object is `RECEIPT_UNAVAILABLE`); apply the existing domain rule `attachReceipt` to the measured values, so the declared size, type, and checksum must equal the measured ones; promote the object to `receipts/<id>` with `S3ReceiptObjects.promote`; present the claim; and prepare one transaction with `prepareAttachReceipt` (claim update, history, the receipt's `ATTACHED` update, idempotency snapshot) or, when the claim already has another receipt, `prepareReplaceReceipt` (additionally the old receipt's `REPLACED` metadata with its 30-day expiry and the cleanup event for the old object, whose single event ID is generated once per call). Expected input, access, domain, and receipt-availability errors become explicit `REJECTED` records; dependency, codec, and S3 failures propagate unchanged and store nothing.

Only after the result is confirmed, meaning the winning record is a completed snapshot whose claim holds the receipt that this call promoted, is the pending object deleted, best effort and with a safe log if it fails; the lifecycle rule removes a leftover within a day. The promoted final object is never deleted by this flow, so after an uncertain outcome the janitor's recovery of `receipts/<id>` and `uploads/pending/<id>` stays intact, and a replay or a concurrent winner for another receipt deletes nothing.

A cancelled commit is recovered within the same cap of three prepared commits, with the injected sleep, random source, and `Logger` (`receipt.attach.retry` and `receipt.attach.retries_exhausted`, carrying only the operation and retry counts). Each attempt rechecks the idempotency record first, rereads the claim (a missing or invisible claim is `NOT_FOUND`, another version is `VERSION_CONFLICT`), rereads the receipt (no longer pending, owned, or unexpired is `RECEIPT_UNAVAILABLE`), then re-inspects, re-promotes (the copy repeats onto the same key), and rebuilds after a bounded, jittered backoff. At exhaustion the claim and receipt checks run once more, a winner is returned, and otherwise the last cancellation is rethrown unchanged. No category is involved. Limitations that remain: metric and alarm wiring, the removal flow, the download flow, and every route and composition are still to be built.

**Removal flows.** `AwsReceiptRemovalService` and `AwsDraftDeletionService` (`services/api/src/adapters/aws/aws-claim-removal-services.ts`) implement the "Remove" step of section 11 and the draft deletion of sections 8 and 12 as isolated services that no route or composition uses yet. Both run through `ClaimMutationCoordinator`, so a replay returns the stored result before anything is parsed or read. Receipt removal returns the updated claim (`200`, the body the local flow returns); draft deletion returns `204` with no body. Inside the lazy preparation each validates the claim ID, parses its strict request (`claimActionRequestSchema`, `deleteRequestSchema`), strongly reads the claim, applies the visibility and `expectedVersion` rules and the existing domain rule (`removeReceipt`, `assertMayDeleteClaim`, so a missing receipt, a non-owner, a non-draft, and a once-submitted draft are the usual business rejections), reads the record of the claim's receipt, which must be `ATTACHED` to this claim and owned by its employee, and prepares one atomic transaction through the claim writer: for removal the claim update, history, the receipt's `REMOVED` metadata with its 30-day expiry, the `internal.receipt-object-deletion-requested` event, and the idempotency result; for deletion the claim delete, the category counter decrement when the draft has a category, the receipt's `REMOVED` metadata when it has a receipt, the `internal.claim-history-purge-requested` event, the receipt-deletion event when it has a receipt, and the idempotency result (at most six operations). Neither service has any S3 or history-purge capability: the cleanup worker deletes the object and purges the history from the events. Event IDs are generated once per call. A receipt record that contradicts the claim, or a category counter that is missing or below one, is a `ClaimRemovalIntegrityError` with a fixed message, with no retry and no stored rejection.

A cancelled commit is recovered within the same cap of three prepared commits, with the injected sleep, random source, and `Logger` (`receipt.remove.retry`, `claim.delete.retry`, and their `retries_exhausted` events, carrying only the operation and retry counts). Each attempt rechecks the idempotency record first, then rereads the conditioned state: the claim (a missing or invisible claim is `NOT_FOUND`, another version is `VERSION_CONFLICT`), the receipt record, and for deletion the category counter, then rebuilds with the same event IDs, context, and retention after a bounded, jittered backoff. At exhaustion the same checks run, a winner is returned, and otherwise the last cancellation is rethrown unchanged. Limitations that remain: metric and alarm wiring, the download flow, and every route and composition are still to be built.

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

**Persistence of the reference.** `CompletedRequest.response` is a `PersistedResult` (`services/api/src/application/commit.ts`): either the existing `{ status, body }` snapshot or a `StoredResultReference`, `{ status: 201, resultRef: { receiptId } }` with no body. The two shapes are mutually exclusive, and the local `StoredResponse`, `Idempotency`, and `IdempotencyStore` contracts are unchanged. The idempotency codec encodes and decodes the reference exactly: the response map allows only `status`, `body`, and `resultRef`; a reference holds exactly one valid `receiptId`, has no body, and is valid only for a `COMPLETED` record with status 201. A `REJECTED` record stays a snapshot (the rejection writer and coordinator accept only snapshots), and mixed shapes, unknown reference fields, missing or invalid IDs, other statuses, and rejected references are refused with fixed messages that carry no stored value. Snapshots, `204` results, the size and depth limits, expiry, and previously stored items are unaffected. `composeBusinessTransaction` and `DynamoDbReceiptUploadWriter.createPending` store the reference in the idempotency item of the same transaction as the pending receipt; no upload URL or form field is part of any persisted item, and the coordinator returns reference records intact from a lookup or a lost race.

**Replay resolution.** `ReceiptUploadReplayResolver` in `services/api/src/adapters/aws/receipt-upload-replay-resolver.ts` turns such a record back into an upload form. `resolve(record, nowEpoch)` accepts only an unexpired `COMPLETED` record with a result reference (checked through the idempotency codec; a record expiring exactly now is still present), reads the referenced receipt once with the strongly consistent metadata reader, and requires the returned receipt to be the referenced one (otherwise an integrity error with a fixed message), `PENDING`, owned by the record's actor, and not expired (`expiresAt < nowEpoch` is expired). A missing, expired, non-pending, or foreign receipt raises the existing `VALIDATION_FAILED` error with the `RECEIPT_UNAVAILABLE` detail, without saying which. It then calls the form generator once with that same pending record, so the original upload conditions are kept, and returns `{ receiptId, form }`; it defines no HTTP response. It writes nothing, touches no object, retries nothing, generates no ID or metadata, and never stores, caches, logs, or prints a form. Dependency errors propagate unchanged.

**Deferred.** First-time upload orchestration (creating the pending record, form, and stored reference), transaction recovery, and the wiring of any service or route are not implemented; the resolver is unwired, nothing creates these records yet, and no stored data is migrated.

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

`S3UploadFormGenerator` in `services/api/src/adapters/aws/s3-upload-form.ts` produces this form for a `PENDING` receipt record. It validates the record with the receipt codec before signing, builds exactly the conditions above for the configured bucket and the key `uploads/pending/<receiptId>`, converts the declared checksum from lower-case hexadecimal to base64, and asks an injected signer once for a form valid for 15 minutes. It rejects a non-`PENDING` record, a missing bucket name, and signer output that is not an HTTPS URL with string fields that keep the requested key, type, and checksum and carry a policy and signature. Errors never contain file names or checksums. The real signer, `createS3UploadFormSigner`, signs locally with the S3 client's credentials and sends no request; nothing is uploaded or inspected here.

`S3ReceiptInspector` in `services/api/src/adapters/aws/s3-receipt-inspector.ts` performs step 4 for a validated `PENDING` record, after checking the bucket name and the record. It sends `HeadObject` with checksum mode enabled for `uploads/pending/<receiptId>`, requires the length, content type, and stored SHA-256 checksum to equal the declaration, and only then sends one `GetObject` with `Range: bytes=0-15`. A ranged response without a body, or longer than 16 bytes, is refused, so the whole object is never read. The domain's `detectReceiptContentType` must report the declared type for those bytes. It returns the measured upload with the record's ID, owner, file name, and upload time. A missing object (error name `NotFound` or `NoSuchKey`, or HTTP status 404, never message text), a mismatch, or an unusable range raises `ReceiptUnavailableError`, whose fixed message names no bucket, key, file name, or value; other SDK failures propagate unchanged. It uploads, copies, deletes, and modifies nothing.

`S3ReceiptObjects` in `services/api/src/adapters/aws/s3-receipt-objects.ts` provides the object steps of sections 11 and 12, each repeatable and none wired to a service yet. `promote` sends one `CopyObject` from `uploads/pending/<id>` to `receipts/<id>` in the receipt bucket, with the content metadata copied and a SHA-256 checksum requested, and requires the result's checksum to equal the declared one; a missing source, or a missing or different checksum, raises `ReceiptUnavailableError`, and other S3 failures propagate unchanged. `deletePending` and `deleteFinal` each send one `DeleteObject` for the validated receipt ID and succeed when the object is already gone. The bucket and record or ID are validated before any command, and the pending object is left for the caller to delete. Nothing retries, logs, or reads objects.

`S3DownloadUrlGenerator` in `services/api/src/adapters/aws/s3-download-url.ts` creates the download URL for an attached receipt. It validates the bucket, the receipt ID, and that the file name already equals its sanitized form, then reads the injected clock once and asks the injected signer, once, for a `GetObject` URL for `receipts/<receiptId>` valid for five minutes. The response asks the browser to show the file `inline` under its own name, using `contentDisposition` (`services/api/src/application/content-disposition.ts`), which the local API's receipt download also uses. It returns the URL and an `expiresAt` exactly five minutes after the captured time, and rejects a signer result that is not a non-empty HTTPS URL. Its errors name no bucket, key, receipt ID, or file name. The real signer, `createS3DownloadSigner`, signs the request locally with SigV4 and sends nothing to S3.

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

`createReceiptJanitorHandler` in `services/api/src/adapters/aws/receipt-janitor-handler.ts` is this handler as a factory over `S3ReceiptObjects`, without a client or any AWS resource. A record is a cleanup candidate when it is a `REMOVE` made by `dynamodb.amazonaws.com` as a `Service`; every candidate needs a sequence number, or the handler throws and Lambda retries the batch. A candidate's `OldImage` is unmarshalled; items that are not pending `Receipt` records are ignored, and a pending receipt is validated strictly by the receipt codec. For each valid one, `deleteFinal` and `deletePending` are both attempted whatever the other does. Records are independent: a missing or malformed image or a failed deletion fails only that record, and the response is `{ batchItemFailures: [] }` or the first failed sequence number in stream order. The only thrown message is fixed and names no value.

### Receipt janitor infrastructure

`services/api/src/adapters/aws/receipt-janitor-lambda.ts` is the janitor's Lambda entry point. It reads `CLAIMFLOW_RECEIPT_BUCKET_NAME` (failing to load when it is missing), builds the S3 client once outside the handler, wires `S3ReceiptObjects` into `createReceiptJanitorHandler`, and exports only `handler`. The stack bundles it exactly like the other functions (esbuild, the `source` export condition, the pinned AWS SDK).

- **Function:** `claimflow-receipt-janitor`, Node.js 24, ARM64, 256 MB, 60-second timeout, tracing disabled.
- **Logs:** `/aws/lambda/claimflow-receipt-janitor`, retained for 30 days.
- **Execution role:** its own role, allowing only log writes to that group; `s3:DeleteObject` on `receipts/*` and `uploads/pending/*` in the receipt bucket (not the bucket itself); `dynamodb:DescribeStream`, `GetRecords`, `GetShardIterator`, and `ListStreams` on the table stream ARN; and `sqs:SendMessage` (with the queue attribute and URL lookups) on the failure queue. It has no permission on table items or indexes.
- **Failure queue:** `claimflow-receipt-janitor-failures`, a standard queue with SQS-managed encryption, TLS enforced, and 14-day retention. It receives the metadata of stream batches that exhausted their retries or expired.
- **Event-source mapping:** the table stream, starting at `LATEST`, batch size 10, `ReportBatchItemFailures`, batch bisection on error, 5 retry attempts, maximum record age 24 hours, the failure queue as the on-failure destination, and the filter shown above.

The table stream now has two consumers, the outbox publisher and the receipt janitor. These resources are deployed in `ap-southeast-1`. The scheduled outbox sweeper is deployed as well. The AWS application runtime does not exist yet, so nothing creates pending receipt records and the janitor stays idle.

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

`DynamoDbHistoryPurger` in `services/api/src/adapters/aws/dynamodb-history-purger.ts` is the purge itself, without the SQS handler or any client. `purge(claimId)` validates the table name and claim ID before any command, then queries the claim partition for `HISTORY#` keys, strongly consistent, ascending, keys only, with no filter or index, following every page, including empty pages that carry a continuation key. Each page is checked before anything on it is deleted: a returned item must have exactly `PK` and `SK`, the claim's partition, and `HISTORY#` plus ten digits, or `HistoryPurgeError` is raised. Keys are deleted with `BatchWriteItem` in batches of at most 25, resending only `UnprocessedItems` with capped exponential backoff and an injectable sleep, and failing with `HistoryPurgeError` after six attempts. Purging a claim with no history, or purging twice, succeeds. SDK errors propagate unchanged, and the error messages are fixed and name no table, claim, or key.

`createCleanupWorkerHandler` in `services/api/src/adapters/aws/cleanup-worker-handler.ts` is the cleanup worker's SQS handler over `S3ReceiptObjects` and `DynamoDbHistoryPurger`, without a client or any AWS resource. Before any cleanup, every record must have a non-empty message ID, or the handler throws a fixed error. Each body is parsed as the EventBridge event an SQS target receives: the standard fields only (plus an optional `replay-name`), with `version = 0`, a non-empty `id` and `region`, an account of exactly 12 digits, an RFC 3339 `time` with or without fractional seconds, string `resources`, a non-empty `replay-name` when present, `source = claimflow.api`, and a `detail-type` equal to the embedded event's type. The `detail` is validated by `parseOutboxEnvelope`, which applies the outbox codec's rules to the whole envelope and payload, and must be one of the two internal cleanup events. `internal.receipt-object-deletion-requested` deletes `receipts/<receiptId>` only, and `internal.claim-history-purge-requested` purges the claim's history. Both are idempotent, so duplicate deliveries need no deduplication record. Each record is independent: invalid input or a failed operation fails only that message, and the response lists every failed message ID in batch order and no successful one. No error message includes a body, ID, key, or dependency error.

`services/api/src/adapters/aws/cleanup-worker-lambda.ts` is the Lambda entry point. It reads `CLAIMFLOW_TABLE_NAME` and `CLAIMFLOW_RECEIPT_BUCKET_NAME` (failing to load when either is missing), builds the S3, DynamoDB, and DynamoDB document clients once outside the handler, wires them into `S3ReceiptObjects`, `DynamoDbHistoryPurger`, and `createCleanupWorkerHandler`, and exports only `handler`. The stack bundles it with `NodejsFunction` and esbuild, using the workspaces' `source` export condition so no prebuilt `dist` files are needed, and bundles the pinned AWS SDK instead of the runtime's copy. The function is `claimflow-cleanup-worker`: Node.js 24, ARM64, 256 MB, 60 seconds, tracing disabled (active tracing would add an X-Ray permission to the role). Its own log group `/aws/lambda/claimflow-cleanup-worker` keeps logs for 30 days. Its execution role allows only log writes to that group, SQS consumption of `claimflow-cleanup`, `dynamodb:Query` and `dynamodb:BatchWriteItem` on the table ARN (not its indexes), and `s3:DeleteObject` on `receipts/*` in the receipt bucket (not pending uploads or the bucket itself). An event-source mapping reads the cleanup queue in batches of 10, with no batching window and partial batch failure reporting; the six-minute queue visibility timeout and the redrive after five receives are unchanged, and the dead-letter queue is not an event source. The function, role, log group, and mapping are deployed in `ap-southeast-1`.

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

`services/api/src/adapters/aws/dynamodb-cursor.ts` encodes and validates cursors; an invalid cursor produces the same `ValidationError` with `INVALID_CURSOR` as the local runtime, before any query is sent. The claim read adapter, `DynamoDbClaimReader` in `services/api/src/adapters/aws/dynamodb-claim-reader.ts`, implements A1 and A5–A10, and `DynamoDbCategoryReader` implements C1 and C2. Each reader uses `GetItem` and `Query` only, decodes every item with the item codecs (section 7), and matches the repository read methods; write methods are not implemented in the readers. A page query asks for `limit + 1` items and keeps querying from `LastEvaluatedKey` when DynamoDB returns a partial response, so a page is full whenever more items exist. Its cursor is the key of the last item returned, never of the look-ahead item. Category listing reads every page of the bounded `CATEGORIES` partition.

`DynamoDbClaimReader.getStored(claimId)` returns the decoded claim together with its persistence metadata (`lastEventVersion`, absent when the item has none, and kept when zero) from the same single strongly consistent `GetItem`, so that future write orchestration has both the claim and the event version its write must chain from without a second read; nothing is inferred when the attribute is absent. `get(claimId)` unwraps `getStored` and still returns only the domain claim, and the list methods are unchanged. `getStored` is not wired into any service yet.

`DynamoDbClaimReader` validates its client and table name at construction, and the claim, category, employee, and manager IDs, the runtime claim status, the page limit, and the cursor before any command, with fixed messages that name no supplied value. A direct claim lookup that decodes to a different claim ID fails with `ItemIntegrityError`. The client and option types, the constructor checks, and the look-ahead page query shared by the readers are in `dynamodb-read-support.ts`, which imports no reader; `dynamodb-readers.ts` only re-exports both readers and the types, so existing imports keep working. SDK and codec errors propagate unchanged, and only `GetItem` and `Query` are ever sent.

`DynamoDbCategoryReader.getStored(categoryId)` returns the decoded category together with its persistence metadata (`claimCount` and the optional `lastEventVersion`, kept as decoded, so an absent version stays distinct from zero) from the same single strongly consistent `GetItem`, giving future write orchestration the category, its counter, and the event version to chain from without a second read. `get(categoryId)` unwraps `getStored` and still returns only the domain category with one request, and `list` still returns domain categories only. `getStored` is not wired into any service yet.

`DynamoDbCategoryReader` has its own module, `services/api/src/adapters/aws/dynamodb-category-reader.ts` (re-exported by `dynamodb-readers.ts`). It validates the table name at construction and the category ID before any command, with fixed messages that name no value. `get` sends one strongly consistent `GetItem` and fails with `ItemIntegrityError` if the stored item is not the requested category; `list` queries `PK = CATEGORIES` with `begins_with(SK, CATEGORY#)` on the base table, ascending, strongly consistent, never a `Scan`, follows every `LastEvaluatedKey`, and fails with a fixed message if a continuation key repeats. Both return domain categories without `claimCount` or other persistence metadata, and SDK and codec errors propagate unchanged. Category writes are implemented separately by `DynamoDbCategoryWriter` but are not wired into services or composition.

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

`buildClaimLifecycleEvent` in `services/api/src/application/claim-events.ts` builds the one event of a lifecycle change (`SUBMIT`, `START_REVIEW`, `APPROVE`, `REJECT`, `REOPEN`, `MARK_PAID`) and returns nothing for draft and receipt changes. The caller supplies the event, correlation, and causation IDs and the claim's stored `lastEventVersion`; the actor and time come from the history entry. The change's IDs, versions, and statuses must agree with the domain's transition table. The previous event version is `null` when the stored value is absent or zero, and otherwise a whole number below the new version. The payload holds only the claim, employee, assigned manager, category, and amount, plus `submittedAt`, `reviewedAt`, or `paidBy` and `paidAt` where the event catalog lists them; a change missing a required field raises `ClaimEventError`, whose messages name no values. The same module's `isPublishableAction` is the classifier the DynamoDB claim operation builder uses to decide whether to set `lastEventVersion`.

`buildReceiptDeletionEvent` and `buildHistoryPurgeEvent` in `services/api/src/application/cleanup-events.ts` build the two internal cleanup events. Both use the claim as the aggregate, the claim version of the requesting mutation, and `previousEventVersion: null`, and the caller supplies the event, correlation, and causation IDs, the actor, the occurrence time, and the version. The receipt deletion payload is `claimId`, `receiptId`, and the object key, which must be `receipts/<receiptId>`; the purge payload is `claimId` alone. IDs, the canonical timestamp, and the positive safe version are validated, and `CleanupEventError` uses fixed messages that never echo a supplied value.

The category builders in `services/api/src/application/category-events.ts` produce `category.created` (version 1, with the active state and all policy fields), `category.policy-changed` (only the policy fields that changed), `category.activated` or `category.deactivated`, and `category.deleted` (one version after the stored category). An update can yield a policy event and then an activation event, in that order, at the same new version, with distinct caller-supplied event IDs and the same previous event version; a change to the name alone yields none, because names are excluded from payloads. Updates require the same category, exactly one version increase, and an unchanged creation time. Previous event versions follow the claim rule, IDs and timestamps are validated, and `CategoryEventError` uses fixed messages that never echo a value.

`DynamoDbOutboxState` in `services/api/src/adapters/aws/dynamodb-outbox-state.ts` implements the publisher's two item operations. `get` validates an event, derives its outbox key, reads the item with a strongly consistent `GetItem`, and returns the strictly decoded event and state, or `undefined`. `markPublished` validates the event and a canonical `publishedAt` not before `occurredAt`, then sends one `UpdateItem` that sets `state = PUBLISHED`, `publishedAt`, and an `expiresAt` exactly seven days later and removes `GSI4PK` and `GSI4SK`, conditioned on `#state = :pending`. A failed condition, which means another path already published the event, and every other SDK error propagate unchanged; treating them as a skipped duplicate belongs to the publisher. The sweeper query and the publishing itself are separate increments.

`DynamoDbPendingOutbox` in `services/api/src/adapters/aws/dynamodb-pending-outbox.ts` is the sweeper's query (access pattern O1). `listPending(cutoff, limit)` sends one eventually consistent `Query` on `GSI4` for `GSI4PK = OUTBOX#PENDING` and `GSI4SK < <cutoff>`, oldest first, with `Limit` between 1 and 10 and no filter, scan, or pagination cursor. Because `GSI4SK` is `<occurredAt>#<eventId>`, an event that occurred exactly at the cutoff is not returned. Every item is decoded strictly by the outbox codec, and one that is not pending raises `ItemIntegrityError`. The table name, a canonical cutoff, and the limit are validated before any command, and SDK errors propagate unchanged. The schedule, the publishing, and the handlers are separate increments.

`EventBridgePublisher` in `services/api/src/adapters/aws/eventbridge-publisher.ts` performs the `PutEvents` call of the publisher and sweeper. `publish` takes 1 to 10 outbox events, validates each with the outbox codec, and sends one `PutEventsCommand` whose entries, in input order, have the injected bus name, `Source = claimflow.api`, `DetailType` equal to the event type, and the complete JSON envelope as `Detail`. An empty or oversized batch, an invalid event, or a missing bus name sends nothing. The SDK result is returned unchanged, so the workflow can read `FailedEntryCount` and the per-entry errors; the adapter does not retry, mark events published, or log, and SDK errors propagate unchanged.

`OutboxPublication` in `services/api/src/adapters/aws/outbox-publication.ts` is the publisher workflow, independent of Lambda event types. It takes 1 to 10 records, each with a unique non-empty sequence number and an outbox event. It rereads every event strongly consistently and skips missing or already published items; the pending ones are published, as their stored versions, in one ordered `PutEvents` batch. EventBridge's entries are matched to events by index. Each successful entry is marked published with one clock reading taken after publishing, and a failed condition while marking is ignored because another path already completed it. A failed read, a failed publish call, a failed mark, an entry with an error, and any unreliable answer (missing, mis-sized, or contradicting `FailedEntryCount`) fail only the records concerned; failed and ambiguous entries are never marked. If nothing is pending, EventBridge is not called. The workflow throws only for an invalid batch and otherwise returns the first failed sequence number in batch order, or none, which the stream handler reports as `batchItemFailures`.

`createOutboxStreamHandler` in `services/api/src/adapters/aws/outbox-stream-handler.ts` turns the workflow into a DynamoDB Streams handler, without creating a Lambda entry point or any client. It takes the records the mapping's filter admits (an `INSERT` whose `SK` starts with `OUTBOX#`), ignores any others, and requires at most 10 relevant records and a sequence number on each; otherwise it throws so Lambda retries the whole batch. Each `NewImage` is unmarshalled and decoded strictly by the outbox codec; a record whose image is missing or malformed is reported as failed without stopping the others. The decoded events go to the workflow in stream order, and the response holds `{ batchItemFailures: [] }` or one entry for the first failed sequence number in stream order, chosen from the decoding failures and the workflow's result.

`createOutboxSweeper` in `services/api/src/adapters/aws/outbox-sweeper.ts` is the scheduled sweeper's handler, without a client or any AWS resource. Each invocation reads the clock once, subtracts the five-minute grace period to form a canonical cutoff, and makes one query for up to 10 pending events older than it. With none, it returns `{ selected: 0 }` and does not call the workflow. Otherwise it passes the events to `OutboxPublication` in query order, using each event ID as the unique sequence identifier. If the workflow reports a failure, the sweeper throws `OutboxSweepError`, whose fixed message names no event, so the scheduled invocation is retried; otherwise it returns `{ selected: <count> }`. Query and clock errors propagate unchanged. It does not loop, retry, or log.

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

### Publisher infrastructure

`services/api/src/adapters/aws/outbox-publisher-lambda.ts` is the publisher's Lambda entry point. It reads `CLAIMFLOW_TABLE_NAME` and `CLAIMFLOW_EVENT_BUS_NAME` (failing to load when either is missing), builds the DynamoDB, DynamoDB document, and EventBridge clients once outside the handler, wires `DynamoDbOutboxState`, `EventBridgePublisher`, `OutboxPublication`, and `createOutboxStreamHandler`, and exports only `handler`. The stack bundles it exactly like the cleanup worker (esbuild, the `source` export condition, the pinned AWS SDK).

- **Function:** `claimflow-outbox-publisher`, Node.js 24, ARM64, 256 MB, 60-second timeout, tracing disabled.
- **Logs:** `/aws/lambda/claimflow-outbox-publisher`, retained for 30 days.
- **Execution role:** its own role, allowing only log writes to that group; `dynamodb:GetItem` and `dynamodb:UpdateItem` on the table ARN (not its indexes); `events:PutEvents` on the `claimflow` bus ARN; `dynamodb:DescribeStream`, `GetRecords`, `GetShardIterator`, and `ListStreams` on the table stream ARN; and `sqs:SendMessage` (with the queue attribute and URL lookups) on the failure queue.
- **Failure queue:** `claimflow-outbox-publisher-failures`, a standard queue with SQS-managed encryption, TLS enforced, and 14-day retention. It receives the metadata of stream batches that exhausted their retries or expired, not the events themselves; the outbox items stay pending and the sweeper republishes them.
- **Event-source mapping:** the table stream, starting at `LATEST`, batch size 10, `ReportBatchItemFailures`, batch bisection on error, 5 retry attempts, maximum record age 24 hours, the failure queue as the on-failure destination, and the filter from the stream path above (an `INSERT` whose `SK` begins with `OUTBOX#`).

The sweeper is deployed as well (see below). These resources are deployed in `ap-southeast-1`. The AWS application runtime is not implemented, so the publisher and sweeper currently have no application-created outbox events to process.

### Sweeper (recovery path)

Stream records are retained for 24 hours. If publication fails for longer, the stream can no longer supply those events. The sweeper covers this case:

- an EventBridge schedule runs it every 15 minutes;
- it queries `GSI4PK = OUTBOX#PENDING AND GSI4SK < <now − 5 minutes>` (access pattern O1), oldest first; the grace period avoids racing the stream path on new events;
- it publishes and marks each event exactly as the stream publisher does.

Pending outbox items have no TTL, so an unpublished event is never lost.

### Sweeper infrastructure

`services/api/src/adapters/aws/outbox-sweeper-lambda.ts` is the sweeper's Lambda entry point. It reads `CLAIMFLOW_TABLE_NAME` and `CLAIMFLOW_EVENT_BUS_NAME` (failing to load when either is missing), builds the DynamoDB document and EventBridge clients once outside the handler, wires `DynamoDbPendingOutbox`, `DynamoDbOutboxState`, `EventBridgePublisher`, `OutboxPublication`, and `createOutboxSweeper` with `systemClock`, and exports only `handler`. The stack bundles it exactly like the other functions.

- **Function:** `claimflow-outbox-sweeper`, Node.js 24, ARM64, 256 MB, 60-second timeout, tracing disabled.
- **Logs:** `/aws/lambda/claimflow-outbox-sweeper`, retained for 30 days.
- **Execution role:** its own role, allowing only log writes to that group; `dynamodb:Query` on the `GSI4` index only; `dynamodb:GetItem` and `dynamodb:UpdateItem` on the table ARN; and `events:PutEvents` on the `claimflow` bus. It has no stream, S3, or SQS permission.
- **Schedule:** the enabled EventBridge rule `claimflow-outbox-sweeper-schedule` on the default bus, `rate(15 minutes)`, with the sweeper as its only target, 2 retry attempts, and a maximum event age of 1 hour. The Lambda invocation permission is generated for that rule only.
- **No failure queue.** A failed sweep leaves its events pending, and the next scheduled run retries them.

The enabled schedule runs every 15 minutes and queries `GSI4` even while no outbox events exist. These resources, including the Lambda invocation permission, are deployed in `ap-southeast-1`. The AWS application runtime is not implemented, so the publisher and sweeper currently have no application-created outbox events to process.

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
  - the outbox sweeper's scheduled invocations every 15 minutes, which run, and query `GSI4`, even when no events are pending.
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
- **Remaining infrastructure:** every approved component beyond the DynamoDB table, the Cognito User Pool with its web app client and classic hosted UI domain, the receipt bucket, web hosting, and the cleanup event bus, queues and rule is a future increment, defined in the CDK application and deployed manually (section 4).

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

| Choice                | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS Region            | `ap-southeast-1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| API compute           | One API Lambda function behind an HTTP API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Identity              | Cognito User Pool with API Gateway JWT authorization; administrator-created users; roles and manager in DynamoDB profiles; no Cognito Identity Pool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Receipt upload        | Presigned S3 POST policy with exact `content-length-range` and SHA-256 checksum conditions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Web hosting           | Private S3 bucket behind CloudFront with Origin Access Control; default `*.cloudfront.net` domain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Infrastructure        | AWS CDK in TypeScript (`infrastructure/`); the DynamoDB table, the Cognito User Pool with its web app client and classic hosted UI domain, the receipt bucket, and web hosting are deployed; the cleanup event bus, queues and rule are also deployed; the cleanup worker function, role, log group and mapping are also deployed; the outbox publisher function, role, log group, failure queue and stream mapping are also deployed; the receipt janitor function, role, log group, failure queue and stream mapping are also deployed; the outbox sweeper function, role, log group, schedule and invocation permission are also deployed; other components are future increments |
| Data model            | Single DynamoDB table with GSI1–GSI4; GSI4 also holds pending outbox items                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Stream                | `NEW_AND_OLD_IMAGES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Write model           | One transaction per mutation, including history, outbox events, and the idempotency result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Event publication     | Stream publisher Lambda to EventBridge, with the scheduled sweeper for recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Event identifiers     | Existing `IdGenerator`; outbox sort key `OUTBOX#<occurredAt>#<eventId>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Draft history cleanup | All history purged by the cleanup worker after the deletion transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Local runtime         | Kept as the default development runtime, with adapters matching the new port semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
