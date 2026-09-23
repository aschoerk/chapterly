import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express, NextFunction, Request, Response } from 'express';
import type { PersistencePort } from '../domain/chat-api.port.js';
import { badRequest, HttpError } from './http-error.js';

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

export function normalizeBase(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function proxySuffix(req: Request): string {
  const original = req.originalUrl || req.url;
  const url = new URL(original, 'http://127.0.0.1');
  const path = url.pathname.replace(/^\/proxy/, '') || '/';
  return `${path}${url.search}`;
}

async function resolveUpstream(
  req: Request,
  store: PersistencePort
): Promise<{ baseUrl: string; authorization: string | undefined; providerId?: string }> {
  const providerId = header(req, 'x-provider-id');
  const targetBase = header(req, 'x-target-base');
  const authorization = header(req, 'authorization');

  if (providerId) {
    const providers = await store.getProviders();
    const provider = providers.find((row) => row.id === providerId);
    if (!provider) {
      throw new HttpError(403, 'provider is not in this store');
    }
    if (!provider.enabled) {
      throw new HttpError(403, 'provider is disabled');
    }
    return {
      baseUrl: normalizeBase(provider.baseUrl),
      authorization: `Bearer ${provider.apiKey}`,
      providerId: provider.id
    };
  }

  if (!targetBase) {
    throw badRequest('Missing x-target-base or x-provider-id header');
  }

  return {
    baseUrl: normalizeBase(targetBase),
    authorization
  };
}

async function handleProxy(req: Request, res: Response, store: PersistencePort): Promise<void> {
  const upstream = await resolveUpstream(req, store);
  const target = `${upstream.baseUrl}${proxySuffix(req)}`;
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  const method = req.method.toUpperCase();
  const headers: Record<string, string> = {};
  if (upstream.authorization) headers.Authorization = upstream.authorization;
  const referer = header(req, 'http-referer') ?? header(req, 'referer');
  if (referer) headers['HTTP-Referer'] = referer;
  const title = header(req, 'x-title');
  if (title) headers['X-Title'] = title;
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
  }

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? JSON.stringify(req.body ?? {}) : undefined;

  console.log(`→ ${method} ${proxySuffix(req)}  →  ${upstream.baseUrl}` +
    (upstream.providerId ? `  provider=${upstream.providerId}` : ''));

  const response = await fetch(target, {
    method,
    headers,
    body,
    signal: abort.signal
  });

  console.log(`← Status: ${response.status}`);

  res.status(response.status);
  const contentType = response.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache');

  if (!response.body) {
    res.send(await response.text());
    return;
  }

  const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  await pipeline(nodeStream, res);
}

export function registerProxyRoutes(app: Express, store: PersistencePort): void {
  app.use('/proxy', (req: Request, res: Response, next: NextFunction) => {
    handleProxy(req, res, store).catch(next);
  });
}
