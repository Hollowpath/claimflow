# ClaimFlow infrastructure

AWS CDK (TypeScript) application for ClaimFlow's AWS infrastructure. The design it implements is described in [docs/aws-architecture.md](../docs/aws-architecture.md).

The application defines a single stack, `ClaimFlow` (class `ClaimFlowStack` in `lib/claimflow-stack.ts`):

- **Region:** always `ap-southeast-1`.
- **Account:** taken from `CDK_DEFAULT_ACCOUNT`, which the CDK CLI sets from the credentials it runs with.

## Resources

The stack currently contains one resource: the ClaimFlow DynamoDB table.

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

The meaning of each key and index is defined in section 5 of the architecture document. The stack grants no IAM permissions and contains no Lambda functions, S3 buckets, or other resources yet.

## Useful commands

- `npm run build` type-check the project
- `npm run watch` watch for changes and type-check
- `npm run test` run the Vitest unit tests, which synthesize the stack locally
- `npx cdk synth` emit the synthesized CloudFormation template
- `npx cdk diff` compare the deployed stack with the current state

Bootstrapping and deploying (`npx cdk bootstrap`, `npx cdk deploy`) change an AWS account. Run them only deliberately, never automatically.

Because the table has deletion protection and a `RETAIN` removal policy, deleting the stack does not delete the table or its data. Removing it requires disabling deletion protection and deleting the table explicitly.
