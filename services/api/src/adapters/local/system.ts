import { randomUUID } from 'node:crypto';

import type {
  Clock,
  DevelopmentUserCatalogue,
  IdGenerator,
  LogFields,
  Logger,
  UserDirectory,
  UserProfile,
} from '../../application/ports.js';

export const systemClock: Clock = { now: () => new Date() };

export const uuidGenerator: IdGenerator = { newId: () => randomUUID() };

/** Writes one JSON object per line. Callers must never pass request bodies. */
export class JsonLogger implements Logger {
  public constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}

  public info(event: string, fields?: LogFields): void {
    this.log('info', event, fields);
  }

  public warn(event: string, fields?: LogFields): void {
    this.log('warn', event, fields);
  }

  public error(event: string, fields?: LogFields): void {
    this.log('error', event, fields);
  }

  private log(level: string, event: string, fields: LogFields = {}): void {
    this.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        event,
        ...fields,
      }),
    );
  }
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * The fixed sample users: the local user directory, and the development
 * catalogue that the local user chooser lists.
 */
export class StaticUserDirectory
  implements UserDirectory, DevelopmentUserCatalogue
{
  public constructor(private readonly users: readonly UserProfile[]) {}

  public get(userId: string): Promise<UserProfile | undefined> {
    return Promise.resolve(this.users.find((u) => u.userId === userId));
  }

  public getMany(userIds: readonly string[]): Promise<readonly UserProfile[]> {
    const wanted = new Set(userIds);
    return Promise.resolve(this.users.filter((u) => wanted.has(u.userId)));
  }

  public list(): Promise<readonly UserProfile[]> {
    return Promise.resolve(this.users);
  }
}
