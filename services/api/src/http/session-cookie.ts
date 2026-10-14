import { createHmac, timingSafeEqual } from 'node:crypto';

export const sessionCookieName = 'claimflow_session';
const maxAgeSeconds = 7 * 24 * 60 * 60;

/**
 * Development sign-in session. The cookie holds the chosen user ID with an
 * HMAC, so the browser cannot forge another identity; roles are always loaded
 * server-side. This is not production authentication.
 */
export class SessionCookies {
  public constructor(private readonly secret: string) {}

  public issue(userId: string): string {
    const value = `${userId}.${this.sign(userId)}`;
    return `${sessionCookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  public clear(): string {
    return `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  /** The signed-in user ID, or `undefined` if absent or tampered with. */
  public read(cookieHeader: string | undefined): string | undefined {
    const value = cookieHeader
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${sessionCookieName}=`))
      ?.slice(sessionCookieName.length + 1);
    const separator = value?.lastIndexOf('.') ?? -1;
    if (value === undefined || separator <= 0) {
      return undefined;
    }

    const userId = value.slice(0, separator);
    const given = Buffer.from(value.slice(separator + 1));
    const expected = Buffer.from(this.sign(userId));
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? userId
      : undefined;
  }

  private sign(userId: string): string {
    return createHmac('sha256', this.secret).update(userId).digest('base64url');
  }
}
