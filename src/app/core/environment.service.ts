import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { getServerConfig } from './common/server-config';
import { isElectron } from './common/electron';

export type RuntimeKind =
  | 'electron-sqlite'
  | 'electron-chat-server'
  | 'docker-prod'
  | 'docker-dev'
  | 'gcloud';

export type StorageProfile =
  | 'sqlite-all'
  | 'chats-idb'
  | 'chats-params-idb'
  | 'content-idb'
  | 'theme-local';

export type StorageKind =
  | 'users'
  | 'auth'
  | 'chats'
  | 'chat-parameters'
  | 'projects'
  | 'topics'
  | 'personas'
  | 'providers'
  | 'models';

export interface EnvironmentInfo {
  runtime: RuntimeKind;
  electron: boolean;
  docker?: boolean;
  localShell?: boolean;
  partlySqlite: boolean;
  storage: {
    profile: StorageProfile;
    sqlite: StorageKind[];
    idb: StorageKind[];
  };
  auth: {
    login: 'none' | 'google' | 'direct';
    username: string | null;
    userId: string | null;
    googleConfigured: boolean;
    required?: boolean;
    skipLogin?: boolean;
  };
}

const fallbackLocal: EnvironmentInfo = {
  runtime: 'electron-chat-server',
  electron: true,
  docker: false,
  localShell: true,
  partlySqlite: false,
  storage: {
    profile: 'sqlite-all',
    sqlite: ['users', 'auth', 'chats', 'chat-parameters', 'projects', 'topics', 'personas', 'providers', 'models'],
    idb: []
  },
  auth: { login: 'none', username: null, userId: null, googleConfigured: false, required: false, skipLogin: true }
};

@Injectable({ providedIn: 'root' })
export class EnvironmentService {
  private readonly http = inject(HttpClient);
  private readonly infoSig = signal<EnvironmentInfo | null>(null);
  private loadPromise: Promise<EnvironmentInfo> | null = null;

  readonly info = this.infoSig.asReadonly();
  readonly runtime = computed(() => this.infoSig()?.runtime ?? null);
  readonly storageProfile = computed(() => this.infoSig()?.storage.profile ?? 'sqlite-all');
  readonly loginName = computed(() => this.infoSig()?.auth.username ?? null);
  readonly loginKind = computed(() => this.infoSig()?.auth.login ?? 'none');
  readonly skipLogin = computed(() => {
    const info = this.infoSig();
    if (info?.auth.skipLogin != null) return info.auth.skipLogin;
    return isElectron() || !!info?.localShell || !!info?.electron || !!info?.docker;
  });
  readonly localShell = computed(() => {
    const info = this.infoSig();
    return !!(info?.localShell || info?.electron || info?.docker || isElectron());
  });

  usesIdb(kind: StorageKind): boolean {
    const info = this.infoSig();
    if (!info) return false;
    return info.storage.idb.includes(kind);
  }

  async refresh(): Promise<EnvironmentInfo> {
    this.loadPromise = this.fetch();
    const info = await this.loadPromise;
    this.infoSig.set(info);
    return info;
  }

  ensureLoaded(): Promise<EnvironmentInfo> {
    if (this.infoSig()) return Promise.resolve(this.infoSig()!);
    if (this.loadPromise) return this.loadPromise;
    return this.refresh();
  }

  private async fetch(): Promise<EnvironmentInfo> {
    try {
      return await firstValueFrom(
        this.http.get<EnvironmentInfo>(`${getServerConfig().apiBase}/environment`),
      );
    } catch {
      return {
        runtime: 'docker-dev',
        electron: false,
        docker: true,
        localShell: true,
        partlySqlite: false,
        storage: { profile: 'sqlite-all', sqlite: [], idb: [] },
        auth: {
          login: 'direct',
          username: null,
          userId: null,
          googleConfigured: false,
          required: true,
          skipLogin: false,
        },
      };
    }
  }
}
