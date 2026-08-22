export interface ProxyConfig {
  port: number;
}

let cachedPort: number | null = null;

export async function getProxyBaseUrl(): Promise<string> {
  if (cachedPort) {
    return `http://localhost:${cachedPort}`;
  }

  try {
    const response = await fetch('/assets/proxy-config.json');
    const config: ProxyConfig = await response.json();
    cachedPort = config.port;
    return `http://localhost:${cachedPort}`;
  } catch (err) {
    console.warn('Could not load proxy-config.json, falling back to port 3000');
    return 'http://localhost:3000';
  }
}
