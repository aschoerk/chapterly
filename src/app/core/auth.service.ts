import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { getServerConfig } from './common/server-config';

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

  private readonly tokenSig = signal<string | null>(sessionStorage.getItem(TOKEN_KEY));
  private readonly claimsSig = signal<TokenClaims | null>(readClaims());
  readonly skipAuth = signal(sessionStorage.getItem(SKIP_KEY) === '1');

  readonly accessToken = this.tokenSig.asReadonly();
  readonly claims = this.claimsSig.asReadonly();
  readonly isLoggedIn = computed(() => !!this.tokenSig() || this.skipAuth());

  private api(path: string): string {
    return `${getServerConfig().apiBase}${path}`;
  }

  async login(username: string, password: string): Promise<TokenResponse> {
    const authorize = await firstValueFrom(
      this.http.post<{ code: string; claims: TokenClaims; user_id: string }>(
        this.api('/oauth/dev/authorize'),
        { username, password }
      )
    );
    const token = await firstValueFrom(
      this.http.post<TokenResponse>(this.api('/oauth/token'), {
        grant_type: 'authorization_code',
        code: authorize.code
      })
    );
    this.store(token);
    this.skipAuth.set(false);
    sessionStorage.removeItem(SKIP_KEY);
    return token;
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
