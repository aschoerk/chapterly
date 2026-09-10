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
  const localDev = browser && /^http:\/\/localhost:4200/.test(origin);

  const port = getServerPort();
  const fallback = `http://localhost:${port}`;

  return {
    apiBase: `${localDev ? fallback : origin}/api`,
    proxyBase: `${localDev ? fallback : origin}/proxy`,
    mode: isElectron() ? "local" : "cloud"
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
