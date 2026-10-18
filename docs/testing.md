# Testing

All tests use Vitest. Run them from the repository root:

```text
npm test                # every workspace
npm run test:coverage   # with V8 coverage reports in each workspace's coverage/
npm test -w @claimflow/api   # one workspace
```

`npm run check` runs formatting, type-checking, lint, and tests. GitHub Actions (`.github/workflows/ci.yml`) runs install, format check, type-check, lint, tests with coverage, the production build, and a production dependency audit. It has no deployment steps.

## Domain (`packages/domain/test`)

Pure unit tests of the business rules, with a 90% coverage threshold:

- every valid lifecycle transition and every invalid status pair;
- ownership of drafts, submission, and reopening;
- manager assignment, self-review prevention, and required, length-limited decision comments;
- administrator-only payment, including not paying one's own claim;
- required submission fields, reported all at once;
- money: positive safe integers and three-letter currency codes;
- inactive and unknown categories, inclusive limits, currency matching;
- receipt thresholds below, equal to, and above the boundary, and a zero threshold;
- policy re-evaluation on resubmission and manager assignment at submission;
- draft deletion: owner only, `DRAFT` only, and never for a claim that was once submitted; category deletion by administrators only;
- receipt type, size limits at the boundary, file-type detection, file-name sanitizing, checksum format, metadata mismatch, ownership, and reuse;
- immutability of inputs and the history entry produced by each command.

## Contracts (`packages/contracts/test`)

Strict request schemas reject identity, role, and status fields; `null` versus absent fields; pagination and idempotency key validation.

## Application and adapters (`services/api/test/application.test.ts`)

The services wired to the real local adapters in a temporary directory:

- persistence of claims, history, and categories across restarts;
- refusal to overwrite unreadable data, and no partial state after a failed write;
- concurrent edits with the same expected version: exactly one wins;
- returned history cannot be used to alter stored history;
- cursor pagination without skips or repeats, and rejection of foreign cursors;
- idempotency: replay, per-actor scope, key reuse, in-progress requests, release after failures;
- receipt measurement, content sniffing, attach/replace/read/remove, missing, foreign, mismatched, reused, and tampered uploads, and cleanup of abandoned uploads.

## Shared API handler (`services/api/test/api-handler.test.ts`)

The transport-neutral request pipeline, called directly with normalized requests and test routes:

- routing below the API base path, decoded parameters, and `404` for unknown, outside, and malformed paths without authenticating;
- the injected authentication resolver, `401` before any body is read, and a generic `500` when the resolver fails;
- body size limits per route type (`413`), JSON parsing and content types, and routes that never read a body;
- required idempotency keys, replay with `Idempotent-Replayed`, key reuse, and replayed rejections;
- standard response headers, request and correlation IDs, binary file responses, and hidden internal errors;
- one structured log entry per request;
- the local handler's development sign-in cookie, including tampered cookies.

## API Gateway transport (`services/api/test/lambda-adapter.test.ts`)

The HTTP API payload format 2.0 adapter, with hand-built events and no AWS access:

- method, raw path, query parameters, lower-case headers, and the cookie header rebuilt from `cookies`;
- UTF-8 and base64 request bodies, the body size limit, and empty bodies;
- only the authorizer's validated `sub` claim becomes the verified subject; other claims are ignored, and missing or malformed claims leave it unset;
- text, base64 binary, and empty responses with their status and headers;
- through the AWS API handler: unauthenticated `401`, authenticated requests, a JSON claim create, a base64 receipt upload returned as a binary download, validation and size errors, a generic `500`, and no roles taken from token claims.

## AWS authentication boundary (`services/api/test/aws-api.test.ts`)

The AWS API handler and route set against the local adapters:

- the AWS route set equals the local one without `PUT` and `DELETE /session`, which answer `404`;
- a verified Cognito subject resolves to the actor from the user directory; missing and unknown subjects stay unauthenticated, and cookies are ignored;
- authorization follows directory roles, not role or group headers, and the local runtime ignores verified subjects;
- `GET /session` on AWS describes only the signed-in user, with an empty `users` list;
- local development sessions still select, describe, and clear a sample user.

## User directory (`services/api/test/user-directory.test.ts`)

The `get`/`getMany` directory port and the development-only user catalogue, with a recording directory that cannot list users and returns profiles in reverse order:

- the static directory's `get` and `getMany` (only requested, deduplicated, unknown IDs omitted) and its development catalogue;
- `loadNames` requests each needed user once, matches names by ID, and skips `getMany` when no users are needed;
- claim, page, history, and receipt presentation request only the employees, assigned managers, and history actors shown, in one call;
- local session descriptions list the development users, while signed-in descriptions never use the catalogue, which may be absent.

## DynamoDB user directory (`services/api/test/dynamodb-user-directory.test.ts`)

The AWS `UserDirectory` adapter against an in-memory fake document client, with no AWS access and no real waiting between retries:

- `get`: one strongly consistent `GetItem` on `USER#<id>` / `PROFILE`, profiles with and without a manager, and missing profiles;
- rejection of malformed stored items: wrong keys or entity type, empty names or titles, roles that are not a list of known roles, and empty or non-string manager IDs, without revealing stored values;
- `getMany`: no command for an empty list, deduplicated eventually consistent `BatchGetItem` calls of at most 100 keys, unordered and missing responses, and unrequested profiles;
- unprocessed keys retried with exponential, capped backoff, and a clear failure after the attempt limit;
- only `GetItem` and `BatchGetItem` are ever sent, and the real document client satisfies the adapter's client type.

## Commit envelope and outbox events (`services/api/test/commit-envelope.test.ts`)

- TTL values as whole Unix epoch seconds, rounded down, and typed as numbers;
- every field of the completed request, category guard, and commit options;
- exactly the approved event types, their routing (publishable or internal) and aggregate type, the envelope fields, and `previousEventVersion` typed as a number or `null`, and `null` for internal events;
- no free-text or personal fields in any event payload type or fixture.

## Transaction request tokens (`services/api/test/transaction-token.test.ts`)

- canonical JSON: sorted keys at every level, preserved array order, and rejection, with the path, of `undefined`, functions, symbols, big integers, non-finite numbers, sparse arrays, cycles, and non-plain objects;
- tokens of exactly 32 lowercase hexadecimal characters, computed as designed, stable for identical or rebuilt payloads regardless of key order, time, or randomness;
- a different token for any change of actor, idempotency key, fingerprint, category version, timestamp, event ID, claim ID, or item order, and for identity fields that would otherwise run together.

## DynamoDB item codecs (`services/api/test/dynamodb-items.test.ts`)

Pure encoders and decoders for claim, history, and category items:

- the approved example items encoded exactly, and round trips that preserve every domain field, the receipt, decision comments, and persistence metadata;
- every claim status with its index values, GSI2 present only for `SUBMITTED` and `UNDER_REVIEW`, absent optional attributes omitted, and no free text in any index key;
- encoding refused for open claims without a manager or submission time, non-canonical timestamps, unsafe IDs, and invalid versions or event versions;
- history sort keys padded to 10 digits, sorting in version order across digit boundaries, and versions outside the representable range rejected;
- categories with their claim count and event version, and no index attributes on history or category items;
- decoding rejected for wrong keys or entity types, invalid statuses, actions, versions, timestamps, amounts, receipts, settings, and metadata, and missing, wrong, or unexpected index attributes, with errors that never reveal stored values or malformed keys;
- receipt file names not already in sanitized form (paths, control or unsafe characters, leading dots, overlong names) and untrimmed category names, refused when encoding and rejected when decoding.

## DynamoDB cursors (`services/api/test/dynamodb-cursor.test.ts`)

- the canonical version 1 base64url JSON format, and round trips for the employee, queue, status, all-claims, and history lists;
- `INVALID_CURSOR` for empty, oversized, non-base64url, padded, non-JSON, and non-canonical cursors, missing or extra envelope fields, wrong versions, lists, or indexes, and missing, extra, or non-string key attributes;
- wrong partitions (including `OUTBOX#PENDING`), table and index key shapes, timestamp-plus-ID sort keys, and sort keys naming another claim;
- cursors bound to the caller, manager, status, list, and claim.

## DynamoDB read adapters (`services/api/test/dynamodb-readers.test.ts`)

Against an in-memory fake table that applies key order, `Limit`, `ExclusiveStartKey`, and `LastEvaluatedKey` as DynamoDB does, and can return partial responses:

- the exact `GetItem` and `Query` inputs for A1, A5–A10, C1, and C2: keys, index names, consistency, and scan direction;
- missing claims and categories, a missing category counted as unused, and malformed items rejected through the codecs;
- look-ahead pages of at most `limit` items with a cursor for the last returned item, no empty final page, and continuation through partial responses;
- cursors from another list, user, status, or claim, and malformed or oversized cursors, rejected before any query;
- every page of the category partition, and only `GetItem` and `Query` ever sent.

## DynamoDB idempotency and outbox items (`services/api/test/dynamodb-idempotency-items.test.ts`, `services/api/test/dynamodb-outbox-items.test.ts`)

- the approved example idempotency, claim event, and cleanup event items encoded exactly;
- completed and rejected idempotency records, including a `204` stored and read back without a body, and refusal of invalid keys, fingerprints, outcomes and statuses, timestamps, TTLs other than exactly 24 hours, and bodies that are not JSON, too deep, too wide, cyclic, or over 300 KB of UTF-8 (tested at the multibyte boundary);
- every approved event type routed to its aggregate partition and round-tripped while pending and once published, with GSI4 present only while pending and a TTL exactly 7 days after publication;
- rejection of wrong keys, event types, schema versions, sources, aggregates, previous event versions, payload identities, missing or invalid payload fields, and index attributes;
- no free-text field in any outbox item, and errors that never echo payload values or malformed keys.

## DynamoDB receipt metadata (`services/api/test/dynamodb-receipt-items.test.ts`)

- the approved pending example encoded exactly, and round trips of `PENDING`, `ATTACHED`, `REPLACED`, and `REMOVED` items with no index attributes or undefined values;
- the 24-hour pending and 30-day retired TTL helpers, and pending TTLs that are not exactly 24 hours rejected;
- every supported content type and the 1-byte and 10 MB size boundaries;
- rejection of wrong keys, IDs, entity types, states, timestamps, TTLs, content types, sizes, checksums, and object keys, of missing, forbidden, and unexpected state attributes, and of index attributes;
- unsanitized file names refused and rejected in every state, and errors that never reveal file names or malformed keys.

## DynamoDB lookups (`services/api/test/dynamodb-lookups.test.ts`)

- the exact receipt and idempotency keys with `ConsistentRead: true`, and only `GetCommand` ever sent;
- every receipt state, completed and rejected idempotency records, and missing items;
- idempotency records before, exactly at, and after `expiresAt`, treated as absent only once expired;
- malformed items raising `ItemIntegrityError`, invalid current times rejected before reading, and SDK errors propagating unchanged.

## DynamoDB rejection writer (`services/api/test/dynamodb-idempotency-writer.test.ts`)

Against a fake client that applies the approved condition to an existing item:

- the exact `PutCommand` input: the complete encoded rejected record, the condition expression, and the current time;
- invalid current times, completed records, and records the codec refuses, all rejected before any command, and already-expired records refused;
- a new record expiring exactly now still written, while an existing record expiring exactly now or later blocks the write and one that expired before now is replaced;
- `ConditionalCheckFailedException` propagating as the identical object, other SDK errors unchanged, and only `PutCommand` ever sent.

## DynamoDB transaction envelope (`services/api/test/dynamodb-transaction.test.ts`)

- an exact transaction of business operations, a pending outbox `Put`, and the completed idempotency `Put`, in that order, with their condition expressions;
- `204` responses stored without a body, zero and several events in order, and invalid responses and events rejected through the codecs;
- tokens stable for rebuilt identical inputs, changed by any business value, event, response, or order, and never part of their own hashed payload;
- rejection of empty business items, wrong tables, malformed or unsupported operations and keys, duplicate targets including collisions with outbox and idempotency items, and more than 100 operations, with exactly 100 accepted;
- errors that never name key values, and no DynamoDB command ever sent.

## DynamoDB category operations (`services/api/test/dynamodb-category-operations.test.ts`)

- the exact `Put`, `Update`, `Delete`, and `ConditionCheck` inputs and their exported conditions;
- creation at version 1 with no claims and creation as the latest event, and updates that set every mutable field and never `claimCount`, `createdAt`, keys, identity, or indexes;
- next-version and expected-version validation, including the largest safe version, and invalid versions, IDs, guards, and category values refused;
- deletion only at the expected version with an unused counter, guarded increments, underflow-safe decrements, and the separate version and active check;
- every operation on the injected table and category key, no free text in conditions or errors, use with the transaction composer, and no DynamoDB command sent.

## DynamoDB claim operations (`services/api/test/dynamodb-claim-operations.test.ts`)

- the exact create, update, history, and delete operations and their exported conditions;
- for every update action, applying the generated `SET` and `REMOVE` to the stored item yields exactly the codec-encoded new claim, including GSI2 added for open claims and removed otherwise, and optional fields and receipts added, changed, or removed;
- owner, manager, and version-only conditions for every history action, and `lastEventVersion` set by lifecycle actions and preserved by draft and receipt changes;
- refused mismatched IDs, versions, statuses, and transitions, `CREATE` or unknown actions, invalid or overflowing versions, and deletes of submitted, reopened, or foreign drafts;
- use with category operations and the transaction composer, no free text in keys, conditions, or errors, and no DynamoDB command sent.

## DynamoDB receipt operations (`services/api/test/dynamodb-receipt-operations.test.ts`)

- the exact pending `Put`, attach `Update`, and `REPLACED` and `REMOVED` `Update` inputs and their exported conditions;
- applying each `Update` to the stored item yields exactly the codec-encoded new record: declared values and TTL removed on attachment, and only state and TTL changed on retirement;
- the 24-hour pending and 30-day retired TTLs, every content type, and size boundaries;
- refused mismatched receipts, owners, file names, upload times, measurements (including each measured value that differs from its declaration), and claims, and invalid actors, states, timestamps, and TTLs;
- uploads, attachments, replacements, removals, and draft deletions composed with claim and category operations without duplicate targets;
- no file names in keys, conditions, or errors, and no DynamoDB or S3 command sent.

## DynamoDB transaction executor (`services/api/test/dynamodb-transaction-executor.test.ts`)

- the exact composed input sent once in a single `TransactWriteCommand`, with its token and operation order preserved and the input left unmodified;
- the SDK output returned as is;
- cancellations, token mismatches, throttling, timeouts, and internal errors propagated by identity, each after exactly one command and with no retry.

## S3 upload form (`services/api/test/s3-upload-form.test.ts`)

- the exact bucket, key, fields, conditions, and 15-minute expiry passed to an injected signer, called once, and the hexadecimal-to-base64 checksum conversion;
- every content type and the 1-byte and 10 MB size boundaries, and records the receipt codec refuses rejected before signing;
- non-`PENDING` records, missing bucket names, and invalid signer output rejected, and no file names or checksums in keys or errors;
- the real signer run locally with static credentials: the decoded policy has the required conditions and a lifetime of at most 15 minutes, and no network request is made.

## S3 receipt inspector (`services/api/test/s3-receipt-inspector.test.ts`)

- the exact `HeadObject` (checksum mode) and ranged `GetObject` (`bytes=0-15`) commands, in that order, and the exact measured result;
- PDF, JPEG, and PNG signatures, and unknown, truncated, and mismatched signatures rejected;
- missing or mismatched size, type, and checksum rejected without reading the body, and absent, unusable, or over-long ranged responses rejected;
- missing objects recognized by error name or status and not by message, and unrelated SDK failures propagated unchanged;
- validation before any command, errors that expose no bucket, key, name, or value, and at most two read-only commands.

## S3 receipt objects (`services/api/test/s3-receipt-objects.test.ts`)

- the exact `CopyObject` request (same bucket, pending source, final key, metadata copied, SHA-256 requested) and the declared checksum matched against the result, with missing, malformed, and different checksums rejected;
- missing sources recognized by error name or status and not by message, and unrelated S3 failures propagated unchanged;
- the exact pending and final `DeleteObject` requests, with no preliminary read and success for missing objects;
- invalid buckets, records, and receipt IDs rejected before any command, fixed error messages without sensitive values, and only `CopyObject` and `DeleteObject` ever sent.

## S3 download URLs (`services/api/test/s3-download-url.test.ts`)

- the exact bucket, final key, `Content-Disposition`, five-minute lifetime, and single captured signing time passed to the signer once, and the exact `expiresAt`;
- ASCII, quoted, and Unicode file names through the shared `contentDisposition`, which the local receipt route also uses (checked in `http-api.test.ts`);
- invalid buckets, receipt IDs, unsanitized file names, and signer output rejected, with fixed messages that expose no bucket, key, ID, or name;
- the real signer producing a local HTTPS URL with a five-minute expiry, the expected key and disposition, and no S3 command or network request.

## Claim lifecycle events (`services/api/test/claim-events.test.ts`)

- the exact envelope and payload of every lifecycle mapping, and no event for draft-only actions;
- previous event versions: `null` for the first event, a lower whole number later, and invalid values rejected;
- inconsistent IDs, versions, statuses, and transitions, invalid generated IDs, and missing manager, category, amount, or required timestamps rejected with messages that name no values;
- no merchant, purpose, comment, receipt, or name in any payload;
- every event accepted by the outbox codec, and consistent with the `lastEventVersion` set by the claim transaction builder.

## Cleanup events (`services/api/test/cleanup-events.test.ts`)

- the exact envelope and payload of the receipt deletion and history purge events, with `previousEventVersion` always `null` and the payloads restricted to the approved identifiers;
- invalid IDs, trace IDs, timestamps, versions, and object keys rejected, version boundaries accepted, and fixed errors that never echo values;
- both events accepted by the outbox codec and composed with a draft deletion by the transaction composer.

## Category events (`services/api/test/category-events.test.ts`)

- the exact creation, policy, activation, deactivation, and deletion events, policy payloads limited to the fields that changed, and no event for a name-only change;
- a combined update producing both events in a fixed order at the same version with distinct IDs, and no category name in any event;
- version, creation-time, previous-event-version, ID, and timestamp validation with boundaries, and fixed errors that never echo values;
- every event accepted by the outbox codec, and use with the category operation builders and the transaction composer, including `lastEventVersion` recorded only when an event is published.

## DynamoDB outbox state (`services/api/test/dynamodb-outbox-state.test.ts`)

- the strongly consistent read of the derived key, missing items, strict decoding of pending and published items, and malformed or free-text items rejected;
- the exact conditional `UpdateItem`, a TTL exactly seven days after publication, and applying it to a pending item yielding exactly the encoded published item without index attributes;
- invalid events and timestamps rejected before any command, and conditional-check and other SDK errors propagated unchanged with only `GetItem` and `UpdateItem` ever sent.

## DynamoDB pending outbox query (`services/api/test/dynamodb-pending-outbox.test.ts`)

- the exact eventually consistent `GSI4` query, oldest first, with no filter or paging cursor, and results bounded by the cutoff (exclusive) and the limit;
- empty results, limits of 1 and 10, ordering by time and then event ID, and strict decoding of every item with published, malformed, free-text, and unexpected items rejected;
- invalid table names, cutoffs, and limits rejected before any command, and SDK errors propagated unchanged.

## EventBridge publisher (`services/api/test/eventbridge-publisher.test.ts`)

- the exact `PutEvents` entries and order for every event family, with the full envelope (not a stored item) as the detail;
- batches of 1 and 10 accepted, and empty, oversized, and invalid batches and bus names rejected before any command;
- the SDK result, including failed entries, returned unchanged, and SDK errors propagated unchanged without a retry.

## Outbox publication workflow (`services/api/test/outbox-publication.test.ts`)

- missing and already published items skipped, duplicate delivery as a no-op, no EventBridge call when nothing is pending, and the stored event published in batch order;
- results matched by index, successful entries marked once with one clock time, and failed or ambiguous entries never marked;
- partial and whole-call failures, unreliable EventBridge results treated as failures, read and mark failures, and conditional-check races ignored by error name only;
- the first failure chosen in batch order, no operational error thrown, and invalid batches or sequence numbers rejected before any read.

## Outbox stream handler (`services/api/test/outbox-stream-handler.test.ts`)

Using DynamoDB stream records built with the real marshaller:

- decoding of images with numbers and nested maps, delivery to the workflow in stream order, and batches of up to 10 relevant records;
- records outside the `INSERT` and `OUTBOX#` filter ignored, and counted neither toward the limit nor for sequence numbers;
- malformed relevant records reported as failed while the others are processed, and the workflow skipped when none decode;
- the first failure chosen in stream order from decoding and workflow failures, with exactly one entry in the response;
- a missing sequence number or an oversized batch throwing before anything is published.

## Outbox sweeper (`services/api/test/outbox-sweeper.test.ts`)

- one clock reading, a cutoff exactly five minutes earlier, and a single query for up to 10 events;
- empty results returning without publishing, events passed in query order with their event IDs as unique sequence numbers, batches of 1 and 10, and a deterministic result;
- reported failures turned into one fixed safe error without retrying, and query, clock, and workflow errors propagated unchanged.

## Receipt janitor handler (`services/api/test/receipt-janitor-handler.test.ts`)

Using TTL removal records built with the real marshaller and `S3ReceiptObjects` over a recording S3:

- both the final and the pending object deleted for valid pending receipts, idempotently on retry;
- inserts, modifies, user removals, other service identities, other entities, and non-pending receipts ignored;
- malformed pending receipts and missing or unreadable old images failing only their own record;
- both deletions attempted when either or both fail, other records still processed, and the first failure reported in stream order;
- a candidate without a sequence number throwing a fixed message before anything is deleted.

## DynamoDB history purger (`services/api/test/dynamodb-history-purger.test.ts`)

- the exact keys-only, ascending, strongly consistent partition query with no scan, filter, or index, following all pages, including an empty page with a continuation key;
- no history, one entry, 25 entries, and more than 25 split into correct batches, within and across pages, and idempotent repeated purges;
- boundary history keys accepted, and wrong partitions, malformed or extra keys rejected before anything on the page is deleted, with errors that name no key, claim, or table;
- only unprocessed requests resent with capped exponential backoff, and the fixed error after the attempt limit;
- query and write errors propagated unchanged, and invalid table names and claim IDs rejected before any command.

## Cleanup worker handler (`services/api/test/cleanup-worker-handler.test.ts`)

Using SQS records whose bodies are EventBridge events:

- receipt deletions routed to the final object only, history purges to the purger, mixed batches, empty batches, and duplicate deliveries;
- malformed JSON, non-object bodies, wrappers with missing, wrong, or extra fields (including each malformed `id`, `account`, `time`, `region`, `resources` entry, and `replay-name`), wrong sources, and mismatched detail types rejected, with EventBridge times accepted with and without fractional seconds;
- publishable and unknown events and malformed internal envelopes and payloads rejected, using the outbox codec's rules;
- dependency failures failing only their own record, every failed message ID returned in input order, and successes omitted;
- a missing or empty message ID throwing a fixed message before any cleanup, and responses that contain only message IDs.

## Cleanup worker Lambda entry point (`services/api/test/cleanup-worker-lambda.test.ts`)

With stubbed environment variables and a fresh module import:

- the module exporting only `handler`, which answers an empty batch without calling AWS;
- loading failing with a fixed message when the table name or the receipt bucket name is missing or empty.

## Outbox publisher Lambda entry point (`services/api/test/outbox-publisher-lambda.test.ts`)

With stubbed environment variables and a fresh module import:

- the module exporting only `handler`;
- an empty batch, and records outside the approved filter, answered without calling AWS;
- loading failing with a fixed message when the table name or the event bus name is missing or empty.

## Receipt janitor Lambda entry point (`services/api/test/receipt-janitor-lambda.test.ts`)

With stubbed environment variables and a fresh module import:

- the module exporting only `handler`;
- an empty batch, and records that are not removals made by the DynamoDB service, answered without calling AWS;
- loading failing with a fixed message when the receipt bucket name is missing or empty.

## Outbox sweeper Lambda entry point (`services/api/test/outbox-sweeper-lambda.test.ts`)

With stubbed environment variables and a fresh module import:

- the module exporting only `handler`;
- the handler, with a spied document client, querying the `GSI4` index of the configured table and answering `{ selected: 0 }` for an empty page;
- loading failing with a fixed message when the table name or the event bus name is missing or empty.

## HTTP API (`services/api/test/http-api.test.ts`)

The real server on an ephemeral port with per-user cookie sessions:

- authentication, tampered cookies, unknown users, and sign-out;
- the complete draft-to-paid workflow and its history; rejection, reopening, and resubmission;
- visibility (`404` for claims a user may not see), role and assignment checks, self-review;
- role-restricted lists and the status filter;
- the JSON error contract, malformed bodies, content types, and path segments, missing idempotency keys, and a generic `500` that leaks no internals;
- stale versions, idempotent retries of creates and actions, and key reuse;
- history pagination, category management and validation, and policy re-evaluation on submit;
- receipt upload, view, replace, remove, `413` for oversized files, and type and metadata mismatches;
- deleting never-submitted drafts with their history (including idempotent retries), refusing reopened or submitted claims, and deleting only unused categories;
- data and sessions surviving a restart.

`services/api/test/openapi.test.ts` checks that `docs/openapi.yaml` documents exactly the implemented routes.

## Web (`apps/web/test`)

React Testing Library in jsdom with the API module mocked:

- the development sign-in notice and user chooser, role-sensitive navigation, start pages, and role-gated pages;
- switching users clears the previous user's claims, and a slow response for the previous user is discarded;
- claim lists with pagination; loading, empty, and error states with retry;
- creating a draft with the amount converted to minor units; local amount validation; server field errors;
- editing a draft with its expected version and cleared fields; conflict feedback and reload; inactive categories on existing drafts;
- submit errors from the server; the required manager comment for approve and reject;
- receipt upload, rejection of unsupported files, two-step removal, and read-only receipts for reviewers;
- deleting a draft after confirmation, and no delete option for previously submitted claims;
- the administrator status filter; creating, editing, activating, validating, and deleting categories, including the in-use error;
- money parsing and formatting; the API client's idempotency keys, retry, `204` handling, and reporting of an unreachable API.

## End-to-end verification

With `npm run dev` running, perform the end-to-end workflow described in the README:

1. Create and edit a draft, and attach a receipt.
2. Submit the claim, start the review as the assigned manager, and approve or reject it with a comment.
3. Reopen and resubmit a rejected claim, then mark an approved claim as paid.
4. Confirm the history records each step and that other users receive "not found".
5. Restart the app and confirm the data is still present.
6. Stop the app, run `npm run reset-data`, start it again, and confirm only the default categories remain.
