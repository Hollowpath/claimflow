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
