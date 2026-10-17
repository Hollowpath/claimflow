# ClaimFlow infrastructure

AWS CDK (TypeScript) application for ClaimFlow's AWS infrastructure. The design it implements is described in [docs/aws-architecture.md](../docs/aws-architecture.md).

The application defines a single stack, `ClaimFlow` (class `ClaimFlowStack` in `lib/claimflow-stack.ts`):

- **Region:** always `ap-southeast-1`.
- **Account:** taken from `CDK_DEFAULT_ACCOUNT`, which the CDK CLI sets from the credentials it runs with.

## Resources

The stack defines two resources:

| Resource                      | Status                                   |
| ----------------------------- | ---------------------------------------- |
| DynamoDB table `ClaimFlow`    | Defined and deployed in `ap-southeast-1` |
| Cognito User Pool `ClaimFlow` | Defined and deployed in `ap-southeast-1` |

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

The user pool has no app client, domain, managed login, callback URLs, users, Lambda triggers, or SES configuration yet. The app client and callback URLs depend on the web hosting decision, which is still open.

The stack grants no IAM permissions and contains no Lambda functions, API Gateway resources, S3 buckets, or other resources yet.

## Useful commands

- `npm run build` type-check the project
- `npm run watch` watch for changes and type-check
- `npm run test` run the Vitest unit tests, which synthesize the stack locally
- `npx cdk synth` emit the synthesized CloudFormation template
- `npx cdk diff` compare the deployed stack with the current state

Bootstrapping and deploying (`npx cdk bootstrap`, `npx cdk deploy`) change an AWS account. Run them only deliberately, never automatically.

Because the table and the user pool both have deletion protection and a `RETAIN` removal policy, deleting the stack does not delete them or their data. Removing either requires disabling its deletion protection and deleting it explicitly.
