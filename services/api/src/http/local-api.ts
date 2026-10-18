import type { SessionService } from '../application/session-service.js';
import type { Application } from '../composition.js';
import {
  createApiHandler,
  type ApiHandler,
  type AuthenticationResolver,
} from './api-handler.js';
import { createRoutes } from './routes.js';
import type { SessionCookies } from './session-cookie.js';

/** The API handler of the local runtime, signed in by development sign-in. */
export function createLocalApiHandler(
  app: Application,
  cookies: SessionCookies,
): ApiHandler {
  return createApiHandler(app, {
    routes: createRoutes(app, cookies),
    authenticate: sessionCookieAuthentication(cookies, app.sessions),
  });
}

/**
 * Resolves the actor from the development sign-in cookie. Roles always come
 * from the user directory, never from the cookie.
 */
export function sessionCookieAuthentication(
  cookies: SessionCookies,
  sessions: SessionService,
): AuthenticationResolver {
  return async (request) => {
    const userId = cookies.read(request.headers.cookie);
    return userId === undefined ? undefined : sessions.actorFor(userId);
  };
}
