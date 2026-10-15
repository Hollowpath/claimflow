# ClaimFlow

ClaimFlow manages employee expense claims from submission to reimbursement. Employees record expenses and attach receipts, managers review and decide on the claims assigned to them, and finance administrators maintain category policy and mark approved claims as paid. Every change is authorized on the server and recorded in an immutable history.

## Capabilities

- **Claims.** Employees create and edit draft claims, attach PDF, JPEG, or PNG receipts, and submit them for approval. Drafts may be incomplete; every required field and policy rule is checked on submission. A draft that was never submitted can be deleted.
- **Review.** Each claim is routed to the employee's assigned manager, who starts a review and approves or rejects it with a required comment. Nobody can review their own claim.
- **Resubmission.** Rejected claims can be reopened, corrected, and resubmitted, and are re-evaluated against current policy.
- **Payment.** Administrators mark approved claims as paid, but never their own.
- **Policy.** Administrators create categories and set each category's currency, maximum claim amount, receipt threshold, and availability. Unused categories can be deleted; categories in use are deactivated instead.
- **History.** Every accepted change is recorded with who made it, when, the status change, and any comment.
- **Integrity.** Validated lifecycle transitions, optimistic concurrency, idempotent retries, server-side receipt inspection with SHA-256 checksums, paginated lists, and structured API errors.

## Architecture

```text
apps/web            React 19 + TypeScript + Vite single-page app (depends on contracts only)
packages/domain     Pure business rules: lifecycle, authorization, policy, receipts
packages/contracts  Shared Zod request schemas, response types, error codes
services/api        Application services, port interfaces, adapters, HTTP server
docs/               Domain model, API guide, OpenAPI specification, development, testing
```

The API is a TypeScript HTTP server built on `node:http`. Application services depend on port interfaces (`ClaimRepository`, `CategoryRepository`, `UserDirectory`, `ReceiptStorage`, `IdempotencyStore`, `Clock`, `IdGenerator`, `Logger`). The current implementation provides local adapters for them: JSON-file persistence, receipt files on disk, and a fixed directory of sample users.

## Local development

Requires Node.js 24 (see `.nvmrc`).

```text
npm install
npm run dev
```

Open http://localhost:5173. The web app runs on port 5173 and proxies `/api` to the API on port 3001.

To run the production build as a single process:

```text
npm run build
npm start          # http://localhost:3001 serves the app and the API
```

See [Local development](docs/local-development.md) for configuration, data files, and troubleshooting.

### Development sign-in

The local development runtime has no passwords. Choose a sample user on the start screen or from the **Signed in as** menu. The API stores the choice in an HMAC-signed, `HttpOnly` session cookie and always loads the user's roles and manager assignment from its own directory; it never trusts identity, roles, or ownership sent by the browser.

Because anyone with access to the app can act as any sample user, this mode is for development and evaluation only and must not be used with real data.

| User         | Roles             | Reviewed by |
| ------------ | ----------------- | ----------- |
| Aisha Rahman | Employee          | Ben Tan     |
| Ravi Kumar   | Employee          | Ben Tan     |
| Ben Tan      | Employee, manager | Chloe Lim   |
| Chloe Lim    | Senior manager    | —           |
| Dan Wong     | Administrator     | —           |

Default categories (MYR): Travel (limit RM 2,000, receipt above RM 200), Meals and entertainment (RM 300, above RM 50), Equipment (RM 5,000, always), and Training and courses (inactive).

### End-to-end workflow

1. As **Aisha**, create a Travel claim for RM 450, attach a receipt, and submit it.
2. As **Ben**, open the review queue, start the review, and approve or reject the claim with a comment.
3. If it was rejected, as **Aisha**, reopen the claim, correct it, and resubmit.
4. As **Dan**, find the approved claim under **All claims** and mark it as paid.

The claim's history shows every step. **Ravi** and **Chloe** cannot see Aisha's claim.

### Local data

Data is stored in `.local/` (ignored by Git): `claimflow.json` for claims, history, categories, and idempotency records, `receipts/` for uploaded files, and `session-secret` for signing session cookies. Data persists across restarts.

To restore the default data, stop the app and run:

```text
npm run reset-data
```

This deletes the claims database and receipts so the default categories are recreated on the next start. It refuses to run while the API is running.

## Verification

```text
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
```

`npm run check` runs formatting, type-checking, lint, and tests together. GitHub Actions runs these checks, the production build, and a production dependency audit on pushes and pull requests. See [Testing](docs/testing.md) for coverage by layer.

## Current limitations

- Sign-in uses selectable sample users; there is no production identity provider, password, or user administration.
- Persistence is a single JSON file and a local receipt directory, intended for one API process.
- Users and manager assignments are defined in code (`services/api/src/adapters/local/seed.ts`).
- There are no notifications, reporting, exports, or integrations with payroll or accounting systems.

## Deployment considerations

ClaimFlow's AWS infrastructure is being built incrementally, following [the AWS architecture](docs/aws-architecture.md):

- **Infrastructure:** a TypeScript AWS CDK application in `infrastructure/` defines the `ClaimFlow` DynamoDB table, which is deployed in `ap-southeast-1`.
- **Application runtime:** the application still runs only locally, using development sign-in and the local adapters described above.
- **Future increments:** Cognito authentication, the AWS API runtime, the AWS adapters, receipt storage, and the other approved components.
- **Deployments:** AWS deployments are run manually and never automatically.

Running the application on AWS requires replacing development sign-in with Cognito and the local adapters with AWS adapters backed by durable storage that supports concurrent API instances. The application services already depend only on the port interfaces listed above, so new adapters can be added without changing the domain rules or the API contract.

## Documentation

- [Domain model](docs/domain-model.md)
- [API guide](docs/api.md) and [OpenAPI specification](docs/openapi.yaml)
- [Local development](docs/local-development.md)
- [Testing](docs/testing.md)
