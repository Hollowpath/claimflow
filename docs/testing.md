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
- through the shared handler: unauthenticated `401`, authenticated requests, a JSON claim create, a base64 receipt upload returned as a binary download, validation and size errors, a generic `500`, and no roles taken from token claims.

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
