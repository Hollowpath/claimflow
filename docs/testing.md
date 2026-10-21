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

## DynamoDB claim reader (`services/api/test/dynamodb-claim-reader.test.ts`)

With a scripted client that records every command, and the shared fake-table tests above run through the re-export:

- the exact `GetItem` and `Query` inputs for A1 and A5 to A10: keys, index names, consistency, scan direction, and the `limit + 1` look-ahead, with no filter expression;
- a cursor for the last returned item only, continuation through a partial response with the cursor as start key, and a repeated continuation key refused;
- `getStored`: the claim and `lastEventVersion` (present, zero, and absent) from one strongly consistent `GetItem` that `get` shares, a missing item, malformed metadata rejected through the codec, invalid IDs rejected before any command, and SDK errors propagated unchanged;
- missing claims and categories, a direct lookup that returns another claim rejected with a value-free message, and malformed claim, history, and category items rejected through the codecs;
- invalid client and table name at construction, and invalid IDs, statuses, page limits, missing page requests, and malformed, oversized, or foreign cursors rejected before any command with fixed messages;
- SDK errors propagated unchanged for every read, only `GetItem` and `Query` sent, only read methods exposed, and the re-export being the same class.

## DynamoDB category reader (`services/api/test/dynamodb-category-reader.test.ts`)

With a scripted client that records every command:

- the exact strongly consistent `GetCommand` key, a missing category, and a decoded domain category without persistence metadata;
- `getStored`: the category with its `claimCount` and `lastEventVersion` (present, zero, and absent) from one strongly consistent `GetItem` that `get` shares, a missing item, malformed metadata and items under another key rejected through the codec, invalid IDs rejected before any command, and SDK errors propagated unchanged;
- the exact `QueryCommand` inputs for every page of the category partition (base table, no index, filter, or limit), the order kept across pages, empty pages with a continuation key, and an empty partition;
- malformed items, items under another key, and items that are not categories rejected through the codec or the requested-key check, and a repeated continuation key refused;
- an invalid table name rejected at construction and invalid category IDs (empty, blank, key-like, oversized, non-strings) rejected before any command, with fixed messages;
- SDK errors propagated unchanged, including after a first page;
- only `GetItem` and `Query` ever sent, and no write methods on the reader.

## DynamoDB idempotency and outbox items (`services/api/test/dynamodb-idempotency-items.test.ts`, `services/api/test/dynamodb-outbox-items.test.ts`)

- the approved example idempotency, claim event, and cleanup event items encoded exactly;
- completed and rejected idempotency records, including a `204` stored and read back without a body, and refusal of invalid keys, fingerprints, outcomes and statuses, timestamps, TTLs other than exactly 24 hours, and bodies that are not JSON, too deep, too wide, cyclic, or over 300 KB of UTF-8 (tested at the multibyte boundary);
- result references: `{ status: 201, resultRef: { receiptId } }` encoded exactly with no body, round-tripped, stored without any upload URL or form field, and refused (on encode with `ItemEncodingError`, on decode with `ItemIntegrityError` and fixed messages) when mixed with a body, carrying unknown fields, missing or invalid IDs, not a map, with a status other than 201, or on a rejected record, while snapshots, `204` results, and rejected snapshots are unchanged;
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

## DynamoDB idempotency coordinator (`services/api/test/dynamodb-idempotency-coordinator.test.ts`)

With injected fakes that share one call log, and no AWS access:

- `lookup`: an absent or expired record as `undefined`, a matching completed or rejected record returned, a different fingerprint refused with the fixed `IdempotencyConflictError`, stored records returned as stored, and reader errors propagated unchanged;
- `recordRejection`: one write and the record returned on success; after a `ConditionalCheckFailedException` exactly one strongly consistent reread, returning a concurrent success or rejection with the same fingerprint, refusing another fingerprint, and rethrowing the identical original failure when no unexpired record is found;
- the conditional failure recognized by SDK error name and not by message, unrelated writer errors and non-error rejections propagated unchanged without a reread, and reread errors propagated unchanged;
- invalid actors, keys, fingerprints, times, and rejection records (missing, completed, malformed, wrongly timed, or expired) rejected before any dependency call, with messages that never echo supplied values;
- result references returned intact from a lookup and from a lost rejection race, a conflict that does not expose the reference, and a reference refused as the rejection to store;
- invalid construction and only `lookup` and `recordRejection` exposed.

## Receipt upload replay resolver (`services/api/test/receipt-upload-replay-resolver.test.ts`)

With fake metadata and form dependencies sharing one call log, and the real form generator over a fake signer for the conditions:

- one metadata read followed by one form creation for the very same pending record, repeated replays each issuing a fresh form for the same receipt, and the original upload conditions (key, content type, exact size, checksum) identical across replays;
- the expiry boundaries: a record and a receipt expiring exactly now are accepted, and ones that expired a second ago are refused (the record before any read, the receipt without a form);
- missing, attached, replaced, foreign, and mismatched receipts refused with the existing `RECEIPT_UNAVAILABLE` error or a fixed integrity error that names no value, and never with a form;
- snapshots, rejected records, missing records, malformed references, codec-invalid records, and invalid times refused before any call, with messages that never echo supplied values;
- metadata and form errors propagated unchanged, with no retry.

## DynamoDB idempotent transaction committer (`services/api/test/dynamodb-idempotent-transaction-committer.test.ts`)

With fake executor and lookup dependencies sharing one call log, and transactions built by the real composer:

- a success sending the supplied transaction once and returning its completed record, including a result reference;
- a cancellation resolved by a concurrent completed, rejected, or reference winner returned intact, a fingerprint conflict propagated, no winner rethrowing the identical cancellation without a retry, no cancellation reason inspected, and lookup errors propagated unchanged;
- every ambiguous error name and transport code resolved by a winner from the first lookup, or retried once with the identical transaction object and token; a final lookup after a cancelled or ambiguous retry returning a winner or rethrowing the retry failure unchanged, conflicts and lookup errors propagated, a non-ambiguous retry failure propagated without a lookup, and never more than two executions;
- validation, token, programming, access, unknown, message-only, and unrelated transport failures propagated unchanged without a lookup or retry;
- an expired record rejected before any call and a record expiring exactly now accepted;
- invalid or tampered transactions (extra input, wrong or missing token, changed business items, a record that differs from the final idempotency item, a changed condition, an uncanonicalizable payload), invalid records, and invalid times rejected before any call, with messages that never echo supplied values.

## Receipt upload coordinator (`services/api/test/receipt-upload-coordinator.test.ts`)

With fake dependencies sharing one call log, and the real upload writer as the preparer once:

- first creation: lookup, one preparation with no events or guard, one commit of the prepared transaction, then resolution of the winning record;
- a stored reference replayed without preparing or committing, stored and concurrent snapshots and rejections returned intact without the resolver, and a winning reference to another receipt resolved instead of the candidate;
- fingerprint conflicts, lookup, preparation, commit, and resolver errors propagated unchanged without further calls;
- a signing failure after the commit followed by a successful retry that recovers through the lookup, with no second preparation or commit;
- invalid, expired (the exact boundary accepted), foreign, non-pending, or mismatched candidates and results rejected before any call, with messages that never echo supplied values.

## Claim mutation coordinator (`services/api/test/claim-mutation-coordinator.test.ts`)

With fake lookup and committer dependencies sharing one call log, and once with the real claim writer's `prepareCreate` and the real committer over a recording executor:

- first execution in the order lookup, one preparation, one commit of the exact prepared transaction and completed request, and a stored record or concurrent winner (including a rejection) returned intact;
- a stored record returned without preparing or committing, and a fingerprint conflict propagated without preparing;
- invalid requests and missing callbacks rejected before any call, and completed results that are for another actor, key, or fingerprint, expired (the exact boundary accepted), a receipt reference, missing, or refused by the codec rejected before committing, with messages that never echo supplied values;
- preparation, lookup, and commit errors propagated unchanged with no retry;
- the integration case sending one real transaction, and none when a result is already stored;
- prepared rejections: one `recordRejection` call after the lookup and one preparation and no commit, the returned record (including a concurrent completed or rejected winner) passed back intact, replay and lookup conflicts skipping preparation, rejection-race conflicts and unresolved conditional failures propagated unchanged without another lookup or retry;
- rejections refused before any write when completed, for another actor, key, or fingerprint, rejected by the codec (success status, reference, malformed fields), expired (exactly now accepted), or mixed with a transaction or completed request, with messages that never echo supplied values, and the success path unchanged.

## AWS claim creation service (`services/api/test/aws-claim-creation-service.test.ts`)

With fake category, user, and ID dependencies, and the real domain rules, claim writer preparation, mutation coordinator, idempotency coordinator, and transaction committer over an in-memory store and a recording executor:

- categorized and uncategorized success: the transaction items, a category guard at the version read, no event or outbox item, the derived 24-hour expiry, and a stored `201` body equal to what the existing `ClaimService` create returns;
- replay returning the stored record (completed or rejected) with no category read, user read, ID generation, parsing, or commit, and a different fingerprint refused;
- schema, domain, and client-error rejections stored with the safe mapping and request ID, with no commit, and the identity taken only from the actor (a smuggled `employeeId` is rejected);
- a lost commit race and a lost rejection race returning the actual winner;
- category, user, ID, preparation, codec, and non-ambiguous transaction failures propagated unchanged, with nothing stored as a rejection;
- invalid actors and request contexts refused before any dependency call, with messages that never echo supplied values;
- cancellation recovery with injected sleep, random source, claim reader, and logger: uncategorized and categorized retries after unchanged state with the same claim ID and a stable token; the exact cap of three commits, with the final check returning a winner, rethrowing the last cancellation unchanged, persisting `VERSION_CONFLICT` only for a category that changed again, and for a category changed for the first time at exhaustion persisting the normal rejection for a missing or inactive category or rethrowing the cancellation (with no fourth commit and no presentation rebuilt) for a still valid one; backoff delays that are exponential, jittered, and bounded whatever the random source returns, and absent when nothing is recovered; logs that carry only the operation and retry counts, with a distinct exhaustion event; a changed but valid category rebuilt with a new guard and token, a deactivated or deleted category persisted as the normal rejection, a second change persisted as `VERSION_CONFLICT`, and a rebuild counted toward the cap; a claim-ID collision (during recovery or at the final check) refused with a fixed integrity error and nothing stored; winners and fingerprint conflicts found by every recheck; and claim, category, presentation, preparation, sleep, and final-check failures propagated unchanged with nothing stored.

## AWS claim draft editing service (`services/api/test/aws-claim-draft-editing-service.test.ts`)

With fake claim, category, and user dependencies, and the real domain rules, claim writer preparation, mutation coordinator, idempotency coordinator, and transaction committer over an in-memory store and a recording executor:

- categorized and uncategorized edits with the stored `lastEventVersion` preserved (or absent), category add, remove, and switch with the matching counter operations and a guard at the version read, an unchanged inactive category edited without being read, and a stored `200` body equal to what the existing `ClaimService` update returns;
- replay returning the stored record (completed or rejected) with no claim, category, or user read and no domain work, and a different fingerprint refused;
- a missing and an invisible claim giving identical `NOT_FOUND` rejections, and invalid IDs, invalid or smuggled input, stale versions, non-owners, non-drafts, and unknown or inactive entered categories stored as business rejections with no commit;
- a lost commit race, a lost rejection race, and a winner found up front returning the actual winner;
- claim, category, user, preparation, and codec failures, and an unresolved cancellation, propagated unchanged with nothing stored as a rejection;
- invalid actors and request contexts refused before any dependency call;
- cancellation recovery with injected sleep, random source, and logger: unchanged-state retries that keep the expected version, inputs, event version, and token, the exact cap of three commits with the cancellation rethrown unchanged, bounded jittered delays, logs of only the operation and retry counts, and no recovery of other errors or inspection of cancellation reasons; a claim that disappears, becomes invisible, or is at a newer version stored as `NOT_FOUND` or `VERSION_CONFLICT` without applying the edit; destination changes rebuilt with a new guard and token, deactivated or deleted destinations stored as the normal rejection, a second change stored as `VERSION_CONFLICT`, and the terminal first-change versus repeated-change distinction at exhaustion; a missing or zero source counter refused with a fixed integrity error, during recovery and at the final check, with nothing stored; winners and fingerprint conflicts found by each recheck; and claim, category, presentation, preparation, and sleep failures propagated unchanged.

## AWS claim submission and lifecycle services (`services/api/test/aws-claim-lifecycle-service.test.ts`, `services/api/test/aws-claim-submission-service.test.ts`)

With fake claim, category, user, and ID dependencies, and the real domain rules, event builder, claim writer preparation, mutation coordinator, idempotency coordinator, and transaction committer over an in-memory store and a recording executor:

- every one of the six actions: the transaction shape (SUBMIT with the update, history, category `ConditionCheck` at the version read, event, and idempotency item; the others with no category operation), the owner, manager, or version-only write condition, the lifecycle event with the supplied correlation ID, the request ID as causation ID, and the version chain, one generated event ID, and a stored `200` body equal to what the existing `ClaimService.perform` returns;
- replay returning the stored record with no claim, category, or user read, no ID generated, and no domain work; identical `NOT_FOUND` for missing and invisible claims; stale versions and smuggled input stored as rejections;
- the domain rules as business rejections: required decision comments, a manager who is not assigned, self-review, payment by a non-administrator or by the claim owner, the wrong status, reopening by a non-owner, and the submission rules (manager, receipt, limits, category);
- lost commit and rejection races and winners found by each recheck returned, and fingerprint conflicts propagated;
- cancellation recovery for all actions: retries after unchanged state with a stable event ID and token and bounded jittered delays, the cap of three commits with the cancellation rethrown unchanged and a distinct exhaustion log, a disappearing, invisible, or newer claim stored as `NOT_FOUND` or `VERSION_CONFLICT` without applying the action, and for SUBMIT the category rebuild, the normal rejection for a deactivated or deleted category, `VERSION_CONFLICT` for a repeated change, and the terminal first-change versus repeated-change distinction; other errors and cancellation reasons never recovered or inspected;
- claim, category, user, ID, event-building, preparation, sleep, and codec failures propagated unchanged with nothing stored as a rejection;
- the submission entry point delegating to the lifecycle service, and invalid actors, actions, and request contexts refused before any dependency call.

## AWS claim creation through the request pipeline (`services/api/test/aws-claim-creation-api.test.ts`)

Through `createApiHandler` with the real AWS routes and the real `AwsClaimCreationService`, mutation coordinator, idempotency coordinator, claim writer, and committer over fake AWS dependencies:

- a created claim returned as the stored `201` response with the standard request and correlation headers, no replay header, a stored record with the pipeline's fingerprint and time, and no use of the local idempotency or create handler;
- replay returning the stored response without a second commit or any category read, a different body under the same key giving `IDEMPOTENCY_CONFLICT`, and a persisted business rejection returned with its original request ID and replayed unchanged;
- unauthenticated and unknown-subject requests, missing or invalid idempotency keys, oversized and malformed bodies refused before the mutation, and the mutation receiving the actor, parsed body, key, fingerprint, time, and request and correlation IDs;
- an infrastructure failure becoming a generic `500` that leaks no detail, stores nothing, is logged once, and does not fall back to the local path; request logs that omit the body, key, and fingerprint; and a result reference refused;
- the default behavior: without an entry, and for other operations, the route handler and the local idempotency are used.

## AWS claim edit and lifecycle through the request pipeline (`services/api/test/aws-claim-mutations-api.test.ts`)

Through `createApiHandler` with the real AWS routes and the real editing and lifecycle services, mutation coordinator, idempotency coordinator, claim writer, and committer over fake AWS dependencies:

- `PATCH /claims/:claimId` and each of the six action routes dispatched to the right service and action, with the stored `200` response, the lifecycle event (type, actor, correlation and causation IDs, version), the category guard only for submission, and no use of the local handlers or idempotency;
- replay returning the stored response with no second commit or claim read and no replay claim in the response headers or request log;
- the claim ID taken only from the route and the action only from the registration, with a body-supplied claim ID, action, status, or identity refused before any commit;
- missing, invisible, stale, unauthenticated, and unauthorized requests keeping their existing responses, and infrastructure failures becoming a generic `500` that leaks nothing and does not fall back to the local path;
- the seam receiving decoded route parameters, operations without a registration staying local, and a result reference refused.

## AWS claim reads through the request pipeline (`services/api/test/aws-claim-reads-api.test.ts`)

Through `createApiHandler` with the real AWS routes, `claimReadOperations`, `ClaimQueryService`, and `DynamoDbClaimReader` over a small fake table that serves keyed gets and pre-ordered pages with real paging:

- each of the five reads dispatched to the right key or index and partition (`GSI1` employee, `GSI2` review queue, `GSI3` status, `GSI4` all, and the claim partition for history), with responses equal to the local `ClaimQueryService` over plain claims, and no use of the local handlers;
- invisible, missing, and malformed claims giving identical `NOT_FOUND`, the history of an invisible claim never queried, and the assigned manager and administrator seeing a submitted claim;
- cursor pagination across pages without skips or repeats, role restrictions (`403` for the wrong role), invalid limits, statuses, and foreign cursors rejected before any read, and authentication required for every read;
- dependency failures becoming a generic `500` that leaks nothing and never reaches the local handler, unregistered operations and the default configuration staying local.

## AWS receipt upload target flow (`services/api/test/aws-receipt-upload-target-service.test.ts`)

With the real `ReceiptUploadCoordinator`, upload writer preparation, idempotency coordinator, committer, replay resolver, and upload-form generator over an in-memory store and a recording executor, and a fake signer:

- a new target: pending metadata owned by the actor with a sanitized file name, the declared values, and a 24-hour expiry, committed atomically with an idempotency reference, one generated ID, one signed form for `uploads/pending/<id>`, and nothing about the URL or form persisted; size boundaries accepted;
- replay returning the same receipt with a different fresh form and no new ID, preparation, or commit, a stored rejection replayed without a form, and a different fingerprint refused;
- non-employees stored as `FORBIDDEN`, and unsupported types, bad sizes and checksums, missing, empty, and unknown fields, and any smuggled owner, identity, ID, or time stored as validation rejections, all with no ID generated and no commit;
- a lost commit race resolving the concurrent winner's receipt, and a concurrent rejection returned intact without a form;
- a signing failure after the commit keeping the metadata and a retry recovering without a second commit, and ID-generator, invalid-ID, and non-ambiguous transaction failures propagated with nothing stored as a rejection;
- invalid actors and request contexts refused before any dependency call;
- the coordinator's lazy `run` (`services/api/test/receipt-upload-coordinator.test.ts`): lookup before preparation, a stored record skipping preparation, explicit rejections stored without a commit or form, a rejection race resolving a winning reference, and mixed, mismatched, expired, and malformed preparations or requests refused.

## AWS receipt attachment and replacement flow (`services/api/test/aws-receipt-attachment-service.test.ts`)

With the real mutation coordinator, idempotency coordinator, committer, and claim writer preparation over an in-memory store and a recording executor, and fake claim, receipt, inspector, and object dependencies that log every call:

- an attachment in the documented order (claim, receipt, inspect, promote, commit, pending deletion) with the claim, history, receipt, and idempotency items; a replacement retiring the old receipt with its 30-day expiry and the cleanup event for the old object, one generated event ID, and deletion of only the new pending object;
- replay returning the stored snapshot with no read, inspection, promotion, or deletion, and a different fingerprint refused;
- identical `NOT_FOUND` for missing, invisible, and malformed claims, stale versions rejected before any receipt is read, invalid and smuggled input rejected before any read, `FORBIDDEN` for a non-owner and `CLAIM_NOT_EDITABLE` for a non-draft before any receipt is touched;
- missing, already attached, foreign, and expired receipts, objects the inspector cannot verify, and objects that vanish before promotion stored as `RECEIPT_UNAVAILABLE`, an expiry exactly now accepted, and declared size, type, or checksum mismatches rejected without promotion;
- an old receipt record that is missing, not attached, or for another claim refused with a fixed integrity error before any inspection;
- a lost commit race and a recovery recheck returning the winner, deleting the pending object only when the winner holds this call's receipt, and fingerprint conflicts propagated;
- cancellation recovery: unchanged-state retries that re-inspect and re-promote with a stable token and cleanup event ID, bounded jittered delays and safe logs, the cap of three commits with the cancellation rethrown unchanged and nothing deleted, a changed claim or receipt stored as `VERSION_CONFLICT`, `NOT_FOUND`, or `RECEIPT_UNAVAILABLE`, and the final checks at exhaustion;
- claim, receipt, inspection, promotion, user, and non-ambiguous transaction failures propagated unchanged with nothing stored or deleted, a promoted object kept when the transaction fails, and a failed best-effort deletion logged without detail while the result is still returned;
- invalid actors and request contexts refused before any dependency call.

## AWS removal flows (`services/api/test/aws-claim-removal-services.test.ts`)

With the real mutation coordinator, idempotency coordinator, committer, and claim writer preparation over an in-memory store and a recording executor, and fake claim, receipt, category, and user dependencies:

- receipt removal returning the updated claim with claim, history, receipt, cleanup event, and idempotency items committed atomically, with or without a category (never touched);
- draft deletion for every category and receipt combination: at most six operations in the documented order, a `204` result with no body, no history item, a purge event and, with a receipt, a receipt-deletion event at the next claim version with distinct IDs, and no S3 or purge capability in either service;
- replay with no reads or generated IDs, identical `NOT_FOUND` for missing and invisible claims, and the domain rules as business rejections (no receipt, non-owner, non-draft, once-submitted, stale version, bad input);
- receipt records that are missing, not attached, or for another claim or owner, and category counters that are missing or zero, refused with a fixed integrity error and nothing stored, during the first attempt, recovery, and the final check;
- a lost commit race and a recovery recheck returning the winner and fingerprint conflicts propagated;
- cancellation recovery: unchanged-state retries with stable tokens and event IDs and bounded jittered delays, the cap of three commits with the cancellation rethrown unchanged and a distinct exhaustion log, a claim that disappears, becomes invisible, or moves on stored as `NOT_FOUND` or `VERSION_CONFLICT`, and the final checks at exhaustion;
- claim, receipt, preparation, and sleep failures and non-ambiguous transaction failures propagated unchanged with nothing stored, and invalid actors and request contexts refused before any dependency call.

## AWS receipt flows through the request pipeline (`services/api/test/aws-receipt-api.test.ts`)

Through `createApiHandler` with the real AWS routes and the real attachment, removal, deletion, and download services over fake AWS dependencies:

- `PUT /claims/:claimId/receipt` attaching and replacing (with the cleanup event for the old object) and returning the stored `200` claim, deleting only the pending object afterwards; `DELETE /claims/:claimId/receipt` returning the updated claim with its cleanup event; and `DELETE /claims/:claimId` returning `204` with no body, writing the purge and receipt events, touching no object or history, and staying within six operations;
- replay returning the stored result with no second commit, inspection, promotion, or deletion;
- the claim ID taken only from the route (a body claim ID is refused), and stale versions, invisible, missing, unavailable-receipt, unauthorized, submitted-claim, and unauthenticated requests keeping their existing responses;
- `GET /claims/:claimId/receipt` returning `{ url, expiresAt }` with `no-store` for the owner, the assigned manager, and an administrator, signing `receipts/<id>` with the file name, a stranger or a missing claim giving the same `NOT_FOUND`, and records that contradict the claim never yielding a URL;
- infrastructure failures (claim, signer) becoming a generic `500` that leaks nothing, with nothing deleted and no local handler used;
- the defaults: with nothing registered every operation, including the local binary download, stays local, registered operations never fall back, and unregistered ones stay local.

## DynamoDB transaction envelope (`services/api/test/dynamodb-transaction.test.ts`)

- an exact transaction of business operations, a pending outbox `Put`, and the completed idempotency `Put`, in that order, with their condition expressions;
- a result reference stored as the idempotency item without a body, a deterministic token that differs from the snapshot form, and malformed references refused before anything is built;
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

## DynamoDB receipt upload writer (`services/api/test/dynamodb-receipt-upload-writer.test.ts`)

With a recording executor, and the real executor over a fake client:

- the exact composed transaction, the pending receipt item followed by the completed idempotency item, and no outbox item;
- `preparePending` returning synchronously the exact transaction that `createPending` sends, sending nothing, and validating before returning;
- a result reference stored with the pending receipt in the same transaction, with no upload URL or form field persisted, a deterministic token different from the snapshot form, and malformed references refused before any command;
- the deterministic request token of the composer: stable across repeats and changed by the record;
- a missing idempotency record, any event, a category guard, and missing or malformed options rejected before any command;
- invalid pending records (state, ID, size, content type, checksum, expiry) and invalid idempotency data rejected before any command, with no supplied or stored value in the messages;
- invalid executors and table names rejected at construction;
- exactly one `TransactWriteCommand` per valid write, executor and SDK errors propagated unchanged without a retry, and only the creation method exposed.

## DynamoDB claim writer (`services/api/test/dynamodb-claim-writer.test.ts`)

With a recording executor, and the real executor over a fake client:

- for every mutation, the synchronous `prepare…` method returns the exact transaction that the write method then sends, deterministically, executes nothing, and refuses invalid input before any execution;
- the exact composed transaction for a categorized claim (claim, first history entry, guarded counter increment, idempotency record, with no `ConditionCheck`) and for an uncategorized claim (no counter operation);
- the deterministic request token of the composer: stable across repeats and changed by the guard version;
- missing options, events, a missing idempotency record, a missing, unexpected, mismatched, or inactive-allowing category guard, and invalid claims, history, guards, and idempotency data rejected before any command, with no supplied value in the messages;
- invalid executors and table names rejected at construction, and only the creation and draft-edit methods exposed;
- exactly one `TransactWriteCommand` per valid write, and executor and SDK errors propagated unchanged without a retry;
- `updateDraft`: an unchanged category with no counter operation, adding, removing, and switching categories in the order update, history, decrement, increment, idempotency (no `ConditionCheck`), the expected version taken from the previous claim and `lastEventVersion` preserved, and a deterministic token changed by the guard;
- `updateDraft` rejected before any command for missing inputs, events, a missing idempotency record, non-`UPDATE` actions, non-draft claims, mismatched claims or owners, a guard that is missing, unexpected, mismatched, or not requiring an active category, and invalid versions, history, or idempotency data, with no supplied value in the messages;
- `updateLifecycle` for `START_REVIEW`, `APPROVE`, `REJECT`, `REOPEN`, and `MARK_PAID` in the order update, history, outbox event, idempotency, with the manager, owner, or version-only write condition, the expected version taken from the previous claim, `lastEventVersion` advanced, the event chained to the stored event version, and a deterministic token changed by the event;
- `updateLifecycle` rejected before any command for `SUBMIT`, draft and receipt actions, mismatched claims, owners, categories, or previous status, a guard, a missing idempotency record, and no, extra, or mismatched events (type, actor, time, aggregate version, version chain, payload, extra fields, and non-canonical values), with no supplied value in the messages;
- `submit` for a first submission and a resubmission after reopening in the order update, history, category `ConditionCheck`, outbox event, idempotency, with the owner and expected-version condition, the guard values, no counter write, `lastEventVersion` advanced, the event chained to the stored event version, and a deterministic token changed by the guard or event;
- `submit` rejected before any command for other actions, mismatched claims, owners, or categories, uncategorized or non-draft claims, a missing, mismatched, or inactive-allowing guard, a missing idempotency record, and no, extra, or mismatched events, with no supplied value in the messages;
- `attachReceipt` in the order claim update, history, receipt update, idempotency, with the owner and expected-version claim condition, the pending-to-attached receipt condition, the claim and receipt linked by claim ID, owner, and receipt values, the stored event version kept, no counter, check, or outbox item, and a deterministic token changed by the event version or idempotency key;
- `attachReceipt` rejected before any command for other actions, non-draft, mismatched, or already-receipted claims, a claim without a receipt, receipts for another claim, owner, or actor, claim receipt values or attachment times that differ from the attached record, a guard, events, a missing idempotency record, and invalid records or versions, with no supplied value in the messages;
- `replaceReceipt` in the order claim update, history, new receipt attachment, old receipt retirement, cleanup event, idempotency, with the owner and expected-version, attach, and retire conditions, the old receipt retired with a TTL 30 days after the history time, the cleanup event targeting only the old object with `previousEventVersion` `null`, the stored event version kept, and a deterministic token changed by the event or event version;
- `replaceReceipt` rejected before any command for other actions, non-draft or mismatched claims, missing or identical receipts, old records that do not match the previous claim or are not `REPLACED`, new records for another claim, owner, or actor or with differing values or attachment time, a guard, a missing idempotency record, and no, extra, or mismatched cleanup events (target, type, actor, time, version, sequence, extra fields), with no supplied value in the messages;
- `removeReceipt` in the order claim update, history, receipt retirement, cleanup event, idempotency, with the claim receipt attribute removed, the owner and expected-version and retire conditions, the receipt retired as `REMOVED` with a TTL 30 days after the history time, the cleanup event targeting only the removed object with `previousEventVersion` `null`, the stored event version kept, and a deterministic token changed by the event or event version;
- `removeReceipt` rejected before any command for other actions, non-draft or mismatched claims, a missing previous receipt, a receipt kept on the changed claim, attached records that differ from the previous receipt, claim, owner, or actor, a record not retired as `REMOVED`, a guard, a missing idempotency record, and no, extra, or mismatched cleanup events, with no supplied value in the messages;
- `deleteDraft` for a draft with and without a category and with and without a receipt, in the order claim delete, counter decrement, receipt retirement, purge event, receipt-deletion event, idempotency (at most six operations, no history item, no `ConditionCheck`), with the owner, version, and never-submitted delete condition, the receipt retired as `REMOVED` with a TTL 30 days after the deletion time, both cleanup events at the next claim version outside the published sequence, and a deterministic token changed by an event;
- `deleteDraft` rejected before any command for invalid or early deletion times, an unadvanceable version, receipt records that are missing, unexpected, or differ from the claim receipt or are not `REMOVED`, submitted, reopened, foreign, or invalid drafts, a guard, a missing idempotency record, and wrong counts, order, duplicate IDs, mismatched targets, versions, actors, times, or extra fields in the cleanup events, with no supplied value in the messages.

## DynamoDB receipt operations (`services/api/test/dynamodb-receipt-operations.test.ts`)

- the exact pending `Put`, attach `Update`, and `REPLACED` and `REMOVED` `Update` inputs and their exported conditions;
- applying each `Update` to the stored item yields exactly the codec-encoded new record: declared values and TTL removed on attachment, and only state and TTL changed on retirement;
- the 24-hour pending and 30-day retired TTLs, every content type, and size boundaries;
- refused mismatched receipts, owners, file names, upload times, measurements (including each measured value that differs from its declaration), and claims, and invalid actors, states, timestamps, and TTLs;
- uploads, attachments, replacements, removals, and draft deletions composed with claim and category operations without duplicate targets;
- no file names in keys, conditions, or errors, and no DynamoDB or S3 command sent.

## DynamoDB category writer (`services/api/test/dynamodb-category-writer.test.ts`)

With a recording executor, and the real executor over a fake client:

- the exact create, update-with-events, update-without-events (keeping `lastEventVersion`), and delete transactions, equal to the composer's output for the existing builders;
- the category item, then outbox items in order, then the completed idempotency item, and the deterministic request token: stable across repeats and changed by the payload;
- a missing idempotency record, a category guard, and missing options or events rejected before any command;
- invalid categories, versions, category IDs, events, and idempotency data rejected before any command, with no supplied value in the messages;
- invalid executors and table names rejected at construction;
- exactly one `TransactWriteCommand` per valid write, and executor and SDK errors propagated unchanged without a retry.

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
