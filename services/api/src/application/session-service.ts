import type {
  CurrentUserDto,
  SessionDto,
  UserSummaryDto,
} from '@claimflow/contracts';
import type { Actor } from '@claimflow/domain';

import type {
  DevelopmentUserCatalogue,
  UserDirectory,
  UserProfile,
} from './ports.js';

/**
 * Resolves signed-in users to actors loaded from the user directory. Only the
 * local runtime passes a development catalogue, for its user chooser.
 */
export class SessionService {
  public constructor(
    private readonly users: UserDirectory,
    private readonly developmentUsers?: DevelopmentUserCatalogue,
  ) {}

  /**
   * The actor for a user ID: a development sample user ID locally, or the
   * Cognito `sub` in the AWS runtime. Roles always come from the directory.
   */
  public async actorFor(userId: string): Promise<Actor | undefined> {
    const profile = await this.users.get(userId);
    return profile === undefined ? undefined : toActor(profile);
  }

  /**
   * The signed-in user and every selectable development user. Local runtime
   * only: it fails without a development catalogue.
   */
  public async describe(actor: Actor | undefined): Promise<SessionDto> {
    if (this.developmentUsers === undefined) {
      throw new Error('No development user catalogue is configured.');
    }
    const [{ user }, profiles] = await Promise.all([
      this.describeSignedIn(actor),
      this.developmentUsers.list(),
    ]);
    return { user, users: profiles.map(toSummary) };
  }

  /** The signed-in user only; no other users are listed. */
  public async describeSignedIn(actor: Actor | undefined): Promise<SessionDto> {
    if (actor === undefined) {
      return { user: null, users: [] };
    }

    const [profile, manager] = await Promise.all([
      this.users.get(actor.userId),
      actor.managerId === undefined
        ? undefined
        : this.users.get(actor.managerId),
    ]);
    return { user: toCurrentUser(actor, profile, manager), users: [] };
  }
}

function toCurrentUser(
  actor: Actor,
  profile: UserProfile | undefined,
  manager: UserProfile | undefined,
): CurrentUserDto {
  return {
    userId: actor.userId,
    displayName: actor.displayName,
    title: profile?.title ?? '',
    roles: actor.roles,
    ...(manager === undefined
      ? {}
      : {
          manager: {
            userId: manager.userId,
            displayName: manager.displayName,
          },
        }),
  };
}

function toActor(profile: UserProfile): Actor {
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    roles: profile.roles,
    ...(profile.managerId === undefined
      ? {}
      : { managerId: profile.managerId }),
  };
}

function toSummary(profile: UserProfile): UserSummaryDto {
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    title: profile.title,
    roles: profile.roles,
  };
}
