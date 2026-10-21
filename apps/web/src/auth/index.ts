import { getRuntimeConfig, type RuntimeConfig } from '../config';
import { CognitoAuth } from './cognito';

export { AuthError, CognitoAuth } from './cognito';

let override: CognitoAuth | null | undefined;
let cached: {
  readonly config: RuntimeConfig;
  readonly auth: CognitoAuth;
} | null = null;

/** The Cognito sign-in for the current configuration; null in local development. */
export function getAuth(): CognitoAuth | null {
  if (override !== undefined) {
    return override;
  }
  const config = getRuntimeConfig();
  if (config.cognito === null) {
    return null;
  }
  if (cached?.config !== config) {
    cached = {
      config,
      auth: new CognitoAuth({
        config: config.cognito,
        storage: window.sessionStorage,
        fetch: (...args) => fetch(...args),
        now: () => Date.now(),
        navigate: (url) => window.location.assign(url),
        origin: window.location.origin,
      }),
    };
  }
  return cached.auth;
}

/** Test seam: replaces the sign-in; `undefined` restores the default. */
export function setAuth(auth: CognitoAuth | null | undefined): void {
  override = auth;
  cached = null;
}
