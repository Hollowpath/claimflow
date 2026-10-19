# Engineering readiness checklist

## Purpose

ClaimFlow uses this checklist to catch engineering risks that feature work and architecture documentation do not necessarily expose. It is a set of delivery gates, not a request to add controls indiscriminately.

The existing domain model, API documentation, testing documentation, and AWS architecture remain authoritative for product behavior and the approved AWS design. This document adds lifecycle, maintenance, privacy, recovery, accessibility, and repository-governance checks around them.

## Working principles

- Prefer evidence over claims: a passing test, inspected configuration, restore exercise, or recorded decision is stronger than “should work.”
- Keep scope proportional to the application's real users and operating environment. A conscious, documented deferral is better than an unused mechanism.
- Never use real employee, financial, or receipt data in a development or demonstration environment.
- Do not treat authentication as authorization, backup configuration as proven recovery, a DLQ as failure handling, or unit tests as end-to-end verification.
- Review generated changes before committing them. Understand why each file changed and keep unrelated work out of the commit.
- Do not weaken domain rules, security boundaries, strict persistence validation, or failure handling merely to simplify integration.

## Current audit baseline

The read-only audit performed on 19 October 2026 found:

- no common credential, private-key, GitHub-token, Slack-token, or JWT patterns in tracked files or Git history;
- appropriate ignore rules for environment files, local data and receipts, dependencies, and CDK output;
- strong automated formatting, type, lint, test, coverage, build, and production-dependency checks;
- predominantly permissive third-party dependency licenses and no obvious license blocker;
- no branch protection or repository ruleset;
- no dependency-update automation, repository security policy, or configured code/secret scanning visible to the audit;
- GitHub Actions referenced by mutable version tags rather than immutable commit SHAs;
- one unresolved install-script decision for `esbuild`;
- no business-data retention policy, recovery drill, item-schema migration strategy, operational runbooks, or real-browser test suite;
- good static accessibility foundations, but no automated accessibility scan or real keyboard, screen-reader, contrast, zoom, or reflow verification.

This baseline is not permanent. Recheck it before making the repository public and before declaring the AWS deployment complete.

## Engineering concerns covered by this checklist

The checklist explicitly covers all of the following concerns. They remain relevant even when the application code and AWS resources are otherwise well designed.

1. **Secret and repository-history hygiene:** prevent credentials, private keys, tokens, private data, and confidential files from entering the current tree or Git history.
2. **Dependency and supply-chain governance:** review dependencies, install scripts, provenance, maintenance status, vulnerabilities, licenses, and the software bill of materials.
3. **Repository protection:** use appropriate branch rules, required checks, security scanning, review boundaries, and safe Git history practices.
4. **Data classification and privacy:** identify sensitive fields and define access, retention, deletion, export, logging, testing, and support-handling rules.
5. **Backup restoration:** prove that retained resources and backups can be restored within defined recovery objectives.
6. **Schema evolution and data migration:** keep deployed code compatible while stored item and event shapes evolve, backfill, and roll back.
7. **Environment separation:** prevent local, development, staging, and production configuration, identity, data, and resources from colliding.
8. **Release and rollback:** identify artifacts, control deployment order, verify releases, and return safely to a previous version.
9. **Operational runbooks:** define concrete responses for alarms, queues, stuck events, failed cleanup, service degradation, and compromised users.
10. **Log safety:** use an explicit safe-field policy, sanitize errors, and exclude secrets, tokens, personal free text, receipt contents, and presigned URLs.
11. **Accessibility:** verify semantic structure, keyboard navigation, focus, announcements, contrast, motion, zoom, reflow, and assistive-technology behavior.
12. **Real-browser and end-to-end testing:** exercise actual identity redirects, tokens, CORS, CloudFront routing, S3 transfers, retries, and role-based workflows.
13. **Capacity, load, and cost boundaries:** verify throttling, concurrency, queue behavior, hot-partition assumptions, file sizes, and cost under idle, normal, and failure conditions.
14. **Abuse and business misuse:** consider what an authenticated but careless or hostile user can exhaust, probe, duplicate, or manipulate.
15. **Ownership and maintenance:** assign responsibility for dependencies, releases, alarms, failed messages, user access, retained resources, and platform upgrades.

## Gate 1: before the AWS application writes persistent business data

### Data policy

- [ ] State explicitly that development and demonstration environments accept fabricated data only.
- [ ] Classify employee profiles, claims, history, comments, and receipt files as potentially sensitive.
- [ ] Decide how long paid claims, rejected claims, history, attached receipts, and user profiles are retained.
- [ ] Decide what happens to data when a user is disabled or removed.
- [ ] Keep request bodies, authorization tokens, presigned URLs, receipt contents, merchants, purposes, and decision comments out of logs.

For a fake-data demonstration environment, retaining business records until intentional teardown is acceptable if that limitation is explicit. Real personal or financial data requires a stronger deletion, export, and access policy.

### DynamoDB schema evolution

- [ ] Define how persisted item shapes evolve before changing any deployed codec.
- [ ] Prefer expand-and-contract changes: deploy readers that accept old and new shapes, then change writers, backfill if required, and remove compatibility only later.
- [ ] Ensure old and new Lambda versions can coexist during deployment.
- [ ] Define how restored older data is read by newer code.
- [ ] Never introduce a required attribute in one deployment without a compatibility path.
- [ ] Treat strict codec rejection as a safety feature; do not bypass it to make migrations appear successful.

Event `schemaVersion` does not by itself version claim, history, category, profile, idempotency, outbox, or receipt items.

### Environment separation

- [ ] Identify every supported environment and which AWS account and Region it uses.
- [ ] Keep Cognito users, callback URLs, DynamoDB data, S3 objects, queues, event buses, logs, alarms, and IAM roles environment-specific.
- [ ] Prevent fixed physical names from colliding if another environment is created in the same account and Region.
- [ ] Validate configuration at startup and fail safely when required environment values are absent or inconsistent.
- [ ] Never let local-development identity or sample-user mechanisms become reachable from an AWS environment.
- [ ] Define how an environment is created, seeded with fabricated data, inspected, and intentionally removed.

ClaimFlow may deliberately operate only one AWS environment. That is an acceptable scope decision when it is explicit and the configuration does not pretend to provide isolation that does not exist.

## Gate 2: before the AWS application is considered usable

### Release and rollback

- [ ] Identify every release by its Git commit and built artifact.
- [ ] Review `cdk diff` before every infrastructure deployment.
- [ ] Define how to redeploy the previous Lambda and web versions after a successful but defective release.
- [ ] Define deployment order when code and stored item shapes change together.
- [ ] Add a post-deployment smoke test for authentication, one authorized read, one safe mutation, and relevant asynchronous processing.
- [ ] Define web-asset upload and CloudFront cache-invalidation behavior.

Manual deployments are acceptable for this project. They must still be repeatable, reviewable, and reversible.

### Recovery

- [ ] Define recovery-point and recovery-time objectives appropriate for the application.
- [ ] Document how to restore the DynamoDB table from point-in-time recovery.
- [ ] Document how application configuration would switch to the restored table.
- [ ] Account for S3 receipts, Cognito users, idempotency records, and outbox events around the restore point.
- [ ] Perform at least one safe restore exercise before claiming recovery readiness.
- [ ] Define intentional teardown for retained tables, buckets, and the user pool.

Enabling point-in-time recovery proves backup capability, not successful restoration.

### Observability and operations

- [ ] Add the approved CloudWatch alarms when their target runtime exists.
- [ ] Ensure logs use an explicit safe-field policy and sanitized error representation.
- [ ] Create short runbooks for API 5xx spikes, Lambda errors and throttles, stream iterator age, pending outbox accumulation, and every DLQ or failure queue.
- [ ] Define how a failed message is inspected, corrected, replayed, or intentionally discarded without duplicating work.
- [ ] Define how a compromised or departed Cognito user is disabled.
- [ ] Confirm that the scheduled sweeper and other idle resources have acceptable cost.

A queue containing failed messages is not a completed recovery process.

## Gate 3: before the repository becomes public

### Repository governance

- [ ] Run a secret scan over the current tree and all Git history again.
- [ ] Remove private paths, local data, generated output, test receipts, and confidential references.
- [ ] Choose and add a repository license, or deliberately keep all rights reserved.
- [ ] Add a `SECURITY.md` describing responsible vulnerability reporting.
- [ ] Enable the GitHub security features available for the repository and account plan.
- [ ] Add dependency-update automation with controlled grouping and review.
- [ ] Pin third-party GitHub Actions to reviewed immutable commit SHAs.
- [ ] Enable an appropriate branch ruleset when direct-to-main development is no longer required.
- [ ] Require the relevant CI checks before merge.

### Dependency and build provenance

- [ ] Review every dependency that runs an install script; explicitly approve or deny it rather than approving all scripts.
- [ ] Resolve the current `esbuild` install-script decision after verifying the exact package and source.
- [ ] Review production dependency licenses and generate an SBOM or equivalent inventory for the release.
- [ ] Keep lockfile-based reproducible installation and dependency auditing in CI.
- [ ] Investigate abandoned, unexpectedly introduced, or unusually privileged dependencies.

`npm audit` is useful but does not detect malicious packages, unsafe install scripts, abandoned dependencies, or license incompatibility.

## Gate 4: before ClaimFlow is called complete

### Real-browser and accessibility verification

- [ ] Exercise employee, manager, and administrator flows in a real supported browser.
- [ ] Test Cognito redirect, PKCE, sign-out, token expiry, refresh, and unauthenticated navigation.
- [ ] Test CloudFront routing, API CORS, presigned receipt upload, download, retry, and network interruption.
- [ ] Add a small browser-level smoke suite for the highest-value flows.
- [ ] Run an automated accessibility scan as a supplement, not a replacement for manual testing.
- [ ] Complete keyboard-only navigation and verify visible focus.
- [ ] Verify focus after route changes, validation failures, and inline confirmation controls.
- [ ] Test with a screen reader.
- [ ] Check color contrast, reduced motion, 200%/400% zoom, reflow, and a narrow viewport.

Testing Library and jsdom demonstrate component behavior; they do not demonstrate browser, Cognito, CloudFront, S3, CORS, or assistive-technology behavior.

### Capacity, abuse, and cost boundaries

- [ ] Verify API throttling and Lambda concurrency choices against expected traffic.
- [ ] Test representative receipt sizes and concurrent mutations.
- [ ] Check SQS backlog and retry behavior under repeated failures.
- [ ] Revisit known DynamoDB hot-partition assumptions if expected traffic changes.
- [ ] Consider authenticated abuse: excessive drafts, upload targets, maximum-size uploads, key probing, and repeated mutations.
- [ ] Review actual AWS cost and usage after an end-to-end test period.

### Ownership and maintenance

- [ ] Assign responsibility for dependency and runtime upgrades.
- [ ] Assign responsibility for reviewing deployment changes and executing releases and rollbacks.
- [ ] Assign responsibility for alarms, DLQs, failure queues, stuck outbox records, and retained resources.
- [ ] Define how users are provisioned, disabled, and removed and who is authorized to do so.
- [ ] Define a review cadence for IAM permissions, dependency health, cost, retention, backups, and recovery procedures.
- [ ] Record the supported Node.js, AWS CDK, AWS SDK, browser, and event-schema versions.
- [ ] Define an end-of-life procedure that removes retained resources intentionally and confirms that sensitive data is gone.

For a small application, one person may own every responsibility. The requirement is that ownership is explicit rather than assumed.

## Instructions for Claude Code

When a requested change affects one of these gates:

1. Read the relevant section before editing.
2. State briefly which readiness concern is affected.
3. Implement only what the current request authorizes; do not automatically implement the entire checklist.
4. Preserve intentional deferrals unless the request explicitly changes them.
5. Add focused verification proportional to the risk.
6. Do not put secrets, personal data, presigned URLs, private paths, or confidential removed wording in source, tests, logs, summaries, comments, or commit messages.
7. Do not commit, push, deploy, modify GitHub settings, rewrite history, or perform AWS write operations without explicit authorization.

## Completion rule

ClaimFlow does not need every possible control. It does need:

- clear security and data boundaries;
- compatible persistence evolution;
- reproducible deployment and rollback;
- evidence that recovery and critical user flows work;
- safe operational failure handling;
- accessible core workflows;
- explicit, honest documentation of anything intentionally deferred.

The goal is engineering ownership, not checklist volume.
