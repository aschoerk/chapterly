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
  // For now we use a fixed port.
  // Later you can replace this with a dynamic discovery or environment variable.

  const port = getServerPort();

  const base = `http://localhost:${port}`;

  return {
    apiBase: `${base}/api`,
    proxyBase: `${base}/proxy`,
    mode: "local"  // indexdb: "cloud"
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
