import {isElectron} from './electron';

export interface ServerConfig {
  apiBase: string;
  proxyBase: string;
  mode: string;
}

/**
 * Returns the base URLs for the Node server.
 * Later we can make this smarter (read from a config file, environment, etc.).
 */
export function getServerConfig(): ServerConfig {
  const browser = typeof window !== 'undefined';
  const origin = browser ? window.location.origin : '';
  // Dev server may be reached as localhost or via the literal 127.0.0.1
  // (Playwright/firewalled setups). Treat both as "local dev" so the
  // ?port= query (and the 127.0.0.1 fallback below) selects the API base
  // instead of the web origin.
  const localDev = browser && /^https?:\/\/(localhost|127\.0\.0\.1):4200/.test(origin);

  const port = getServerPort();
  const fallback = `http://127.0.0.1:${port}`;

  // Packaged Electron loads the SPA straight from disk (file:// …), where
  // window.location.origin is the string "null" (or empty) — not usable as an
  // API base. The local API server always answers on 127.0.0.1:<port>, so use
  // the port-based fallback unless the page is served from a real http origin.
  const base = localDev || !/^https?:/.test(origin) ? fallback : origin;

  // IndexedDB content only after a Google / OAuth access token exists.
  // Electron and skip/password stay on the local chat-server.
  const hasToken = typeof sessionStorage !== 'undefined'
    && !!sessionStorage.getItem('chapterly.access_token');

  return {
    apiBase: `${base}/api`,
    proxyBase: `${base}/proxy`,
    mode: isElectron() && !hasToken ? "local" : "cloud"
  };
}

// Example service
export function getServerPort(): number {
  // 1. Try query parameter
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('port');
  if (fromQuery) return Number(fromQuery);

  // 2. Fallback
  return 3847;
}
