import type { SessionService } from '../application/session-service.js';
import type { Application } from '../composition.js';
import {
  createApiHandler,
  type ApiHandler,
  type AuthenticationResolver,
} from './api-handler.js';
import { createAwsRoutes } from './routes.js';

/**
 * The API handler of the AWS runtime, authenticated by Cognito. It has no
 * development session routes.
 */
export function createAwsApiHandler(app: Application): ApiHandler {
  return createApiHandler(app, {
    routes: createAwsRoutes(app),
    authenticate: cognitoSubjectAuthentication(app.sessions),
  });
}

/**
 * Resolves the actor from the request's verified Cognito subject, which the
 * transport sets only from a token API Gateway's JWT authorizer validated.
 * The subject is the user's ID; display name, roles, and manager assignment
 * come from the user directory, never from token claims. Cookies and other
 * headers are ignored.
 */
export function cognitoSubjectAuthentication(
  sessions: SessionService,
): AuthenticationResolver {
  return async (request) =>
    request.verifiedSubject === undefined
      ? undefined
      : sessions.actorFor(request.verifiedSubject);
}
