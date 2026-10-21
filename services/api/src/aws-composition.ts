import { AwsCategoryService } from './adapters/aws/aws-category-service.js';
import { AwsClaimCreationService } from './adapters/aws/aws-claim-creation-service.js';
import { AwsClaimDraftEditingService } from './adapters/aws/aws-claim-draft-editing-service.js';
import { AwsClaimLifecycleService } from './adapters/aws/aws-claim-lifecycle-service.js';
import {
  AwsDraftDeletionService,
  AwsReceiptRemovalService,
} from './adapters/aws/aws-claim-removal-services.js';
import { AwsReceiptAttachmentService } from './adapters/aws/aws-receipt-attachment-service.js';
import { AwsReceiptDownloadService } from './adapters/aws/aws-receipt-download-service.js';
import { AwsReceiptUploadTargetService } from './adapters/aws/aws-receipt-upload-target-service.js';
import { ClaimMutationCoordinator } from './adapters/aws/claim-mutation-coordinator.js';
import {
  categoryCreateMutation,
  categoryDeleteMutation,
  categoryUpdateMutation,
  claimCreationMutation,
  claimDeleteMutation,
  claimEditMutation,
  claimLifecycleMutations,
  receiptAttachMutation,
  receiptRemoveMutation,
  receiptUploadTargetBodyModes,
  receiptUploadTargetMutation,
} from './adapters/aws/claim-mutations.js';
import {
  categoryListRead,
  claimReadOperations,
  receiptDownloadRead,
} from './adapters/aws/claim-reads.js';
import { DynamoDbCategoryReader } from './adapters/aws/dynamodb-category-reader.js';
import { DynamoDbCategoryWriter } from './adapters/aws/dynamodb-category-writer.js';
import { DynamoDbClaimReader } from './adapters/aws/dynamodb-claim-reader.js';
import { DynamoDbClaimWriter } from './adapters/aws/dynamodb-claim-writer.js';
import { DynamoDbIdempotencyCoordinator } from './adapters/aws/dynamodb-idempotency-coordinator.js';
import { DynamoDbRejectionWriter } from './adapters/aws/dynamodb-idempotency-writer.js';
import { DynamoDbIdempotentTransactionCommitter } from './adapters/aws/dynamodb-idempotent-transaction-committer.js';
import {
  DynamoDbIdempotencyReader,
  DynamoDbReceiptMetadataReader,
} from './adapters/aws/dynamodb-lookups.js';
import { DynamoDbReceiptUploadWriter } from './adapters/aws/dynamodb-receipt-upload-writer.js';
import { DynamoDbTransactionExecutor } from './adapters/aws/dynamodb-transaction-executor.js';
import {
  DynamoDbUserDirectory,
  type UserProfileDocumentClient,
} from './adapters/aws/dynamodb-user-directory.js';
import type { ReadDocumentClient } from './adapters/aws/dynamodb-read-support.js';
import type { GetDocumentClient } from './adapters/aws/dynamodb-lookups.js';
import type { PutDocumentClient } from './adapters/aws/dynamodb-idempotency-writer.js';
import type { TransactDocumentClient } from './adapters/aws/dynamodb-transaction-executor.js';
import { ReceiptUploadCoordinator } from './adapters/aws/receipt-upload-coordinator.js';
import { ReceiptUploadReplayResolver } from './adapters/aws/receipt-upload-replay-resolver.js';
import {
  S3DownloadUrlGenerator,
  type DownloadUrlSigner,
} from './adapters/aws/s3-download-url.js';
import {
  S3ReceiptInspector,
  type InspectionS3Client,
} from './adapters/aws/s3-receipt-inspector.js';
import {
  S3ReceiptObjects,
  type ObjectS3Client,
} from './adapters/aws/s3-receipt-objects.js';
import {
  S3UploadFormGenerator,
  type UploadFormSigner,
} from './adapters/aws/s3-upload-form.js';
import { ClaimQueryService } from './application/claim-query-service.js';
import type { Clock, IdGenerator, Logger } from './application/ports.js';
import { SessionService } from './application/session-service.js';
import {
  createApiHandler,
  OperationNotRegisteredError,
  type ApiHandler,
  type IdempotentMutation,
  type ReadOperation,
} from './http/api-handler.js';
import { cognitoSubjectAuthentication } from './http/aws-api.js';
import {
  createAwsRoutes,
  type AwsRouteServices,
  type Route,
} from './http/routes.js';

/**
 * The AWS application composition: the existing AWS services and adapters,
 * wired over injected clients, signers, clock, IDs, logger, sleep, and
 * randomness, and registered with the request pipeline. It builds no local
 * persistence, no development authentication, and no local service.
 *
 * Every route other than the health check and the session description must be
 * registered explicitly: idempotent routes as mutations, the others as reads.
 * The registrations are checked against the route table when the handler is
 * built, so a missing or misspelt one is refused then, and the route table
 * itself is wired to guards that reject any call, so an unregistered operation
 * can never reach a local service. The actor comes only from the verified
 * Cognito subject and the DynamoDB user directory. Nothing here reads the
 * environment or creates an SDK client; the Lambda entry point does that.
 */

/** The validated deployment settings the composition needs. */
export interface AwsApplicationConfig {
  readonly tableName: string;
  readonly receiptBucketName: string;
}

/** The DynamoDB document client: every command the adapters send. */
export type AwsDynamoClient = ReadDocumentClient &
  TransactDocumentClient &
  PutDocumentClient &
  GetDocumentClient &
  UserProfileDocumentClient;

/** Injectable AWS clients and signers. */
export interface AwsApplicationClients {
  readonly dynamo: AwsDynamoClient;
  readonly s3: InspectionS3Client & ObjectS3Client;
  readonly signUploadForm: UploadFormSigner;
  readonly signDownloadUrl: DownloadUrlSigner;
}

export interface AwsApplicationOptions {
  readonly config: AwsApplicationConfig;
  readonly clients: AwsApplicationClients;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

/** Operations the pipeline serves without an AWS registration. */
const unregisteredOperations = new Set(['health', 'session.get']);

/** The service guards: any call is refused, never answered locally. */
export function failClosed<T extends object>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        typeof property === 'string'
          ? () => Promise.reject(new OperationNotRegisteredError())
          : undefined,
    },
  ) as T;
}

/**
 * Every route other than the health check and `session.get` has exactly one
 * registration of the right kind, and nothing is registered for an unknown
 * operation.
 */
export function assertRegistrationsComplete(
  routes: readonly Route[],
  mutations: Readonly<Record<string, IdempotentMutation>>,
  reads: Readonly<Record<string, ReadOperation>>,
): void {
  const known = new Set<string>();
  for (const route of routes) {
    if (unregisteredOperations.has(route.operation)) {
      continue;
    }
    known.add(route.operation);
    const registered = route.idempotent
      ? route.operation in mutations
      : route.operation in reads;
    const wrongKind = route.idempotent
      ? route.operation in reads
      : route.operation in mutations;
    if (!registered || wrongKind) {
      throw new TypeError(
        `The AWS operation ${route.operation} is not registered correctly.`,
      );
    }
  }
  for (const operation of [...Object.keys(mutations), ...Object.keys(reads)]) {
    if (!known.has(operation)) {
      throw new TypeError(`The AWS operation ${operation} has no route.`);
    }
  }
}

function checkOptions(options: AwsApplicationOptions): void {
  const { config, clients } = options;
  for (const [name, value] of [
    ['table name', config?.tableName],
    ['receipt bucket name', config?.receiptBucketName],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`The ${name} is missing.`);
    }
  }
  for (const [name, value] of [
    ['DynamoDB client', clients?.dynamo],
    ['S3 client', clients?.s3],
    ['upload form signer', clients?.signUploadForm],
    ['download URL signer', clients?.signDownloadUrl],
    ['clock', options.clock],
    ['ID generator', options.ids],
    ['logger', options.logger],
    ['sleep function', options.sleep],
    ['random function', options.random],
  ] as const) {
    if (value === undefined || value === null) {
      throw new TypeError(`The ${name} is missing.`);
    }
  }
}

/** The request handler of the AWS runtime over the injected dependencies. */
export function createAwsApplicationHandler(
  options: AwsApplicationOptions,
): ApiHandler {
  checkOptions(options);
  const { config, clients, clock, ids, logger, sleep, random } = options;
  const { dynamo } = clients;
  const { tableName } = config;

  const executor = new DynamoDbTransactionExecutor({ client: dynamo });
  const users = new DynamoDbUserDirectory({
    client: dynamo,
    tableName,
    sleep,
  });
  const claimReader = new DynamoDbClaimReader({ client: dynamo, tableName });
  const categories = new DynamoDbCategoryReader({ client: dynamo, tableName });
  const receipts = new DynamoDbReceiptMetadataReader({
    client: dynamo,
    tableName,
  });
  const claimWriter = new DynamoDbClaimWriter({ executor, tableName });
  const categoryWriter = new DynamoDbCategoryWriter({ executor, tableName });

  const idempotency = new DynamoDbIdempotencyCoordinator({
    finder: new DynamoDbIdempotencyReader({ client: dynamo, tableName }),
    rejections: new DynamoDbRejectionWriter({ client: dynamo, tableName }),
  });
  const committer = new DynamoDbIdempotentTransactionCommitter({
    executor,
    lookup: idempotency,
  });
  const mutations = new ClaimMutationCoordinator({
    lookup: idempotency,
    committer,
    rejections: idempotency,
  });

  const recovery = { sleep, random, logger };
  const shared = {
    mutations,
    claimReader,
    categories,
    users,
    ids,
    ...recovery,
  };

  const uploads = new ReceiptUploadCoordinator({
    preparer: new DynamoDbReceiptUploadWriter({ executor, tableName }),
    lookup: idempotency,
    committer,
    resolver: new ReceiptUploadReplayResolver({
      receipts,
      forms: new S3UploadFormGenerator({
        bucketName: config.receiptBucketName,
        sign: clients.signUploadForm,
      }),
    }),
    rejections: idempotency,
  });

  const claimCreation = new AwsClaimCreationService({
    mutations,
    categories,
    users,
    claims: claimWriter,
    claimReader,
    ids,
    ...recovery,
  });
  const claimEditing = new AwsClaimDraftEditingService({
    mutations,
    claimReader,
    categories,
    users,
    claims: claimWriter,
    ...recovery,
  });
  const lifecycle = new AwsClaimLifecycleService({
    ...shared,
    claims: claimWriter,
  });
  const attachment = new AwsReceiptAttachmentService({
    ...shared,
    receipts,
    inspector: new S3ReceiptInspector({
      client: clients.s3,
      bucketName: config.receiptBucketName,
    }),
    objects: new S3ReceiptObjects({
      client: clients.s3,
      bucketName: config.receiptBucketName,
    }),
    claims: claimWriter,
  });
  const removal = new AwsReceiptRemovalService({
    ...shared,
    receipts,
    claims: claimWriter,
  });
  const deletion = new AwsDraftDeletionService({
    ...shared,
    receipts,
    claims: claimWriter,
  });
  const uploadTarget = new AwsReceiptUploadTargetService({ uploads, ids });
  const download = new AwsReceiptDownloadService({
    claimReader,
    receipts,
    urls: new S3DownloadUrlGenerator({
      bucketName: config.receiptBucketName,
      sign: clients.signDownloadUrl,
      clock,
    }),
  });
  const categoryAdministration = new AwsCategoryService({
    mutations,
    categories,
    writer: categoryWriter,
    ids,
    ...recovery,
  });

  const registeredMutations: Record<string, IdempotentMutation> = {
    'claim.create': claimCreationMutation(claimCreation),
    'claim.update': claimEditMutation(claimEditing),
    'claim.delete': claimDeleteMutation(deletion),
    ...claimLifecycleMutations(lifecycle),
    'receipt.upload': receiptUploadTargetMutation(uploadTarget),
    'receipt.attach': receiptAttachMutation(attachment),
    'receipt.remove': receiptRemoveMutation(removal),
    'category.create': categoryCreateMutation(categoryAdministration),
    'category.update': categoryUpdateMutation(categoryAdministration),
    'category.delete': categoryDeleteMutation(categoryAdministration),
  };
  const registeredReads: Record<string, ReadOperation> = {
    ...claimReadOperations(
      new ClaimQueryService({ claims: claimReader, categories, users }),
    ),
    'category.list': categoryListRead(categories),
    'receipt.read': receiptDownloadRead(download),
  };

  const sessions = new SessionService(users);
  const services: AwsRouteServices = {
    sessions,
    claims: failClosed(),
    receipts: failClosed(),
    categories: failClosed(),
  };
  const routes = createAwsRoutes(services);
  assertRegistrationsComplete(routes, registeredMutations, registeredReads);

  return createApiHandler(
    { logger },
    {
      routes,
      authenticate: cognitoSubjectAuthentication(sessions),
      mutations: registeredMutations,
      reads: registeredReads,
      bodyModes: receiptUploadTargetBodyModes,
      now: () => clock.now(),
    },
  );
}
