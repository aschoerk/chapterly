export type EditionName = 'electron' | 'oidc' | 'web' | 'admin';

export type PersistKey =
  | 'users'
  | 'auth'
  | 'chats'
  | 'chatParameters'
  | 'providers'
  | 'models'
  | 'topics'
  | 'personas'
  | 'projects'
  | 'grants'
  | 'workspaces'
  | 'wallets';

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

export interface PersistMap {
  users: boolean;
  auth: boolean;
  chats: boolean;
  chatParameters: boolean;
  providers: boolean;
  models: boolean;
  topics: boolean;
  personas: boolean;
  projects: boolean;
  grants: boolean;
  workspaces: boolean;
  wallets: boolean;
}

export interface EditionLogin {
  login: 'none' | 'google' | 'direct';
  username: string | null;
  userId: string | null;
  googleConfigured: boolean;
  required: boolean;
  skipLogin: boolean;
  admin?: boolean;
}

export interface EditionInfo {
  edition: EditionName;
  auth: 'none' | 'bearer' | 'admin';
  swagger?: { enabled: boolean; security: string };
  persist: PersistMap;
  serveSpa?: boolean;
  login: EditionLogin;
}

export interface EditionCapabilities {
  showLogin: boolean;
  showLogout: boolean;
  showClaims: boolean;
  showStudio: boolean;
  showApiKeys: boolean;
  attachBearer: boolean;
}

export const KIND_TO_PERSIST: Record<StorageKind, PersistKey> = {
  users: 'users',
  auth: 'auth',
  chats: 'chats',
  'chat-parameters': 'chatParameters',
  projects: 'projects',
  topics: 'topics',
  personas: 'personas',
  providers: 'providers',
  models: 'models',
};

export function capabilitiesFor(info: EditionInfo): EditionCapabilities {
  const open = info.auth === 'none';
  return {
    showLogin: !open,
    showLogout: !open,
    showClaims: info.edition === 'oidc' || info.edition === 'admin',
    showStudio: info.edition !== 'admin',
    showApiKeys: info.edition === 'electron' || info.edition === 'web',
    attachBearer: info.auth !== 'none',
  };
}
