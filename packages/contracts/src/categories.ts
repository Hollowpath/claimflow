import { z } from 'zod';

import { expectedVersionSchema } from './common.js';

const settings = {
  name: z.string().max(200),
  currency: z.string().max(3),
  maxAmountMinor: z.number().int(),
  receiptRequiredAboveMinor: z.number().int(),
  active: z.boolean(),
};

export const createCategoryRequestSchema = z.strictObject({
  ...settings,
  active: settings.active.default(true),
});

export const updateCategoryRequestSchema = z.strictObject({
  expectedVersion: expectedVersionSchema,
  ...z.object(settings).partial().shape,
});

export type CreateCategoryRequest = z.input<typeof createCategoryRequestSchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;

export interface CategoryDto {
  readonly categoryId: string;
  readonly name: string;
  readonly active: boolean;
  readonly currency: string;
  readonly maxAmountMinor: number;
  readonly receiptRequiredAboveMinor: number;
  readonly version: number;
  readonly updatedAt: string;
}
