import type { Role } from '@claimflow/domain';
import { z } from 'zod';

import { idSchema, type PersonRef } from './common.js';

export const selectUserRequestSchema = z.strictObject({ userId: idSchema });

export type SelectUserRequest = z.infer<typeof selectUserRequestSchema>;

export interface UserSummaryDto {
  readonly userId: string;
  readonly displayName: string;
  readonly title: string;
  readonly roles: readonly Role[];
}

export interface CurrentUserDto extends UserSummaryDto {
  readonly manager?: PersonRef;
}

/** The development session: who is signed in and who can be chosen. */
export interface SessionDto {
  readonly user: CurrentUserDto | null;
  readonly users: readonly UserSummaryDto[];
}
