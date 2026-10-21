import { apiBasePath } from '@claimflow/contracts';

/** Where Cognito sends the browser back after the hosted UI. */
export const authCallbackPath = '/auth/callback';

/** The Cognito hosted UI and app client used for sign-in. */
export interface CognitoWebConfig {
  /** Origin of the hosted UI domain, for example `https://x.auth.<region>.amazoncognito.com`. */
  readonly hostedUiUrl: string;
  readonly clientId: string;
}

export interface RuntimeConfig {
  /** Base URL of every API route, without a trailing slash. */
  readonly apiBaseUrl: string;
  /** Absent in local development, which signs in with sample users. */
  readonly cognito: CognitoWebConfig | null;
}

/** Local development: same-origin API behind the dev proxy, sample users. */
export const localConfig: RuntimeConfig = {
  apiBaseUrl: apiBasePath,
  cognito: null,
};

export const runtimeConfigPath = '/config.json';

/** The only hosts where development sign-in may be used. */
const localHostnames: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

let current: RuntimeConfig = localConfig;

export function getRuntimeConfig(): RuntimeConfig {
  return current;
}

export function setRuntimeConfig(config: RuntimeConfig): void {
  current = config;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function absoluteUrl(
  value: unknown,
  field: string,
  options: { readonly allowPath: boolean; readonly allowLocalHttp: boolean },
): string {
  if (typeof value !== 'string') {
    throw new ConfigError(`${field} must be a URL string.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${field} must be an absolute URL.`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const secure =
    url.protocol === 'https:' ||
    (options.allowLocalHttp && local && url.protocol === 'http:');
  if (!secure) {
    throw new ConfigError(`${field} must use https.`);
  }
  if (
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new ConfigError(`${field} must not have credentials, query or hash.`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!options.allowPath && path !== '') {
    throw new ConfigError(`${field} must be an origin without a path.`);
  }
  return `${url.origin}${path}`;
}

/** Validates the parsed contents of `config.json`. */
export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const config = record(value, 'config');
  const cognito = record(config.cognito, 'cognito');
  const clientId = cognito.clientId;
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9]+$/.test(clientId)) {
    throw new ConfigError('cognito.clientId must be an app client ID.');
  }
  return {
    apiBaseUrl: absoluteUrl(config.apiBaseUrl, 'apiBaseUrl', {
      allowPath: true,
      allowLocalHttp: true,
    }),
    cognito: {
      hostedUiUrl: absoluteUrl(cognito.hostedUiUrl, 'cognito.hostedUiUrl', {
        allowPath: false,
        allowLocalHttp: false,
      }),
      clientId,
    },
  };
}

/**
 * Reads the deployment's `/config.json`. On localhost or 127.0.0.1 only,
 * without one (unreachable, 404, or the dev server's HTML fallback) the app
 * runs in local development mode. On any other host a missing or unusable
 * file, and on every host an invalid one, is an error, never a fallback.
 */
export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  hostname: string = window.location.hostname,
): Promise<RuntimeConfig> {
  // Development sign-in has no passwords, so it is only a fallback on the
  // developer's own machine; anywhere else a missing config is an error.
  const missing = (reason: string): RuntimeConfig => {
    if (localHostnames.has(hostname)) {
      return localConfig;
    }
    throw new ConfigError(`config.json ${reason}.`);
  };
  let response: Response;
  try {
    response = await fetchImpl(runtimeConfigPath, { cache: 'no-store' });
  } catch {
    return missing('could not be loaded');
  }
  if (!response.ok) {
    return missing('is not available');
  }
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    return missing('is not JSON');
  }
  try {
    return parseRuntimeConfig(await response.json());
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError('config.json is not valid JSON.');
  }
}
