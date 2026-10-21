# API contract

The ClaimFlow API is served under `/api/v1` by `services/api` (port 3001 in the local development runtime; the Vite dev server proxies `/api` to it). The machine-readable contract is [openapi.yaml](openapi.yaml). Request schemas live in `packages/contracts` and are shared with the web app.

## Sessions

The local development runtime uses development sign-in rather than production authentication. `PUT /session` with `{ "userId": "u-aisha" }` selects a sample user and sets an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie. There is no password, so anyone who can reach the API can select any sample user; do not expose it beyond a development machine or use it with real data.

The AWS runtime, which is deployed and was verified manually in a browser on 21 October 2026 (not by an automated test) for the session, claim list, claim detail, and receipt upload, download, replacement, and removal requests, signs users in with Cognito instead. It has no `PUT /session` or `DELETE /session`. Its `GET /session` describes only the signed-in user and returns an empty `users` list. The user is identified only by the `sub` of the access token that API Gateway validated, and roles and manager come from the user's profile, never from token claims or groups.

On every request the server verifies the cookie (locally) or the validated subject (on AWS) and loads the user's roles and manager from its own directory. Request bodies never carry identity: request schemas are strict, so a body containing `employeeId`, `status`, `roles`, or any other unknown field is rejected with `400`.

## Conventions

- **JSON only.** Bodies must be sent as `application/json` (except receipt uploads) and are limited to 64 KB.
- **Expected versions.** Every claim and category mutation includes `expectedVersion`. If the stored version differs, the request fails with `409 VERSION_CONFLICT` and nothing is changed.
- **Idempotency.** Every `POST`, `PUT`, `PATCH`, and `DELETE` except `/session` requires an `Idempotency-Key` header (8–128 characters from `A–Z a–z 0–9 _ . : -`). Keys are scoped to the signed-in user and kept for 24 hours. Retrying with the same key and the same request returns the original status and body with `Idempotent-Replayed: true`. Reusing a key for a different request returns `409 IDEMPOTENCY_CONFLICT`, as does, in the local runtime, a retry that arrives while the first attempt is still running. In the local runtime unexpected server errors release the key so the request can be retried; on AWS there is no in-progress state, because the result is stored in the same transaction as the change.
- **Pagination.** List endpoints accept `limit` (1–100, default 20) and `cursor`, and return `{ items, nextCursor? }`. Cursors are opaque, tied to the list they came from, and stable while items are added or removed.
- **Tracing.** Every response carries `X-Request-Id`. A valid `X-Correlation-Id` request header is echoed back; otherwise the request ID is used.
- **Caching.** Responses are `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## Errors

Every error has this shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The claim cannot be submitted yet.",
    "requestId": "8c5e…",
    "details": [
      {
        "field": "receipt",
        "code": "RECEIPT_REQUIRED",
        "message": "A receipt is required for this amount."
      }
    ]
  }
}
```

| Status | Codes                                                                                                                            | Meaning                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`                                                                                                              | Malformed input, a business-rule violation, or a missing idempotency key.    |
| 401    | `UNAUTHENTICATED`                                                                                                                | No local user is selected.                                                   |
| 403    | `FORBIDDEN`, `SELF_REVIEW_FORBIDDEN`                                                                                             | The user may see the item but may not perform this operation.                |
| 404    | `NOT_FOUND`                                                                                                                      | The item does not exist **or the user may not see it**, or no such endpoint. |
| 409    | `VERSION_CONFLICT`, `INVALID_TRANSITION`, `CLAIM_NOT_EDITABLE`, `CLAIM_NOT_DELETABLE`, `CATEGORY_IN_USE`, `IDEMPOTENCY_CONFLICT` | The request conflicts with the current state.                                |
| 413    | `PAYLOAD_TOO_LARGE`                                                                                                              | Body over 64 KB, or a receipt over 10 MB.                                    |
| 500    | `INTERNAL_ERROR`                                                                                                                 | Unexpected failure. The message is generic; details are only in server logs. |

## Endpoints

| Method | Path                             | Who                   | Purpose                                                                                                                                               |
| ------ | -------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                        | anyone                | Liveness check.                                                                                                                                       |
| GET    | `/session`                       | anyone                | Current user (or `null`) and the selectable local users; on AWS, the current user only, with an empty `users` list.                                   |
| PUT    | `/session`                       | anyone                | Select a local user. Body: `{ userId }`. Local runtime only.                                                                                          |
| DELETE | `/session`                       | anyone                | Sign out. Local runtime only.                                                                                                                         |
| GET    | `/categories`                    | signed in             | All categories, sorted by name.                                                                                                                       |
| POST   | `/categories`                    | administrator         | Create a category.                                                                                                                                    |
| PATCH  | `/categories/{categoryId}`       | administrator         | Change name, currency, limits, threshold, or `active`.                                                                                                |
| DELETE | `/categories/{categoryId}`       | administrator         | Delete a category no claim uses (`409 CATEGORY_IN_USE` otherwise; deactivate it instead). Body: `{ expectedVersion }`.                                |
| GET    | `/me/claims`                     | employee              | The user's claims, most recently updated first.                                                                                                       |
| GET    | `/review-queue`                  | manager               | Submitted and under-review claims assigned to the user, oldest submission first.                                                                      |
| GET    | `/claims?status=`                | administrator         | All claims, optionally in one status, most recently updated first.                                                                                    |
| POST   | `/claims`                        | employee              | Create a draft. Every field is optional.                                                                                                              |
| GET    | `/claims/{claimId}`              | owner, manager, admin | Claim details with the user's `permissions`.                                                                                                          |
| PATCH  | `/claims/{claimId}`              | owner                 | Edit a draft. `null` clears a field; absent fields are unchanged.                                                                                     |
| DELETE | `/claims/{claimId}`              | owner                 | Delete a draft that was never submitted, with its history and receipt. Body: `{ expectedVersion }`.                                                   |
| GET    | `/claims/{claimId}/history`      | owner, manager, admin | History entries, oldest first.                                                                                                                        |
| POST   | `/claims/{claimId}/submit`       | owner                 | Submit or resubmit. Re-evaluates category policy.                                                                                                     |
| POST   | `/claims/{claimId}/start-review` | assigned manager      | Start the review.                                                                                                                                     |
| POST   | `/claims/{claimId}/approve`      | assigned manager      | Approve. Body requires a nonblank `comment`.                                                                                                          |
| POST   | `/claims/{claimId}/reject`       | assigned manager      | Reject. Body requires a nonblank `comment`.                                                                                                           |
| POST   | `/claims/{claimId}/reopen`       | owner                 | Return a rejected claim to `DRAFT`.                                                                                                                   |
| POST   | `/claims/{claimId}/mark-paid`    | administrator         | Mark an approved claim as paid.                                                                                                                       |
| POST   | `/receipts`                      | employee              | Upload a receipt: the raw file locally, or on AWS a JSON declaration that returns a presigned S3 form.                                                |
| PUT    | `/claims/{claimId}/receipt`      | owner                 | Attach or replace the draft's receipt.                                                                                                                |
| DELETE | `/claims/{claimId}/receipt`      | owner                 | Remove the draft's receipt. Body: `{ expectedVersion }`.                                                                                              |
| GET    | `/claims/{claimId}/receipt`      | owner, manager, admin | Download the receipt (`Content-Disposition: inline`). On the AWS runtime: `{ url, expiresAt }`, a five-minute presigned URL the browser navigates to. |

Successful deletions return `204 No Content`. Lifecycle action bodies are `{ "expectedVersion": 3 }`, plus `"comment"` for approve and reject.

### Claim responses

Claims are returned with display names and the current user's permissions, computed by the server:

```json
{
  "claimId": "4ce0c74b-…",
  "employee": { "userId": "u-aisha", "displayName": "Aisha Rahman" },
  "assignedManager": { "userId": "u-ben", "displayName": "Ben Tan" },
  "categoryId": "travel",
  "categoryName": "Travel",
  "amount": { "amountMinor": 45000, "currency": "MYR" },
  "expenseDate": "2026-10-08",
  "merchant": "Regional Airline",
  "businessPurpose": "Client workshop at the regional office",
  "receipt": {
    "receiptId": "…",
    "fileName": "flight.pdf",
    "contentType": "application/pdf",
    "sizeBytes": 52144,
    "checksumSha256": "9f2c…",
    "attachedAt": "2026-10-14T10:40:00.000Z"
  },
  "status": "SUBMITTED",
  "version": 4,
  "createdAt": "…",
  "updatedAt": "…",
  "submittedAt": "…",
  "permissions": { "canEdit": false, "actions": [] }
}
```

### Receipt upload

Receipts are uploaded in two steps so the server can measure the file before it is attached. The two runtimes differ in step 1 and in how replaced and abandoned files are cleaned up; step 2 is the same.

1. **Upload the file.**

   - **Local runtime (raw upload).** `POST /receipts` with the raw file as the body, `Content-Type` set to `application/pdf`, `image/jpeg`, or `image/png`, and an optional URI-encoded `X-File-Name` header. The server checks the type against the file's leading bytes, enforces 1 byte–10 MB, computes the SHA-256 checksum, and returns `201` with `{ receiptId, fileName, contentType, sizeBytes, checksumSha256, uploadedAt }`.
   - **Deployed AWS runtime (presigned upload).** `POST /receipts` with `Content-Type: application/json` and a declaration `{ fileName, contentType, sizeBytes, checksumSha256 }`. It returns `201` with `{ receiptId, form: { url, fields } }`, and a replay returns the same receipt with a newly signed form. The web application, in Cognito mode, then posts a `FormData` with every returned field followed by the file directly to `form.url` (S3), with no `Authorization` header and no explicit `Content-Type`, and goes to step 2 only after S3 answers successfully. The API never receives the file; it inspects the uploaded object when the receipt is attached. The local runtime does not serve this variant.

2. `PUT /claims/{claimId}/receipt` with `{ expectedVersion, receiptId, contentType, sizeBytes, checksumSha256 }`, where the metadata is what the client computed for the file it sent. Mismatches fail with `RECEIPT_MISMATCH`. An upload that is missing, belongs to someone else, or is already attached to another claim fails with `RECEIPT_UNAVAILABLE`.

**Cleanup.**

- **Local runtime:** replacing a receipt deletes the old file at once, and uploads never attached to a claim are deleted when the API starts if they are older than 24 hours (startup cleanup).
- **Deployed AWS runtime:** there is no startup cleanup. Replacing or removing a receipt writes a cleanup event, and the outbox publisher, EventBridge, and the cleanup worker delete the old S3 object asynchronously after the response. An upload that is never attached is cleaned up by two independent paths (see [the AWS architecture](aws-architecture.md)): when DynamoDB TTL deletes the pending metadata record, that deletion triggers the receipt janitor, which deletes the upload's objects; separately, the bucket's S3 lifecycle rule expires pending objects (`uploads/pending/`) after a day, which also catches a pending object whose best-effort deletion after a successful attach failed. The browser verification on 21 October 2026 observed the asynchronous deletion after a replacement and a removal; it did not separately verify either abandoned-upload path (the TTL-triggered janitor or the S3 lifecycle rule).

## Logging

The API writes one JSON object per line to standard output. Each request is logged as `http.request` with `requestId`, `correlationId`, `method`, `route` (the pattern, not the raw path), `operation`, `actorId`, `claimId`, `status`, `outcome`, `replayed`, and `durationMs`. Request bodies, receipt contents, and cookies are never logged. Unexpected errors are logged with their stack trace.
