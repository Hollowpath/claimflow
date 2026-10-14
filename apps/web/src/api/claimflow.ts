import {
  apiBasePath,
  claimActionPaths,
  type CategoryDto,
  type ClaimAction,
  type ClaimDto,
  type ClaimHistoryEntryDto,
  type ClaimStatus,
  type CreateCategoryRequest,
  type CreateClaimRequest,
  type Page,
  type SessionDto,
  type UpdateCategoryRequest,
  type UpdateClaimRequest,
  type UploadedReceiptDto,
} from '@claimflow/contracts';

import { request } from './client';

const pageQuery = (cursor?: string, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams(extra);
  if (cursor !== undefined) {
    params.set('cursor', cursor);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
};

/** Typed calls to the local ClaimFlow API. */
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
    const upload = await request<UploadedReceiptDto>('POST', '/receipts', {
      file,
    });
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
  receiptUrl: (claimId: string) =>
    `${apiBasePath}/claims/${encodeURIComponent(claimId)}/receipt`,

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

async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
