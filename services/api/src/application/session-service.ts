import type { SessionDto, UserSummaryDto } from '@claimflow/contracts';
import type { Actor } from '@claimflow/domain';

import type { UserDirectory, UserProfile } from './ports.js';

/** Resolves development sign-in to actors loaded from the user directory. */
export class SessionService {
  public constructor(private readonly users: UserDirectory) {}

  /** The actor for a session's user ID; roles always come from the directory. */
  public async actorFor(userId: string): Promise<Actor | undefined> {
    const profile = await this.users.get(userId);
    return profile === undefined ? undefined : toActor(profile);
  }

  public async describe(actor: Actor | undefined): Promise<SessionDto> {
    const profiles = await this.users.list();
    const users = profiles.map(toSummary);
    if (actor === undefined) {
      return { user: null, users };
    }

    const profile = profiles.find((p) => p.userId === actor.userId);
    const manager = profiles.find((p) => p.userId === actor.managerId);
    return {
      user: {
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
      },
      users,
    };
  }
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
