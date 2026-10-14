export const roles = ['EMPLOYEE', 'MANAGER', 'ADMIN'] as const;

export type Role = (typeof roles)[number];

/** The authenticated user performing an operation, loaded by the backend. */
export interface Actor {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly Role[];
  /** The manager who reviews this user's claims, if any. */
  readonly managerId?: string;
}

export function hasRole(actor: Actor, role: Role): boolean {
  return actor.roles.includes(role);
}
