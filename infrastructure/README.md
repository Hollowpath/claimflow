# ClaimFlow infrastructure

AWS CDK (TypeScript) application for ClaimFlow's AWS resources: one stack, `ClaimFlow` (class `ClaimFlowStack` in `lib/claimflow-stack.ts`), always in **`ap-southeast-1`**, in the account of the credentials the CDK CLI runs with (`CDK_DEFAULT_ACCOUNT`). The design and its guarantees are in [docs/aws-architecture.md](../docs/aws-architecture.md); runtime behavior and the HTTP contract are in [docs/api.md](../docs/api.md); test layers and the dated manual verification (with its limits) are in [docs/testing.md](../docs/testing.md).

**Status.** Everything below is defined in the stack and deployed manually by the operator. The 21 October 2026 browser verification and alarm test are recorded, with exactly what they do and do not cover, in [the testing guide](../docs/testing.md#manual-aws-browser-verification) and [the architecture document](../docs/aws-architecture.md#verified-deployed-state). Deployment is never automatic and never runs from CI.

## Commands

Run from `infrastructure/` (or with `-w @claimflow/infrastructure` from the root):

```text
npm run typecheck     # tsc --noEmit
npm run build         # tsc
npm test              # Vitest: synthesizes the stack and bundles the Lambdas with esbuild (no Docker, no AWS)
npx cdk synth         # emit the CloudFormation template locally
npx cdk diff          # compare with the deployed stack (reads AWS)
npx cdk deploy --parameters AlarmNotificationEmail=<email>
```

`cdk bootstrap` and `cdk deploy` change an AWS account; run them only deliberately. `synth`, `diff`, and the tests do not need the email parameter. `AlarmNotificationEmail` is a required `NoEcho` parameter with no default; later deployments reuse the stored value unless you pass `--no-previous-parameters`, and CloudFormation masks it in the console and in `describe-stacks`. In a new environment, open the confirmation message SNS sends to that address and confirm the subscription: until then no alarm email is delivered.

## Resource inventory

| Resource                                                    | Stack property                                                                       | Notes                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| DynamoDB table `ClaimFlow`                                  | `table`                                                                              | Single table, four GSIs, stream, TTL     |
| Cognito user pool, web app client, classic hosted UI domain | `userPool`, `webClient`, `userPoolDomain`                                            | Administrator-created users              |
| S3 receipt bucket                                           | `receiptBucket`                                                                      | Private; one CORS rule                   |
| S3 web assets bucket and CloudFront distribution            | `webAssetsBucket`, `webDistribution`                                                 | Private bucket, Origin Access Control    |
| EventBridge bus `claimflow`, cleanup queue and dead letter  | `eventBus`, `cleanupQueue`, `cleanupDeadLetterQueue`                                 | One rule for the two `internal.*` events |
| Five Lambda functions with roles and log groups             | `apiFunction`, `cleanupWorker`, `outboxPublisher`, `receiptJanitor`, `outboxSweeper` | Own role and 30-day log group each       |
| Failure queues and the sweeper schedule                     | `outboxFailureQueue`, `janitorFailureQueue`, `outboxSweeperSchedule`                 |                                          |
| HTTP API with JWT authorizer, routes, invoke permissions    | `httpApi`, `apiAuthorizer`                                                           | 24 explicit routes                       |
| 17 CloudWatch alarms; SNS topic, email subscription         | `alarms`, `alarmTopic`                                                               | ALARM actions only                       |

The stack grants no IAM permissions beyond the CloudFront read grant on the web bucket and the five function roles. Queue and topic policies are generated resource policies, not IAM roles. There are no customer-managed KMS keys.

## Data and identity

### DynamoDB table `ClaimFlow`

`TableV2` (an `AWS::DynamoDB::GlobalTable` with a single replica). Keys `PK` and `SK` (strings); on-demand billing; TTL attribute `expiresAt`; stream `NEW_AND_OLD_IMAGES`; point-in-time recovery and deletion protection enabled; DynamoDB-owned encryption; removal policy `RETAIN`. Four GSIs (`GSI1`–`GSI4`, string `GSInPK`/`GSInSK`, `ALL` projection); their meaning is in section 5 of the architecture document.

### Cognito user pool, app client, and hosted UI

| Setting            | Value                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feature plan       | Lite, set explicitly; no Essentials or Plus features                                                                                                                           |
| User creation      | Administrators only; self-service sign-up disabled                                                                                                                             |
| Sign-in / recovery | Email address, case-insensitive; account recovery by verified email only                                                                                                       |
| Password policy    | At least 12 characters with upper case, lower case, digits, and symbols; temporary passwords 7 days                                                                            |
| MFA                | Optional, TOTP only; SMS disabled                                                                                                                                              |
| Protection         | Deletion protection on; removal policy `RETAIN`                                                                                                                                |
| App client         | `ClaimFlowWeb`: public (no secret); authorization code grant only; only `ALLOW_REFRESH_TOKEN_AUTH`; identity provider `COGNITO` only                                           |
| Scopes and tokens  | `openid`, `email`; access and ID tokens 1 hour, refresh tokens 30 days; revocation on; user-existence errors prevented                                                         |
| Redirects          | Callback `https://<CloudFront domain>/auth/callback` (default) and `http://localhost:5173/auth/callback`; sign-out `https://<CloudFront domain>/` and `http://localhost:5173/` |
| Hosted UI          | Classic hosted UI on prefix domain `claimflow-<account ID>`, default styling (the Lite plan has no managed login)                                                              |

Every user needs a verified email address: when creating one with `AdminCreateUser`, set `email` together with `email_verified=true`, or the user cannot recover the account. Roles and manager assignments are DynamoDB profile items keyed by the user's `sub`; Cognito holds no groups or role attributes. The stack creates no users, groups, federated providers, Lambda triggers, or SES configuration. Users are created outside the stack.

## Storage and hosting

### S3 receipt bucket

Generated name; all public access blocked; SSE-S3; the bucket policy denies requests where `aws:SecureTransport` is `false`; versioning disabled (receipts are never modified once attached); objects under `uploads/pending/` expire after 1 day; no lifecycle rule on `receipts/`, whose objects only the cleanup worker deletes; removal policy `RETAIN`; no auto-delete. The layout and upload contract are in section 11 of the architecture document.

**CORS:** exactly one rule: origin `https://<CloudFront domain>` only, method `POST` only, headers `*`, no exposed headers, no max age. It lets the browser send presigned POST uploads but grants no authorization; every upload still needs a valid presigned policy. The TLS policy is a separate `AWS::S3::BucketPolicy` that is deleted with the stack while the bucket is retained.

### Web assets bucket and CloudFront

The web assets bucket has the same protections as the receipt bucket (private, SSE-S3, TLS-only policy, `RETAIN`, no auto-delete, no website hosting, versioning disabled), and a read grant for only `s3:GetObject`, only to CloudFront, only for requests from this distribution (added to its bucket policy).

| CloudFront setting | Value                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin             | The web assets bucket through Origin Access Control (SigV4); no origin access identity                                                                           |
| Viewer             | HTTP redirected to HTTPS; `GET` and `HEAD` only                                                                                                                  |
| Cache policy       | Managed `CachingOptimized`, with compression                                                                                                                     |
| Root object        | `index.html`                                                                                                                                                     |
| Missing paths      | S3 `403` and `404` become `/index.html` with status `200`, so client-side routes load (CloudFront cannot list the bucket, so S3 answers `403` for a missing key) |
| Domain             | Default `*.cloudfront.net` domain and certificate; no custom domain, ACM certificate, or WAF                                                                     |

The distribution serves static files only and does not route API requests: the web app calls the HTTP API directly at the `apiBaseUrl` in its `config.json`.

## Event delivery and functions

### Bus, queues, and rule

- Custom EventBridge bus `claimflow`.
- Queue `claimflow-cleanup`: SQS-managed encryption, TLS enforced, 4-day retention, 6-minute visibility timeout, redrive to the dead letter after 5 receives. Queue `claimflow-cleanup-dlq`: same protections, 14-day retention.
- Rule `claimflow-cleanup` on the bus: source `claimflow.api` and detail types `internal.receipt-object-deletion-requested` and `internal.claim-history-purge-requested` only, targeting the cleanup queue (with the dead letter as the target's delivery dead letter). CDK generates the queue policies: TLS enforcement and a statement allowing only this rule to send.
- Failure queues `claimflow-outbox-publisher-failures` and `claimflow-receipt-janitor-failures`: standard, SQS-managed encryption, TLS enforced, 14-day retention. They receive the metadata of stream batches that exhausted their retries, not the events (unpublished outbox items stay pending for the sweeper).

### Lambda functions

All five run Node.js 24 on ARM64 with tracing disabled and no VPC, layer, or reserved concurrency, and each has its own role and a log group `/aws/lambda/<function>` with 30-day retention. They are bundled by `NodejsFunction` with the pinned `esbuild` (the workspaces' `source` export condition and the pinned AWS SDK, no Docker), and a bundling hook copies `THIRD_PARTY_NOTICES.txt` next to `index.js` in each asset. Entry points are in `services/api/src/adapters/aws/`.

| Function                     | Size / timeout                                  | Environment                                             | Trigger                                                                                                             |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `claimflow-api`              | 512 MB / 29 s (under the HTTP API's 30 s limit) | `CLAIMFLOW_TABLE_NAME`, `CLAIMFLOW_RECEIPT_BUCKET_NAME` | The HTTP API only (one invoke permission per route)                                                                 |
| `claimflow-cleanup-worker`   | 256 MB / 60 s                                   | `CLAIMFLOW_TABLE_NAME`, `CLAIMFLOW_RECEIPT_BUCKET_NAME` | SQS mapping from `claimflow-cleanup`: batch 10, no window, partial-batch failure reporting                          |
| `claimflow-outbox-publisher` | 256 MB / 60 s                                   | `CLAIMFLOW_TABLE_NAME`, `CLAIMFLOW_EVENT_BUS_NAME`      | Table stream, filter `INSERT` with `SK` beginning `OUTBOX#`                                                         |
| `claimflow-receipt-janitor`  | 256 MB / 60 s                                   | `CLAIMFLOW_RECEIPT_BUCKET_NAME`                         | Table stream, filter `REMOVE` by `dynamodb.amazonaws.com` with a `PENDING` `Receipt` old image (a TTL expiry)       |
| `claimflow-outbox-sweeper`   | 256 MB / 60 s                                   | `CLAIMFLOW_TABLE_NAME`, `CLAIMFLOW_EVENT_BUS_NAME`      | Rule `claimflow-outbox-sweeper-schedule`, `rate(15 minutes)`, 2 retries, maximum event age 1 hour; no failure queue |

The two stream mappings start at `LATEST` with batch size 10, partial-batch failure reporting, batch bisection, 5 retry attempts, a 24-hour maximum record age, and the function's failure queue as the destination. The cleanup mapping keeps the queue's 6-minute visibility timeout and the redrive after 5 receives; the dead letter is not an event source. The enabled sweeper schedule runs, and queries `GSI4`, even when no events exist.

### Least-privilege IAM boundaries

| Function                     | Allowed (and only this)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimflow-api`              | Log writes; on the table ARN `GetItem`, `BatchGetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem` (a transaction is authorized by its operations' permissions); `Query` on `GSI1`–`GSI4`; `s3:GetObject` and `s3:PutObject` on `receipts/*` and `uploads/pending/*`; `s3:DeleteObject` on `uploads/pending/*` only; `s3:ListBucket` on the receipt bucket (so S3 answers a missing key `404`, not `403`). No stream, EventBridge, SQS, or Cognito permission; cannot delete final receipts. |
| `claimflow-cleanup-worker`   | Log writes; consuming `claimflow-cleanup`; on the table ARN (not its indexes) `Query` and `BatchWriteItem`; `s3:DeleteObject` on `receipts/*` only                                                                                                                                                                                                                                                                                                                                                                     |
| `claimflow-outbox-publisher` | Log writes; on the table ARN (not its indexes) `GetItem` and `UpdateItem`; `events:PutEvents` on the `claimflow` bus; reading the table stream; sending to its failure queue                                                                                                                                                                                                                                                                                                                                           |
| `claimflow-receipt-janitor`  | Log writes; `s3:DeleteObject` on `receipts/*` and `uploads/pending/*`; reading the table stream; sending to its failure queue. No table-item permission                                                                                                                                                                                                                                                                                                                                                                |
| `claimflow-outbox-sweeper`   | Log writes; `Query` on `GSI4`; `GetItem` and `UpdateItem` on the table ARN; `events:PutEvents` on the `claimflow` bus. No stream, S3, or SQS permission                                                                                                                                                                                                                                                                                                                                                                |

Reading the stream means `DescribeStream`, `GetRecords`, `GetShardIterator`, and `ListStreams` on the stream ARN. No role has a CloudWatch permission: the oldest-pending-age metric is written as a log line, not with `PutMetricData`. IAM cannot separate outbox items from claims inside `GSI4`.

## HTTP API

API `claimflow-api` (`httpApi`) with the `$default` stage (auto-deploy, no custom domain) and one payload-format-2.0 Lambda proxy integration with the API function.

- **Routes:** every route is listed explicitly as `METHOD /api/v1/...` (`CLAIMFLOW_API_PUBLIC_ROUTES`, `CLAIMFLOW_API_PROTECTED_ROUTES`); a test compares the list with the application's route table. There is no `$default`, `ANY`, or `{proxy+}` route.
- **Authorization:** only `GET /api/v1/health` is public. Every other route, including `GET /api/v1/session`, uses the JWT authorizer `claimflow-cognito`: identity source `$request.header.Authorization`, issuer the user pool, audience the `ClaimFlowWeb` client, required scope `openid`. A Cognito access token has a `scope` claim and `client_id`; an ID token has no `scope`, so it is refused.
- **Invocation:** one `lambda:InvokeFunction` permission per route for `apigateway.amazonaws.com`, limited to this API, any stage and method, and the route's path.
- **CORS:** the CloudFront HTTPS origin only; methods `GET`, `POST`, `PUT`, `PATCH`, `DELETE`; request headers `Authorization`, `Content-Type`, `Idempotency-Key`; exposed headers `X-Request-Id`, `X-Correlation-Id`; no credentials; preflight cached 10 minutes.
- **Throttling:** the default stage allows 20 requests per second with a burst of 40.
- **Not defined:** access logging, a custom domain, a WAF, and a dedicated resource-server scope.

## CloudWatch alarms

17 alarms (names, thresholds, and periods are the exported `CLAIMFLOW_ALARM_*` constants; the stack exposes them as `alarms`). All use standard-resolution metrics (periods are multiples of 60 seconds), compare with `>=`, and treat missing data as not breaching, so idle functions and queues stay OK. There is no dashboard.

| Alarm                                                                                                                                                   | Metric (namespace)                                                        | Condition                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `claimflow-api-5xx-rate`                                                                                                                                | HTTP API `5xx` as a percentage of `Count` (`AWS/ApiGateway`)              | At least 5% in 2 of 3 periods of 5 minutes; a period without requests has no data |
| `claimflow-<function>-errors`                                                                                                                           | `Errors`, Sum (`AWS/Lambda`)                                              | At least 1 in 15 minutes                                                          |
| `claimflow-<function>-throttles`                                                                                                                        | `Throttles`, Sum (`AWS/Lambda`)                                           | At least 1 in 15 minutes                                                          |
| `claimflow-outbox-publisher-iterator-age`, `claimflow-receipt-janitor-iterator-age`                                                                     | `IteratorAge`, Maximum (`AWS/Lambda`)                                     | At least 15 minutes in 3 consecutive periods of 5 minutes                         |
| `claimflow-cleanup-dlq-visible-messages`, `claimflow-outbox-publisher-failures-visible-messages`, `claimflow-receipt-janitor-failures-visible-messages` | `ApproximateNumberOfMessagesVisible`, Maximum (`AWS/SQS`)                 | At least 1 in 5 minutes                                                           |
| `claimflow-oldest-pending-outbox-age`                                                                                                                   | `ClaimFlow/OldestPendingOutboxAge`, Maximum, no dimensions, seconds (EMF) | At least 1800 seconds in 2 consecutive periods of 15 minutes                      |

`<function>` is `api`, `cleanup-worker`, `outbox-publisher`, `receipt-janitor`, or `outbox-sweeper`. The 15-minute Lambda period matches the sweeper's schedule. The 5xx alarm counts responses API Gateway returned (including function errors that become 5xx); the Lambda error alarm counts only unhandled invocation errors. `IteratorAge` exists only for stream consumers, so the sweeper has none. The thresholds are conservative starting points for a low-traffic application: any Lambda error, throttle, or message in a failure queue is a fault, while the API alarm tolerates isolated 5xx responses.

The sweeper reports `ClaimFlow/OldestPendingOutboxAge` as one Embedded Metric Format line on standard output, so CloudWatch Logs extracts it without `PutMetricData` or any IAM permission. Each run reads its clock once and, before publishing, reports 0 when no event is older than the 5-minute grace period, otherwise the whole seconds since the oldest selected event (at most 10 per run). A failure to write the line never stops publication.

### Notifications

- **Topic:** `alarmTopic`, a standard (not FIFO) SNS topic `claimflow-alarms` with the default encryption state and no customer-managed key. Its policy denies `sns:Publish` over plain HTTP and allows `cloudwatch.amazonaws.com` to publish only when `aws:SourceAccount` is this account and `aws:SourceArn` matches `alarm:claimflow-*` in this region and account.
- **Subscription:** one email subscription whose address is the required `NoEcho` parameter `AlarmNotificationEmail` (checked against a simple pattern; never in the source, an output, or a test). It stays pending until its owner confirms it.
- **Actions:** every alarm has the topic as its only `ALARM` action. There are no OK or insufficient-data actions, so recovery sends nothing.

## Publishing the web application

Publishing is manual: the release command never calls AWS, nothing else in the repository uploads files, and the stack never uploads the built files.

1. **Build** (local only). Read `ApiBaseUrl`, `HostedUiBaseUrl`, and `WebClientId` from the stack outputs (the CloudFormation console or `aws cloudformation describe-stacks`).

   ```text
   npm run release -w @claimflow/web -- --api-base-url <ApiBaseUrl> --hosted-ui-url <HostedUiBaseUrl> --client-id <WebClientId>
   ```

   Each value can instead come from `CLAIMFLOW_WEB_API_BASE_URL`, `CLAIMFLOW_WEB_HOSTED_UI_URL`, or `CLAIMFLOW_WEB_CLIENT_ID`; there are no defaults. The command validates the values with the application's runtime rules before building, builds `@claimflow/web`, and writes `apps/web/dist/config.json` with only those three values. The build fails if `THIRD_PARTY_NOTICES.txt` does not list a bundled package, and the release refuses output without the file. `dist/` is deleted first and again on any failure, so a failed run leaves nothing to publish. A plain `npm run build` has no `config.json` and must not be published.

2. **Upload the hashed assets first**, so `index.html` never points at a missing file. Files under `assets/` are content-hashed and never change, so they are cached for a year. Do not use `--delete`: browsers holding an older `index.html` need the older assets.

   ```text
   aws s3 cp apps/web/dist/assets s3://<WebAssetsBucketName>/assets --recursive --cache-control "public, max-age=31536000, immutable"
   ```

3. **Upload everything else last**: `index.html`, `config.json`, `THIRD_PARTY_NOTICES.txt`, and any other root file. They keep their names, so they must be revalidated on every use.

   ```text
   aws s3 cp apps/web/dist s3://<WebAssetsBucketName> --recursive --exclude "assets/*" --cache-control "no-cache, max-age=0"
   ```

4. **Invalidate** the files that keep their names. `CachingOptimized` keeps a `no-cache` object for about a second at most, so this only makes the change visible immediately. The invalidation needs the distribution ID, which is not a stack output, so look it up first and use the returned ID:

   ```text
   aws cloudfront list-distributions --query "DistributionList.Items[?DomainName=='<WebDistributionDomainName>'].Id" --output text
   MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation --distribution-id <id> --paths "/" "/index.html" "/config.json"
   ```

   **Git Bash on Windows:** the `MSYS_NO_PATHCONV=1` prefix is required. Without it Git Bash rewrites arguments that start with `/` (for example `/index.html`) into Windows paths such as `C:/Program Files/Git/index.html`, so the invalidation does not target the intended paths. Shells that do not rewrite paths need no prefix.

5. **Check** `<WebUrl>/config.json`: it must return the JSON with `Content-Type: application/json`. If the file is missing, CloudFront answers with `index.html` and the application shows its configuration error instead of the sample-user chooser, because it is not running on `localhost`.

Add your usual `--profile` and `--region ap-southeast-1` options. Remove old hashed assets only after no browser is expected to hold an old `index.html`.

## Outputs

| Output                      | Value                                                                  |
| --------------------------- | ---------------------------------------------------------------------- |
| `WebUrl`                    | `https://` followed by the distribution's domain name                  |
| `WebDistributionDomainName` | The distribution's `*.cloudfront.net` domain name                      |
| `WebAssetsBucketName`       | The generated name of the web assets bucket                            |
| `WebClientId`               | The ID of the `ClaimFlowWeb` app client                                |
| `HostedUiBaseUrl`           | `https://claimflow-<account ID>.auth.ap-southeast-1.amazoncognito.com` |
| `EventBusName`              | The name of the `claimflow` event bus                                  |
| `CleanupQueueUrl`           | The URL of the cleanup queue                                           |
| `ApiEndpoint`               | The HTTP API invoke URL, without the base path                         |
| `ApiBaseUrl`                | The invoke URL plus `/api/v1`                                          |
| `ApiId`                     | The ID of the HTTP API                                                 |

## Retention and destructive actions

The table and the user pool have deletion protection and `RETAIN` removal policies, so deleting the stack does not delete them or their data; removing either requires disabling deletion protection and deleting it explicitly. The receipt bucket and the web assets bucket are also `RETAIN` with no auto-delete: deleting the stack keeps them and their objects, and removing either requires emptying and deleting it explicitly. The CloudFront distribution and its origin access control are deleted with the stack, as are the app client, the classic hosted UI domain, and the bucket policies. Log groups are destroyed with the stack; the queues, the SNS topic, and the alarms have no explicit retention setting and follow the CDK defaults.
