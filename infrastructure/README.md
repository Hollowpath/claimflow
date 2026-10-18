# ClaimFlow infrastructure

AWS CDK (TypeScript) application for ClaimFlow's AWS infrastructure. The design it implements is described in [docs/aws-architecture.md](../docs/aws-architecture.md).

The application defines a single stack, `ClaimFlow` (class `ClaimFlowStack` in `lib/claimflow-stack.ts`):

- **Region:** always `ap-southeast-1`.
- **Account:** taken from `CDK_DEFAULT_ACCOUNT`, which the CDK CLI sets from the credentials it runs with.

## Resources

The stack defines these resources:

| Resource                                                           | Status                                   |
| ------------------------------------------------------------------ | ---------------------------------------- |
| DynamoDB table `ClaimFlow`                                         | Defined and deployed in `ap-southeast-1` |
| Cognito User Pool `ClaimFlow`                                      | Defined and deployed in `ap-southeast-1` |
| S3 receipt bucket                                                  | Defined and deployed in `ap-southeast-1` |
| Web hosting: S3 web assets bucket and CloudFront distribution      | Defined and deployed in `ap-southeast-1` |
| Cognito web app client `ClaimFlowWeb` and classic hosted UI domain | Defined and deployed in `ap-southeast-1` |
| EventBridge bus `claimflow`, cleanup queue and dead-letter queue   | Defined and deployed in `ap-southeast-1` |
| Cleanup worker Lambda, its role, log group and queue mapping       | Defined and deployed in `ap-southeast-1` |

### DynamoDB table `ClaimFlow`

Defined with the `TableV2` construct, which synthesizes an `AWS::DynamoDB::GlobalTable` with a single replica in `ap-southeast-1`.

| Setting                | Value                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| Keys                   | Partition key `PK` (string), sort key `SK` (string)                             |
| Billing                | On-demand (`PAY_PER_REQUEST`)                                                   |
| TTL attribute          | `expiresAt` (Unix epoch seconds)                                                |
| Stream                 | `NEW_AND_OLD_IMAGES`                                                            |
| Point-in-time recovery | Enabled                                                                         |
| Deletion protection    | Enabled                                                                         |
| Encryption at rest     | DynamoDB owned key (the default); no additional KMS key resource                |
| Removal policy         | `RETAIN`: the table is kept if it is removed from the stack or must be replaced |

Global secondary indexes, all with string keys and `ALL` projection:

| Index  | Partition key | Sort key |
| ------ | ------------- | -------- |
| `GSI1` | `GSI1PK`      | `GSI1SK` |
| `GSI2` | `GSI2PK`      | `GSI2SK` |
| `GSI3` | `GSI3PK`      | `GSI3SK` |
| `GSI4` | `GSI4PK`      | `GSI4SK` |

The meaning of each key and index is defined in section 5 of the architecture document.

### Cognito User Pool `ClaimFlow`

Defined with the `UserPool` construct. The application is **not connected to Cognito**: it still uses development sign-in locally.

| Setting             | Value                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Feature plan        | Lite, set explicitly instead of relying on Cognito's default plan; no Essentials or Plus features      |
| User creation       | Administrators only; self-service sign-up is disabled                                                  |
| Sign-in             | Email address, case-insensitive                                                                        |
| Attributes          | `email` (standard, required); no custom attributes                                                     |
| Email verification  | Automatic (`email` is an auto-verified attribute)                                                      |
| Account recovery    | Verified email only                                                                                    |
| Password policy     | At least 12 characters with uppercase, lowercase, digits, and symbols; temporary passwords last 7 days |
| MFA                 | Optional, software-token (TOTP) only; SMS MFA disabled                                                 |
| Deletion protection | Enabled                                                                                                |
| Removal policy      | `RETAIN`: the user pool is kept if it is removed from the stack or must be replaced                    |

The email address is both the sign-in identifier and the only account-recovery destination, so every user must have a verified email address. When an administrator creates a user with `AdminCreateUser`, set the `email` attribute together with `email_verified=true`; otherwise the user cannot recover their account by email.

Authorization data is not stored in Cognito: there are no role groups and no role or manager attributes. Roles and manager assignments live in DynamoDB user-profile items keyed by the user's Cognito `sub` (section 17 of the architecture document).

The user pool has no users, groups, social or federated identity providers, Lambda triggers, or SES configuration. Its app client and classic hosted UI domain are described in the next section; adding them does not change the user pool's settings.

### Cognito web app client and classic hosted UI

The web application's app client (`webClient` on the stack) and the classic hosted UI domain (`userPoolDomain`) are defined and deployed in `ap-southeast-1`. The web application has **no Cognito integration yet**: it still uses development sign-in locally.

App client `ClaimFlowWeb`:

| Setting               | Value                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Client type           | Public; no client secret                                                                                  |
| OAuth grants          | Authorization code only; implicit and client-credentials grants disabled                                  |
| Direct API flows      | `ALLOW_REFRESH_TOKEN_AUTH` only; users sign in on the classic hosted UI                                   |
| Identity providers    | The user pool (`COGNITO`) only                                                                            |
| OAuth scopes          | `openid`, `email`                                                                                         |
| Callback URLs         | `https://<CloudFront domain>/auth/callback` (the default redirect), `http://localhost:5173/auth/callback` |
| Sign-out URLs         | `https://<CloudFront domain>/`, `http://localhost:5173/`                                                  |
| Token validity        | Access and ID tokens 1 hour; refresh tokens 30 days                                                       |
| Token revocation      | Enabled                                                                                                   |
| User existence errors | Prevented: sign-in errors do not reveal whether a user exists                                             |

`<CloudFront domain>` is the web distribution's domain name, resolved by CloudFormation at deployment. The localhost URLs allow the Vite development server to sign in against Cognito.

Classic hosted UI:

| Setting | Value                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| Domain  | Cognito prefix domain `claimflow-<account ID>`: deterministic and unique, because prefixes are global across accounts |
| Version | Classic hosted UI (`ManagedLoginVersion.CLASSIC_HOSTED_UI`)                                                           |
| Styling | Cognito's default classic hosted UI; no custom CSS, logos, or branding                                                |

The user pool uses the Lite feature plan, which supports the classic hosted UI but not the newer managed login. The stack therefore creates no `AWS::Cognito::ManagedLoginBranding` or UI customization resource.

### S3 receipt bucket

Defined with the `Bucket` construct (`receiptBucket` on the stack). The application is **not connected to the bucket**: receipts are still uploaded to the local API and stored locally, and receipt upload does not work against AWS yet.

| Setting               | Value                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Name                  | Generated by CloudFormation; no fixed name, because S3 bucket names are globally unique           |
| Public access         | All public access blocked                                                                         |
| Encryption at rest    | S3 managed keys (SSE-S3); no KMS key resource                                                     |
| Encryption in transit | TLS required: the bucket policy denies every request where `aws:SecureTransport` is `false`       |
| Versioning            | Disabled; receipts are immutable once attached                                                    |
| Lifecycle             | Objects under `uploads/pending/` expire after 1 day                                               |
| Removal policy        | `RETAIN`: the bucket and its objects are kept if it is removed from the stack or must be replaced |
| Auto-delete objects   | Disabled; no custom resource or Lambda function empties the bucket                                |

The bucket layout and the upload contract are defined in section 11 of the architecture document. Attached receipts under `receipts/` have no lifecycle rule; they are deleted only by the future cleanup worker.

**CORS is intentionally deferred.** Browser uploads need a CORS rule allowing `POST` from the web application's origin, which is the web distribution's HTTPS origin. The rule is added with the S3 receipt adapter, when the application starts using the bucket; until then the bucket has no CORS rules. It also has no static website hosting, CloudFront access, or IAM access grants.

The TLS policy is a separate `AWS::S3::BucketPolicy` resource that the CDK creates for the bucket. Unlike the bucket, it uses CloudFormation's default deletion policy, so it is deleted with the stack while the bucket is retained.

### Web hosting

A CloudFront distribution (`webDistribution` on the stack) serves the built React web application from a private S3 bucket (`webAssetsBucket`). Both are defined and deployed in `ap-southeast-1`, but **no built web application files are uploaded**: the stack does not include a deployment step for them, so the application is **not available through CloudFront yet**.

Web assets bucket, separate from the receipt bucket:

| Setting               | Value                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Name                  | Generated by CloudFormation; no fixed name                                                        |
| Public access         | All public access blocked                                                                         |
| Encryption at rest    | S3 managed keys (SSE-S3); no KMS key resource                                                     |
| Encryption in transit | TLS required: the bucket policy denies every request where `aws:SecureTransport` is `false`       |
| Read access           | Only `s3:GetObject`, only for CloudFront, and only for requests from this distribution            |
| Website hosting       | Disabled; the bucket is reached only through CloudFront's S3 REST origin                          |
| Versioning            | Disabled; every build can be uploaded again                                                       |
| Removal policy        | `RETAIN`: the bucket and its objects are kept if it is removed from the stack or must be replaced |
| Auto-delete objects   | Disabled; no custom resource or Lambda function empties the bucket                                |

CloudFront distribution:

| Setting             | Value                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Origin              | The web assets bucket through Origin Access Control (SigV4, signing every request); no origin access identity |
| Viewer protocol     | HTTP redirected to HTTPS                                                                                      |
| Allowed methods     | `GET` and `HEAD`                                                                                              |
| Cache policy        | Managed `CachingOptimized`, with compression                                                                  |
| Default root object | `index.html`                                                                                                  |
| Missing paths       | S3 `403` and `404` responses are replaced with `/index.html` and status `200`                                 |
| Domain              | The default `*.cloudfront.net` domain and certificate; no custom domain, ACM certificate, or WAF              |

CloudFront may read objects but not list the bucket, so S3 answers a missing key with `403` instead of `404`. Mapping both to `/index.html` with `200` lets a browser open or refresh a `BrowserRouter` route such as `/claims/<id>` directly; the application then resolves the route and shows its own not-found page when needed.

The distribution serves only the web application's static files. Routing API requests to the future HTTP API is decided with the API increment.

The OAC read grant is added to the web assets bucket's `AWS::S3::BucketPolicy`, next to the TLS statement. As with the receipt bucket, the policy is deleted with the stack while the bucket is retained.

### Cleanup event delivery

The stack defines the internal cleanup-event path (section 15 of the architecture document). These resources are defined and deployed in `ap-southeast-1`, and the cleanup worker below consumes from the cleanup queue. Nothing currently publishes application events to the bus, so the cleanup path is deployed but will remain idle until the publisher exists.

- A custom EventBridge bus named `claimflow` (`eventBus` on the stack).
- A standard SQS queue `claimflow-cleanup` (`cleanupQueue`): SQS-managed encryption, TLS enforced, 4-day retention, a 6-minute visibility timeout, and redrive to the dead-letter queue after 5 receives.
- A standard SQS queue `claimflow-cleanup-dlq` (`cleanupDeadLetterQueue`): SQS-managed encryption, TLS enforced, 14-day retention.
- An EventBridge rule `claimflow-cleanup` on the bus that matches source `claimflow.api` and detail types `internal.receipt-object-deletion-requested` and `internal.claim-history-purge-requested` only. It targets the cleanup queue, with the dead-letter queue as the target's delivery dead-letter queue.

CDK generates the queue resource policies: TLS enforcement on both queues, and a statement allowing only this rule to send to each queue. There are no IAM roles, customer-managed KMS keys, or SNS topics.

### Cleanup worker

The stack defines the cleanup worker (section 12 of the architecture document). It is defined and deployed in `ap-southeast-1`, together with the bus, rule, and queues above.

- Function `claimflow-cleanup-worker` (`cleanupWorker` on the stack): Node.js 24, ARM64, 256 MB, 60-second timeout, tracing disabled. The entry point is `services/api/src/adapters/aws/cleanup-worker-lambda.ts`; its environment holds `CLAIMFLOW_TABLE_NAME` and `CLAIMFLOW_RECEIPT_BUCKET_NAME`.
- The code is bundled by `NodejsFunction` with the pinned `esbuild` development dependency, using the `source` export condition of the workspaces (no `dist` files needed) and bundling the pinned AWS SDK. Synthesizing, including the tests, therefore runs esbuild locally; no Docker is needed.
- Log group `/aws/lambda/claimflow-cleanup-worker` (`cleanupWorkerLogGroup`) with 30-day retention.
- The function's own execution role allows only: log writes to that log group; SQS consumption of `claimflow-cleanup`; `dynamodb:Query` and `dynamodb:BatchWriteItem` on the table ARN, without its indexes; and `s3:DeleteObject` on `receipts/*` in the receipt bucket, without pending uploads or the bucket itself.
- An event-source mapping from `claimflow-cleanup`: batch size 10, no batching window, partial batch failure reporting. The queue's six-minute visibility timeout and redrive after five receives are unchanged, and the dead-letter queue is not an event source.

### Outputs

| Output                      | Value                                                                  |
| --------------------------- | ---------------------------------------------------------------------- |
| `WebUrl`                    | `https://` followed by the distribution's domain name                  |
| `WebDistributionDomainName` | The distribution's `*.cloudfront.net` domain name                      |
| `WebAssetsBucketName`       | The generated name of the web assets bucket                            |
| `WebClientId`               | The ID of the `ClaimFlowWeb` app client                                |
| `HostedUiBaseUrl`           | `https://claimflow-<account ID>.auth.ap-southeast-1.amazoncognito.com` |
| `EventBusName`              | The name of the `claimflow` event bus                                  |
| `CleanupQueueUrl`           | The URL of the cleanup queue                                           |

Apart from the CloudFront read grant on the web assets bucket and the cleanup worker role, the stack grants no IAM permissions and contains no other Lambda functions, API Gateway resources, or other resources yet. The queue policies above are generated resource policies, not IAM roles.

## Useful commands

- `npm run build` type-check the project
- `npm run watch` watch for changes and type-check
- `npm run test` run the Vitest unit tests, which synthesize the stack locally and bundle the cleanup worker with esbuild
- `npx cdk synth` emit the synthesized CloudFormation template
- `npx cdk diff` compare the deployed stack with the current state

Bootstrapping and deploying (`npx cdk bootstrap`, `npx cdk deploy`) change an AWS account. Run them only deliberately, never automatically.

Because the table and the user pool both have deletion protection and a `RETAIN` removal policy, deleting the stack does not delete them or their data. Removing either requires disabling its deletion protection and deleting it explicitly. The receipt bucket and the web assets bucket also have a `RETAIN` removal policy: deleting the stack keeps them and their objects, and removing either requires emptying and deleting it explicitly. The CloudFront distribution and its origin access control are deleted with the stack, as are the app client and the classic hosted UI domain.
