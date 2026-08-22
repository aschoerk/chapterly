export interface ServerConfig {
  apiBase: string;
  proxyBase: string;
}

const DEFAULT_PORT = 3000;

/**
 * Returns the base URLs for the Node server.
 * Later we can make this smarter (read from a config file, environment, etc.).
 */
export function getServerConfig(): ServerConfig {
  // For now we use a fixed port.
  // Later you can replace this with a dynamic discovery or environment variable.
  const port = DEFAULT_PORT;

  const base = `http://localhost:${port}`;

  return {
    apiBase: `${base}/api`,
    proxyBase: `${base}/proxy`
  };
}
