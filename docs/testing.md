# Testing

ClaimFlow uses Vitest in every workspace. The suites are layered so that each one proves one kind of thing, and this guide says which kind of evidence each layer is. **Automated tests make no AWS calls.** The AWS adapters are tested against fakes, the infrastructure is tested by synthesizing the stack locally, and the deployed environment has only a dated **manual** browser verification, described [at the end](#manual-aws-browser-verification). No automated test exercises the cloud.

## Commands and CI

From the repository root:

```text
npm test                       # every workspace
npm run test:coverage          # with V8 coverage reports in each workspace's coverage/
npm test -w @claimflow/api     # one workspace
npm run check                  # format:check, typecheck, lint, and tests
```

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs, after `npm ci`: `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm run test:coverage`, `npm test -w @claimflow/infrastructure`, `npm run build`, and `npm audit --omit=dev --audit-level=high`. The infrastructure workspace has no `test:coverage` script, so it is run explicitly rather than twice. CI has no deployment step. The readiness record documents that a GitHub Actions run of this workflow passed on 22 October 2026 ([publication state](engineering-readiness.md#publication-state-22-october-2026)). That is recorded historical evidence, not a check repeated for this guide, and it describes that run only.

**Coverage actually enforced.** Only the domain package has thresholds: 90% branches, functions, lines, and statements ([`packages/domain/vitest.config.ts`](../packages/domain/vitest.config.ts)). The other workspaces collect coverage without a threshold: `contracts` over `src`, `api` over `src` excluding `main.ts`, `reset-data.ts`, and `local-config.ts` ([`services/api/vitest.config.ts`](../services/api/vitest.config.ts)), and `web` over `src` excluding `main.tsx` ([`apps/web/vite.config.ts`](../apps/web/vite.config.ts)). A passing run is not a claim of security or cloud correctness.

## What each layer proves

| Layer                                 | Where                                                                                                                                                                                                 | Proves                                                                                                               | Does not prove                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Domain unit tests                     | [`packages/domain/test`](../packages/domain/test/)                                                                                                                                                    | Business rules as pure functions                                                                                     | Anything about storage, HTTP, or AWS                                       |
| Contract schemas                      | [`packages/contracts/test`](../packages/contracts/test/)                                                                                                                                              | Strict request validation                                                                                            | Server behavior                                                            |
| Local application and adapters        | [`services/api/test/application.test.ts`](../services/api/test/application.test.ts)                                                                                                                   | Services over the real local adapters in a temporary directory                                                       | DynamoDB or S3 semantics                                                   |
| Request pipeline and transports       | [`api-handler.test.ts`](../services/api/test/api-handler.test.ts), [`lambda-adapter.test.ts`](../services/api/test/lambda-adapter.test.ts), [`aws-api.test.ts`](../services/api/test/aws-api.test.ts) | Routing, auth boundary, limits, idempotency, headers, and payload-v2 translation, with hand-built events             | A real API Gateway or authorizer                                           |
| Local end to end                      | [`http-api.test.ts`](../services/api/test/http-api.test.ts) and the steps [below](#local-end-to-end-steps)                                                                                            | The local server, cookie sessions, and the full workflow                                                             | The AWS runtime                                                            |
| AWS adapters and services, with fakes | `dynamodb-*`, `s3-*`, `aws-*`, outbox, cleanup, and janitor tests in [`services/api/test`](../services/api/test/)                                                                                     | Our code builds the intended DynamoDB, S3, and EventBridge requests and handles the responses and errors we simulate | That real AWS behaves as the fakes do                                      |
| Lambda entry points                   | `*-lambda.test.ts` in [`services/api/test`](../services/api/test/)                                                                                                                                    | Module wiring with SDK clients mocked, required environment variables, and the exported `handler`                    | Anything running in Lambda                                                 |
| Synthesized infrastructure            | [`infrastructure/test`](../infrastructure/test/)                                                                                                                                                      | The CloudFormation template (resources, settings, IAM, routes, CORS, alarms) and that the Lambda assets bundle       | The behavior of deployed resources                                         |
| Web                                   | [`apps/web/test`](../apps/web/test/)                                                                                                                                                                  | Component and client behavior in jsdom, with the API module or `fetch` faked                                         | A real browser, Cognito, CloudFront, S3, CORS, or assistive technology     |
| Manual deployed verification          | [Below](#manual-aws-browser-verification)                                                                                                                                                             | A dated observation of the deployed flows listed there                                                               | Anything not listed; it is not automated or repeatable from the repository |

Shared helpers: [`services/api/test/support.ts`](../services/api/test/support.ts), [`http-support.ts`](../services/api/test/http-support.ts), [`apps/web/test/fixtures.tsx`](../apps/web/test/fixtures.tsx).

## Risk matrix

### Domain and contracts

- **Lifecycle and authorization:** every valid transition and invalid status pair ([`lifecycle.test.ts`](../packages/domain/test/lifecycle.test.ts)); ownership, manager assignment, self-review prevention, administrator-only payment and no self-payment ([`authorization.test.ts`](../packages/domain/test/authorization.test.ts)).
- **Policy and money:** required submission fields reported together, category limits and receipt thresholds at the boundary, policy re-evaluation on resubmission ([`submission.test.ts`](../packages/domain/test/submission.test.ts), [`category.test.ts`](../packages/domain/test/category.test.ts)); money as positive safe integers with three-letter currencies.
- **Receipts and deletion:** type, size boundary, file-type detection, name sanitizing, checksum format, mismatch and reuse ([`receipt.test.ts`](../packages/domain/test/receipt.test.ts)); draft deletion only for an owned draft that was never submitted ([`deletion.test.ts`](../packages/domain/test/deletion.test.ts)).
- **Schemas:** strict request schemas reject identity, role, and status fields, with `null` versus absent handled, plus pagination and idempotency-key validation ([`schemas.test.ts`](../packages/contracts/test/schemas.test.ts)).

### Local application, pipeline, and end to end

- **Persistence and concurrency:** state survives restarts, unreadable data is never overwritten, a failed write leaves no partial state, and concurrent edits at one expected version have exactly one winner.
- **Idempotency:** replay, per-actor scope, key reuse, in-progress requests, and release after failures.
- **Pipeline:** routing and `404` for unknown paths, `401` before a body is read, body-size limits, required idempotency keys with the replay header, request and correlation IDs, hidden internal errors, and one structured log entry per request.
- **API contract:** [`openapi.test.ts`](../services/api/test/openapi.test.ts) checks that [`docs/openapi.yaml`](openapi.yaml) documents exactly the implemented routes.
- **Server workflow:** [`http-api.test.ts`](../services/api/test/http-api.test.ts) drives the real server through the draft-to-paid workflow, visibility (`404` for claims a user may not see), role checks, receipts, draft deletion with its history, and restart persistence.
- **Authentication boundary:** only the authorizer's validated `sub` becomes the actor, roles come from the directory, and the AWS route set has no `PUT` or `DELETE /session` ([`aws-api.test.ts`](../services/api/test/aws-api.test.ts)).

### AWS adapters and services (fakes only)

- **Storage correctness:** strict item codecs that reject malformed stored items without echoing values, canonical key and cursor encoding, and query shapes with no scans ([`dynamodb-items.test.ts`](../services/api/test/dynamodb-items.test.ts), [`dynamodb-cursor.test.ts`](../services/api/test/dynamodb-cursor.test.ts), [`dynamodb-claim-reader.test.ts`](../services/api/test/dynamodb-claim-reader.test.ts)).
- **Transactions and idempotency:** business writes composed with the idempotency record and a deterministic `ClientRequestToken`, one send through the executor, replay and conflict resolution through the record ([`dynamodb-claim-writer.test.ts`](../services/api/test/dynamodb-claim-writer.test.ts), [`dynamodb-idempotent-transaction-committer.test.ts`](../services/api/test/dynamodb-idempotent-transaction-committer.test.ts), [`claim-mutation-coordinator.test.ts`](../services/api/test/claim-mutation-coordinator.test.ts)).
- **Services and recovery:** each claim, receipt, and category service with the real domain rules, bounded recovery from a cancelled transaction (only `TransactionCanceledException`, a capped number of attempts, rereads, stable event IDs), and rejections stored only for expected business errors ([`aws-claim-creation-service.test.ts`](../services/api/test/aws-claim-creation-service.test.ts), [`aws-receipt-attachment-service.test.ts`](../services/api/test/aws-receipt-attachment-service.test.ts), [`aws-category-service.test.ts`](../services/api/test/aws-category-service.test.ts)).
- **Through the pipeline:** the services served by the real AWS routes ([`aws-claim-mutations-api.test.ts`](../services/api/test/aws-claim-mutations-api.test.ts), [`aws-receipt-api.test.ts`](../services/api/test/aws-receipt-api.test.ts)), and the whole composition over a fake document client ([`aws-composition.test.ts`](../services/api/test/aws-composition.test.ts)), including that a registered operation never falls back to local services.
- **Receipts and S3:** the presigned upload form conditions, object inspection, final-object steps, and download URLs, with fake signers that send nothing ([`s3-upload-form.test.ts`](../services/api/test/s3-upload-form.test.ts), [`s3-receipt-inspector.test.ts`](../services/api/test/s3-receipt-inspector.test.ts), [`s3-download-url.test.ts`](../services/api/test/s3-download-url.test.ts)).
- **Asynchronous work:** event builders, the publication workflow and stream handler, the sweeper and its oldest-pending-age metric (one Embedded Metric Format line, the age taken from a single clock reading and emitted before publication), the cleanup worker, the history purger, and the janitor ([`outbox-publication.test.ts`](../services/api/test/outbox-publication.test.ts), [`outbox-sweeper.test.ts`](../services/api/test/outbox-sweeper.test.ts), [`oldest-pending-outbox-metric.test.ts`](../services/api/test/oldest-pending-outbox-metric.test.ts), [`cleanup-worker-handler.test.ts`](../services/api/test/cleanup-worker-handler.test.ts), [`receipt-janitor-handler.test.ts`](../services/api/test/receipt-janitor-handler.test.ts)).
- **Entry points:** each Lambda module is imported with the SDK mocked, fails with a fixed message when a required environment variable is missing, and exports only `handler` (for example [`api-lambda.test.ts`](../services/api/test/api-lambda.test.ts), [`outbox-sweeper-lambda.test.ts`](../services/api/test/outbox-sweeper-lambda.test.ts)).

### Synthesized infrastructure

[`claimflow-stack.test.ts`](../infrastructure/test/claimflow-stack.test.ts) synthesizes the stack, which bundles every Lambda with esbuild, and asserts on the template. It checks the exact resource set and settings, the absence of resources the design excludes, the IAM policy of each function role (including that nothing gains a CloudWatch permission), the HTTP API routes against the application's route table, the JWT authorizer, CORS, and throttling, the 17 alarms and their ALARM-only actions, the SNS topic policy, and the required `NoEcho` email parameter. These tests check the template, not deployed behavior.

### Web

[`apps/web/test`](../apps/web/test/) uses React Testing Library in jsdom.

- **Local mode:** the development sign-in notice and user chooser, role-sensitive navigation and gated pages, user switching that clears the previous user's data and drops late responses ([`session.test.tsx`](../apps/web/test/session.test.tsx)); claim lists, forms, conflicts, actions, receipts, and drafts ([`claims.test.tsx`](../apps/web/test/claims.test.tsx)); category administration ([`admin.test.tsx`](../apps/web/test/admin.test.tsx)); money handling and the API client ([`units.test.ts`](../apps/web/test/units.test.ts)).
- **Cognito mode, with the network and hosted UI faked:** PKCE and `state` generation and single use, the code exchange and callback errors, session-only token storage, the Bearer access token, refresh before expiry and once after a `401`, a rejected refresh returning to sign-in (including on the first `GET /session`), sign-out through the Cognito logout endpoint, and unchanged local behavior ([`auth.test.ts`](../apps/web/test/auth.test.ts), [`client-auth.test.ts`](../apps/web/test/client-auth.test.ts), [`cognito-session.test.tsx`](../apps/web/test/cognito-session.test.tsx), [`cognito-initial-session.test.tsx`](../apps/web/test/cognito-initial-session.test.tsx)).
- **Runtime configuration:** `config.json` validation, and the development-sign-in fallback only on `localhost` and `127.0.0.1` (in `auth.test.ts`).
- **AWS receipts:** the declaration, an S3 form with every field before the file, no bearer token or credentials sent to S3, S3 and API failures, and downloads that navigate only to an https presigned URL ([`receipt-aws-api.test.ts`](../apps/web/test/receipt-aws-api.test.ts), [`receipt-aws-panel.test.tsx`](../apps/web/test/receipt-aws-panel.test.tsx)).
- **Release:** input validation, the exact `config.json`, cache-control planning, and no usable `dist/` after any failure ([`release.test.ts`](../apps/web/test/release.test.ts)).
- **Router-test race (resolved):** the callback tests once failed intermittently under load because they read the router location the moment the session UI appeared, while React Router applies navigation as a lower-priority update. They now wait for the location with `waitFor` ([`cognito-session.test.tsx`](../apps/web/test/cognito-session.test.tsx)). The cause was inferred from how the router applies updates, and the fix was checked by repeated full-suite runs and runs under CPU load, not by capturing the original failure.

### Third-party notice delivery

- **Web:** every real web build runs a Vite plugin that finds each bundled npm package and installed version, fails the build naming any `package@version` missing from [`THIRD_PARTY_NOTICES.txt`](../THIRD_PARTY_NOTICES.txt), and only then emits the file. The completeness check is therefore exercised by building (`npm run build -w @claimflow/web`). [`notices.test.ts`](../apps/web/test/notices.test.ts) holds fast unit tests of the plugin logic with fake module ids and runs no production build; `release.test.ts` covers the release refusing output without the file.
- **Lambda:** the infrastructure test checks that every synthesized Lambda asset contains an identical copy of the file, that the file lists every package esbuild bundles for the five handlers, and that the template does not mention the file.
- **Limits:** nothing flags stale extra entries, the Lambda test mirrors rather than reuses CDK's esbuild invocation, and none of these tests exercises publication. The readiness record documents that the web files were republished with the notice and that it is publicly served (22 October 2026); that was a manual publication step recorded after the fact, not an automated check. See [the readiness record](engineering-readiness.md#publication-state-22-october-2026).

## Local end-to-end steps

With `npm run dev` running, perform the workflow described in the [README](../README.md):

1. Create and edit a draft, and attach a receipt.
2. Submit the claim, start the review as the assigned manager, and approve or reject it with a comment.
3. Reopen and resubmit a rejected claim, then mark an approved claim as paid.
4. Confirm the history records each step and that other users receive "not found".
5. Restart the app and confirm the data is still present.
6. Stop the app, run `npm run reset-data`, start it again, and confirm only the default categories remain.

## Manual AWS browser verification

This is a dated manual check, not an automated test: nothing in the repository runs it, and no automated test exercises the deployed environment.

**21 October 2026**, in a browser against the deployed environment:

- the web application, published to the web assets bucket and opened through CloudFront, loaded its runtime configuration (`/config.json`);
- Cognito sign-in with PKCE and the `/auth/callback` exchange worked, and the protected session, claim list, and claim detail requests succeeded;
- receipt upload, download, and replacement worked, and the replaced S3 object was deleted asynchronously;
- receipt removal worked: the claim went to version 5 with no attached receipt and a "Removed receipt" history entry, the final S3 receipt object was deleted asynchronously, and all four ClaimFlow queues were empty afterwards;
- the alarm email subscription was confirmed, and a manual `claimflow-api-errors` ALARM transition delivered an email.

**Limits.**

- The asynchronous deletions support the publisher → EventBridge → cleanup-worker path only. The receipt janitor, the scheduled outbox sweeper, and the S3 lifecycle rule were not separately verified.
- No OK action is configured, so the return to OK was neither notified nor exercised.
- Only the flows listed above are recorded as verified; other flows, such as review, payment, and category administration, have no recorded browser verification.
- Accessibility, security headers, load, and recovery were not tested, and the check is not automated or repeatable from the repository.
