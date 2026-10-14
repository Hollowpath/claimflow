import { z } from 'zod';

export const apiBasePath = '/api/v1';

export const headers = {
  idempotencyKey: 'Idempotency-Key',
  requestId: 'X-Request-Id',
  correlationId: 'X-Correlation-Id',
  fileName: 'X-File-Name',
} as const;

export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Must be a valid identifier.');

export const idempotencyKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_.:-]{8,128}$/,
    'Must be 8-128 letters, digits, or the characters _ . : -',
  );

export const expectedVersionSchema = z.number().int().positive();

/** Body for deletions, which must name the version being deleted. */
export const deleteRequestSchema = z.strictObject({
  expectedVersion: expectedVersionSchema,
});

export const moneySchema = z.strictObject({
  amountMinor: z.number().int(),
  currency: z.string().max(3),
});

export const pageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque token for the next page; absent on the last page. */
  readonly nextCursor?: string;
}

export interface MoneyDto {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface PersonRef {
  readonly userId: string;
  readonly displayName: string;
}
