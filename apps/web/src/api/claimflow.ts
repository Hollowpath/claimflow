import {
  claimActionPaths,
  type CategoryDto,
  type ClaimAction,
  type ClaimDto,
  type ClaimHistoryEntryDto,
  type ClaimStatus,
  type CreateCategoryRequest,
  type CreateClaimRequest,
  type Page,
  type ReceiptDownloadDto,
  type ReceiptUploadDeclaration,
  type ReceiptUploadTargetDto,
  type SessionDto,
  type UpdateCategoryRequest,
  type UpdateClaimRequest,
  type UploadedReceiptDto,
} from '@claimflow/contracts';

import { getRuntimeConfig } from '../config';
import { navigation } from '../lib/navigation';
import { ApiError, request } from './client';

const pageQuery = (cursor?: string, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams(extra);
  if (cursor !== undefined) {
    params.set('cursor', cursor);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
};

/** Typed calls to the ClaimFlow API. */
export const api = {
  getSession: (signal?: AbortSignal) =>
    request<SessionDto>('GET', '/session', { ...(signal && { signal }) }),
  selectUser: (userId: string) =>
    request<SessionDto>('PUT', '/session', { json: { userId } }),
  signOut: () => request<SessionDto>('DELETE', '/session'),

  listMyClaims: (cursor?: string, signal?: AbortSignal) =>
    request<Page<ClaimDto>>('GET', `/me/claims${pageQuery(cursor)}`, {
      ...(signal && { signal }),
    }),
  listReviewQueue: (cursor?: string, signal?: AbortSignal) =>
    request<Page<ClaimDto>>('GET', `/review-queue${pageQuery(cursor)}`, {
      ...(signal && { signal }),
    }),
  listAllClaims: (
    status: ClaimStatus | undefined,
    cursor?: string,
    signal?: AbortSignal,
  ) =>
    request<Page<ClaimDto>>(
      'GET',
      `/claims${pageQuery(cursor, status === undefined ? {} : { status })}`,
      { ...(signal && { signal }) },
    ),

  getClaim: (claimId: string, signal?: AbortSignal) =>
    request<ClaimDto>('GET', `/claims/${encodeURIComponent(claimId)}`, {
      ...(signal && { signal }),
    }),
  getHistory: (claimId: string, cursor?: string, signal?: AbortSignal) =>
    request<Page<ClaimHistoryEntryDto>>(
      'GET',
      `/claims/${encodeURIComponent(claimId)}/history${pageQuery(cursor, { limit: '100' })}`,
      { ...(signal && { signal }) },
    ),
  createClaim: (body: CreateClaimRequest) =>
    request<ClaimDto>('POST', '/claims', { json: body }),
  updateClaim: (claimId: string, body: UpdateClaimRequest) =>
    request<ClaimDto>('PATCH', `/claims/${encodeURIComponent(claimId)}`, {
      json: body,
    }),
  deleteClaim: (claimId: string, expectedVersion: number) =>
    request<void>('DELETE', `/claims/${encodeURIComponent(claimId)}`, {
      json: { expectedVersion },
    }),
  performAction: (
    claimId: string,
    action: ClaimAction,
    expectedVersion: number,
    comment?: string,
  ) =>
    request<ClaimDto>(
      'POST',
      `/claims/${encodeURIComponent(claimId)}/${claimActionPaths[action]}`,
      {
        json: {
          expectedVersion,
          ...(comment === undefined ? {} : { comment }),
        },
      },
    ),

  /** Uploads a file, then attaches it with the checksum computed locally. */
  attachReceiptFile: async (
    claimId: string,
    expectedVersion: number,
    file: File,
  ) => {
    const checksumSha256 = await sha256Hex(file);
    const upload =
      getRuntimeConfig().cognito === null
        ? await request<UploadedReceiptDto>('POST', '/receipts', { file })
        : await uploadToS3(file, checksumSha256);
    return request<ClaimDto>(
      'PUT',
      `/claims/${encodeURIComponent(claimId)}/receipt`,
      {
        json: {
          expectedVersion,
          receiptId: upload.receiptId,
          contentType: file.type,
          sizeBytes: file.size,
          checksumSha256,
        },
      },
    );
  },
  removeReceipt: (claimId: string, expectedVersion: number) =>
    request<ClaimDto>(
      'DELETE',
      `/claims/${encodeURIComponent(claimId)}/receipt`,
      { json: { expectedVersion } },
    ),
  /**
   * Cognito mode: asks the API for a presigned URL and navigates to it. The
   * bearer token goes to the API only, never to S3.
   */
  openReceipt: async (claimId: string) => {
    const { url } = await request<ReceiptDownloadDto>(
      'GET',
      `/claims/${encodeURIComponent(claimId)}/receipt`,
    );
    navigation.assign(httpsUrl(url));
  },
  /** Local mode: the API itself serves the file to a plain link. */
  receiptUrl: (claimId: string) =>
    `${getRuntimeConfig().apiBaseUrl}/claims/${encodeURIComponent(claimId)}/receipt`,

  listCategories: (signal?: AbortSignal) =>
    request<{ items: CategoryDto[] }>('GET', '/categories', {
      ...(signal && { signal }),
    }).then((r) => r.items),
  createCategory: (body: CreateCategoryRequest) =>
    request<CategoryDto>('POST', '/categories', { json: body }),
  updateCategory: (categoryId: string, body: UpdateCategoryRequest) =>
    request<CategoryDto>(
      'PATCH',
      `/categories/${encodeURIComponent(categoryId)}`,
      { json: body },
    ),
  deleteCategory: (categoryId: string, expectedVersion: number) =>
    request<void>('DELETE', `/categories/${encodeURIComponent(categoryId)}`, {
      json: { expectedVersion },
    }),
};

const uploadFailedMessage =
  'The receipt could not be uploaded. Please try again.';

function httpsUrl(value: unknown): string {
  try {
    if (typeof value === 'string' && new URL(value).protocol === 'https:') {
      return value;
    }
  } catch {
    // Fall through to the error below.
  }
  throw new ApiError(
    0,
    'INTERNAL_ERROR',
    'Something went wrong. Please try again.',
  );
}

/**
 * The AWS upload: the API signs a one-key POST form, then the browser sends
 * the form fields and the file straight to S3. That request carries no
 * credentials and no explicit Content-Type, so the browser sets the multipart
 * boundary and the bearer token never reaches S3.
 */
async function uploadToS3(
  file: File,
  checksumSha256: string,
): Promise<{ receiptId: string }> {
  const declaration: ReceiptUploadDeclaration = {
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    checksumSha256,
  };
  const { receiptId, form } = await request<ReceiptUploadTargetDto>(
    'POST',
    '/receipts',
    { json: declaration },
  );
  const body = new FormData();
  for (const [name, value] of Object.entries(form.fields)) {
    body.append(name, value);
  }
  // S3 ignores everything after the file, so it must come last.
  body.append('file', file);

  const target = httpsUrl(form.url);
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      body,
      credentials: 'omit',
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', uploadFailedMessage);
  }
  if (!response.ok) {
    throw new ApiError(response.status, 'INTERNAL_ERROR', uploadFailedMessage);
  }
  return { receiptId };
}

async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
