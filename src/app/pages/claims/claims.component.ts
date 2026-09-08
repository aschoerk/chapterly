import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService, TokenClaims } from '../../core/auth.service';
import { getServerConfig } from '../../core/common/server-config';
import { I18nService } from '../../core/i18n/i18n.service';

interface UserRow {
  id: string;
  username: string;
  email?: string | null;
  isAdmin?: boolean;
}

interface NamedRow {
  id: string;
  name: string;
}

interface GrantRow {
  userId: string;
  clientId: string;
  workspaceId?: string | null;
  walletId?: string | null;
  scopes: string[];
  status: string;
}

@Component({
  selector: 'app-claims',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './claims.component.html',
  styleUrl: './claims.component.css'
})
export class ClaimsComponent {
  private readonly http = inject(HttpClient);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18nService);

  readonly users = signal<UserRow[]>([]);
  readonly workspaces = signal<NamedRow[]>([]);
  readonly wallets = signal<NamedRow[]>([]);
  readonly workspaceGrants = signal<GrantRow[]>([]);
  readonly walletGrants = signal<GrantRow[]>([]);
  readonly selectedUserId = signal<string>('');
  typedUserId = '';
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  constructor() {
    void this.reload();
  }

  private api(path: string): string {
    return `${getServerConfig().apiBase}${path}`;
  }

  tokenClaims(): TokenClaims | null {
    return this.auth.claims();
  }

  async reload(): Promise<void> {
    this.error.set(null);
    try {
      const [users, workspaces, wallets] = await Promise.all([
        firstValueFrom(this.http.get<UserRow[]>(this.api('/users'))),
        firstValueFrom(this.http.get<NamedRow[]>(this.api('/workspaces'))),
        firstValueFrom(this.http.get<NamedRow[]>(this.api('/wallets')))
      ]);
      this.users.set(users);
      this.workspaces.set(workspaces);
      this.wallets.set(wallets);
      if (!this.selectedUserId() && users[0]) this.selectedUserId.set(users[0].id);
      await this.reloadGrants();
    } catch (err: unknown) {
      const http = err as { error?: { error?: string } };
      this.error.set(http?.error?.error || this.i18n.t('claims.loadFailed'));
    }
  }

  async reloadGrants(): Promise<void> {
    const userId = this.selectedUserId();
    if (!userId) {
      this.workspaceGrants.set([]);
      this.walletGrants.set([]);
      return;
    }
    try {
      const [ws, wl] = await Promise.all([
        firstValueFrom(this.http.get<GrantRow[]>(this.api(`/users/${userId}/content-authorizations`))),
        firstValueFrom(this.http.get<GrantRow[]>(this.api(`/users/${userId}/provider-authorizations`)))
      ]);
      this.workspaceGrants.set(ws);
      this.walletGrants.set(wl);
    } catch {
      this.workspaceGrants.set([]);
      this.walletGrants.set([]);
    }
  }

  onUserChange(id: string): void {
    this.selectedUserId.set(id);
    void this.reloadGrants();
  }

  workspaceAccess(workspaceId: string): 'none' | 'read' | 'write' {
    const row = this.workspaceGrants().find(g => (g.workspaceId || g.clientId) === workspaceId && g.status === 'granted');
    if (!row) return 'none';
    return row.scopes.includes('topics.write') ? 'write' : 'read';
  }

  walletAccess(walletId: string): 'none' | 'run' | 'manage' {
    const row = this.walletGrants().find(g => (g.walletId || g.clientId) === walletId && g.status === 'granted');
    if (!row) return 'none';
    return row.scopes.includes('providers.write') ? 'manage' : 'run';
  }

  async setWorkspace(workspaceId: string, access: 'none' | 'read' | 'write'): Promise<void> {
    const userId = this.selectedUserId();
    if (!userId) return;
    this.notice.set(null);
    try {
      if (access === 'none') {
        await firstValueFrom(this.http.delete(this.api(`/workspaces/${workspaceId}/authorizations/${userId}`)));
      } else {
        const scopes = access === 'write' ? ['topics.read', 'topics.write'] : ['topics.read'];
        await firstValueFrom(this.http.post(this.api(`/workspaces/${workspaceId}/authorizations`), { userId, scopes }));
      }
      this.notice.set(this.i18n.t('claims.wsSaved'));
      await this.reloadGrants();
    } catch (err: unknown) {
      const http = err as { error?: { error?: string } };
      this.error.set(http?.error?.error || this.i18n.t('claims.wsFailed'));
    }
  }

  async setWallet(walletId: string, access: 'none' | 'run' | 'manage'): Promise<void> {
    const userId = this.selectedUserId();
    if (!userId) return;
    this.notice.set(null);
    try {
      if (access === 'none') {
        await firstValueFrom(this.http.delete(this.api(`/wallets/${walletId}/authorizations/${userId}`)));
      } else {
        const scopes = access === 'manage' ? ['providers.read', 'providers.write'] : ['providers.read'];
        await firstValueFrom(this.http.post(this.api(`/wallets/${walletId}/authorizations`), { userId, scopes }));
      }
      this.notice.set(this.i18n.t('claims.wlSaved'));
      await this.reloadGrants();
    } catch (err: unknown) {
      const http = err as { error?: { error?: string } };
      this.error.set(http?.error?.error || this.i18n.t('claims.wlFailed'));
    }
  }
}
