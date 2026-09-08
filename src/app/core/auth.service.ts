import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { getServerConfig } from './common/server-config';
import { isElectron } from './common/electron';

const TOKEN_KEY = 'chapterly.access_token';
const REFRESH_KEY = 'chapterly.refresh_token';
const CLAIMS_KEY = 'chapterly.claims';
const SKIP_KEY = 'chapterly.skip_auth';

export interface TopicClaim {
  workspaceId?: string;
  contentClientId?: string;
  access: 'read' | 'write';
}

export interface ProviderClaim {
  walletId?: string;
  providerClientId?: string;
  access: 'run' | 'manage';
  contingent?: { maxCost?: number | null; maxTokens?: number | null };
}

export interface TokenClaims {
  topics: TopicClaim[];
  provider: ProviderClaim | null;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  user_id?: string;
  claims?: TokenClaims;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  /** When chapterly is launched as an Electron app, no login is used. */
  readonly electron = isElectron();

  private readonly tokenSig = signal<string | null>(sessionStorage.getItem(TOKEN_KEY));
  private readonly claimsSig = signal<TokenClaims | null>(readClaims());
  readonly skipAuth = signal(this.electron || sessionStorage.getItem(SKIP_KEY) === '1');

  readonly accessToken = this.tokenSig.asReadonly();
  readonly claims = this.claimsSig.asReadonly();
  readonly isLoggedIn = computed(() => this.skipAuth() || !!this.tokenSig());

  private api(path: string): string {
    return `${getServerConfig().apiBase}${path}`;
  }

  /**
   * Headers for /proxy. A Chapterly access token wins over a provider API key
   * so the server can resolve the wallet. fetch() bypasses the HTTP interceptor.
   */
  proxyAuthHeaders(opts: {
    apiKey?: string | null;
    providerBaseUrl?: string | null;
    providerId?: string | null;
  } = {}): Record<string, string> {
    const token = this.electron ? null : this.accessToken();
    const bearer = token || opts.apiKey || '';
    const headers: Record<string, string> = {};
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    if (opts.providerBaseUrl) headers['x-target-base'] = opts.providerBaseUrl;
    if (token && opts.providerId) headers['x-provider-id'] = opts.providerId;
    return headers;
  }

  async login(username: string, password: string): Promise<TokenResponse> {
    const authorize = await firstValueFrom(
      this.http.post<{ code: string; claims: TokenClaims; user_id: string }>(
        this.api('/oauth/dev/authorize'),
        { username, password }
      )
    );
    return this.exchangeCode(authorize.code);
  }

  async exchangeCode(code: string): Promise<TokenResponse> {
    const token = await firstValueFrom(
      this.http.post<TokenResponse>(this.api('/oauth/token'), {
        grant_type: 'authorization_code',
        code
      })
    );
    this.store(token);
    this.skipAuth.set(false);
    sessionStorage.removeItem(SKIP_KEY);
    return token;
  }

  async googleEnabled(): Promise<boolean> {
    try {
      const info = await firstValueFrom(this.http.get<{ enabled: boolean }>(this.api('/oauth/google')));
      return !!info.enabled;
    } catch {
      return false;
    }
  }

  startGoogleLogin(): void {
    const returnTo = `${window.location.origin}${window.location.pathname || '/'}#/login`;
    window.location.href = `${this.api('/oauth/google/start')}?return_to=${encodeURIComponent(returnTo)}`;
  }

  continueWithoutToken(): void {
    this.clear();
    this.skipAuth.set(true);
    sessionStorage.setItem(SKIP_KEY, '1');
  }

  logout(): void {
    const raw = this.tokenSig();
    if (raw) {
      this.http.post(this.api('/oauth/revoke'), { token: raw }).subscribe({ error: () => undefined });
    }
    this.clear();
    this.skipAuth.set(false);
    sessionStorage.removeItem(SKIP_KEY);
  }

  private store(token: TokenResponse): void {
    sessionStorage.setItem(TOKEN_KEY, token.access_token);
    if (token.refresh_token) sessionStorage.setItem(REFRESH_KEY, token.refresh_token);
    if (token.claims) sessionStorage.setItem(CLAIMS_KEY, JSON.stringify(token.claims));
    this.tokenSig.set(token.access_token);
    this.claimsSig.set(token.claims ?? null);
  }

  private clear(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
    sessionStorage.removeItem(CLAIMS_KEY);
    this.tokenSig.set(null);
    this.claimsSig.set(null);
  }
}

function readClaims(): TokenClaims | null {
  const raw = sessionStorage.getItem(CLAIMS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenClaims;
  } catch {
    return null;
  }
}
