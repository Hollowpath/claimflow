import { authCallbackPath, type CognitoWebConfig } from '../config';
import { codeChallenge, randomUrlSafe } from './pkce';

export const authScopes = 'openid email';

const tokensKey = 'claimflow.auth.tokens';
const pendingKey = 'claimflow.auth.pending';
/** Refresh this long before the access token expires. */
const refreshSkewMs = 60_000;

/** A sign-in problem with a message that is safe to show. */
export class AuthError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
}

interface PendingSignIn {
  readonly state: string;
  readonly verifier: string;
}

export interface AuthDeps {
  readonly config: CognitoWebConfig;
  /** Session-scoped storage; tokens never go to localStorage. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly navigate: (url: string) => void;
  readonly origin: string;
}

/**
 * Cognito hosted UI sign-in with the authorization code flow and PKCE. Only
 * the access token (which the API's JWT authorizer requires) and the refresh
 * token are kept, in session storage; the ID token is never stored.
 */
export class CognitoAuth {
  private refreshing: Promise<string | null> | null = null;
  private readonly callbacks = new Map<string, Promise<void>>();

  public constructor(private readonly deps: AuthDeps) {}

  private get redirectUri(): string {
    return `${this.deps.origin}${authCallbackPath}`;
  }

  public isSignedIn(): boolean {
    return this.readTokens() !== null;
  }

  /** Remembers a fresh state and verifier, then opens the hosted UI. */
  public async beginSignIn(): Promise<void> {
    const pending: PendingSignIn = {
      state: randomUrlSafe(32),
      verifier: randomUrlSafe(64),
    };
    this.deps.storage.setItem(pendingKey, JSON.stringify(pending));
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: this.deps.config.clientId,
      redirect_uri: this.redirectUri,
      scope: authScopes,
      state: pending.state,
      code_challenge: await codeChallenge(pending.verifier),
      code_challenge_method: 'S256',
    });
    this.deps.navigate(
      `${this.deps.config.hostedUiUrl}/oauth2/authorize?${query}`,
    );
  }

  /**
   * Finishes the redirect back from the hosted UI. The pending state is
   * single-use, and repeated calls for the same query share one exchange.
   */
  public completeSignIn(search: string): Promise<void> {
    let run = this.callbacks.get(search);
    if (run === undefined) {
      run = this.runCallback(search);
      this.callbacks.set(search, run);
    }
    return run;
  }

  /** A usable access token, refreshed first if it is about to expire. */
  public async getAccessToken(): Promise<string | null> {
    const tokens = this.readTokens();
    if (tokens === null) {
      return null;
    }
    if (tokens.expiresAt - this.deps.now() > refreshSkewMs) {
      return tokens.accessToken;
    }
    return this.refresh();
  }

  /**
   * Called after the API rejected `rejected`. Returns a different token if one
   * is already available, otherwise refreshes; null means sign in again.
   */
  public async refreshAfterUnauthorized(
    rejected: string,
  ): Promise<string | null> {
    const tokens = this.readTokens();
    if (tokens === null) {
      return null;
    }
    if (tokens.accessToken !== rejected) {
      return tokens.accessToken;
    }
    return this.refresh();
  }

  /** Forgets the local sign-in without leaving the page. */
  public clearLocal(): void {
    this.deps.storage.removeItem(tokensKey);
    this.deps.storage.removeItem(pendingKey);
  }

  /** Clears local authentication, then ends the Cognito session too. */
  public signOut(): void {
    this.clearLocal();
    const query = new URLSearchParams({
      client_id: this.deps.config.clientId,
      logout_uri: `${this.deps.origin}/`,
    });
    this.deps.navigate(`${this.deps.config.hostedUiUrl}/logout?${query}`);
  }

  private async runCallback(search: string): Promise<void> {
    const params = new URLSearchParams(search);
    const pending = this.takePending();
    const state = params.get('state');
    if (pending === null || state === null || state !== pending.state) {
      throw new AuthError('Sign-in could not be verified. Please try again.');
    }
    const error = params.get('error');
    if (error !== null) {
      const description = params.get('error_description');
      throw new AuthError(
        description === null || description === ''
          ? `Sign-in was not completed (${error}).`
          : description.slice(0, 200),
      );
    }
    const code = params.get('code');
    if (code === null || code === '') {
      throw new AuthError('Sign-in did not return a code. Please try again.');
    }
    const response = await this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: this.deps.config.clientId,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    });
    const tokens = response.ok ? this.parseTokens(response.body, null) : null;
    if (tokens === null) {
      throw new AuthError('Sign-in failed. Please try again.');
    }
    this.deps.storage.setItem(tokensKey, JSON.stringify(tokens));
  }

  /** Concurrent callers share one refresh request. */
  private refresh(): Promise<string | null> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<string | null> {
    const stored = this.readTokens();
    if (stored?.refreshToken == null) {
      this.clearLocal();
      return null;
    }
    // A network failure throws and keeps the tokens; only a rejection signs out.
    const response = await this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: this.deps.config.clientId,
      refresh_token: stored.refreshToken,
    });
    const tokens = response.ok
      ? this.parseTokens(response.body, stored.refreshToken)
      : null;
    if (tokens === null) {
      this.clearLocal();
      return null;
    }
    this.deps.storage.setItem(tokensKey, JSON.stringify(tokens));
    return tokens.accessToken;
  }

  private async tokenRequest(
    form: Record<string, string>,
  ): Promise<{ readonly ok: boolean; readonly body: unknown }> {
    let response: Response;
    try {
      response = await this.deps.fetch(
        `${this.deps.config.hostedUiUrl}/oauth2/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form),
          credentials: 'omit',
        },
      );
    } catch {
      throw new AuthError('Cannot reach the sign-in service.');
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A failed exchange needs no body.
    }
    return { ok: response.ok, body };
  }

  private parseTokens(
    body: unknown,
    previousRefreshToken: string | null,
  ): StoredTokens | null {
    if (typeof body !== 'object' || body === null) {
      return null;
    }
    const { access_token, refresh_token, expires_in } = body as Record<
      string,
      unknown
    >;
    if (
      typeof access_token !== 'string' ||
      access_token === '' ||
      typeof expires_in !== 'number' ||
      !(expires_in > 0)
    ) {
      return null;
    }
    return {
      accessToken: access_token,
      refreshToken:
        typeof refresh_token === 'string' && refresh_token !== ''
          ? refresh_token
          : previousRefreshToken,
      expiresAt: this.deps.now() + expires_in * 1000,
    };
  }

  private takePending(): PendingSignIn | null {
    const raw = this.deps.storage.getItem(pendingKey);
    this.deps.storage.removeItem(pendingKey);
    if (raw === null) {
      return null;
    }
    try {
      const value = JSON.parse(raw) as Partial<PendingSignIn>;
      return typeof value.state === 'string' &&
        typeof value.verifier === 'string'
        ? { state: value.state, verifier: value.verifier }
        : null;
    } catch {
      return null;
    }
  }

  private readTokens(): StoredTokens | null {
    const raw = this.deps.storage.getItem(tokensKey);
    if (raw === null) {
      return null;
    }
    try {
      const value = JSON.parse(raw) as Partial<StoredTokens>;
      if (
        typeof value.accessToken === 'string' &&
        typeof value.expiresAt === 'number' &&
        (value.refreshToken === null || typeof value.refreshToken === 'string')
      ) {
        return {
          accessToken: value.accessToken,
          refreshToken: value.refreshToken,
          expiresAt: value.expiresAt,
        };
      }
    } catch {
      // Fall through to discard the unreadable value.
    }
    this.deps.storage.removeItem(tokensKey);
    return null;
  }
}
