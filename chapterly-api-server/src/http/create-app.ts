import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PersistencePort } from '../domain/chat-api.port.js';
import { HttpError } from './http-error.js';
import { registerOpenApiRoutes } from './openapi.js';
import { registerProxyRoutes } from './proxy.js';
import { registerChatApiRoutes } from './routes.js';

function publicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'public'),
    path.resolve(here, '../public'),
    path.resolve(here, '../../public'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? candidates[0];
}

/**
 * Central error handler for the API app. Must be registered AFTER the routes
 * whose errors it should catch (Express only forwards to downstream handlers),
 * e.g. the chat routes and the streaming /proxy route.
 */
export function errorHandler(err: unknown, res: Response): void {
  // Safety net for streamed/partial responses (e.g. a proxy body that failed
  // mid-stream): once headers are flushed we cannot send a status or body,
  // so close the connection instead of crashing with ERR_HTTP_HEADERS_SENT.
  if (res.headersSent) {
    try { res.end(); } catch { /* client may already be gone */ }
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const named = err as { name?: string };
  if (named?.name === 'AbortError') {
    res.end();
    return;
  }
  const message = err instanceof Error ? err.message : 'internal error';
  res.status(500).json({ error: message });
}

export function createApp(store: PersistencePort) {
  const app = express();
  const spaRoot = publicDir();

  // 'null' is the Origin the browser sends when the SPA is loaded from a
  // file:// URL (packaged Electron). Allow it so the desktop app can reach the
  // localhost API without being blocked by CORS.
  app.use(cors({ origin: ['http://localhost:4200', 'null'] }));
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, persistence: store.kind });
  });
  app.get('/api/environment', (_req, res) => {
    res.json({
      runtime: store.kind === 'firebase' ? 'gcloud' : 'local',
      storage: {
        profile: 'sqlite-all',
        sqlite: [
          'users',
          'auth',
          'chats',
          'chat-parameters',
          'projects',
          'topics',
          'personas',
          'providers',
          'models',
        ],
        idb: [],
      },
      persistence: store.kind,
    });
  });

  registerOpenApiRoutes(app);
  registerChatApiRoutes(app, store);
  registerProxyRoutes(app, store);

  app.use(express.static(spaRoot, { index: 'index.html', fallthrough: true }));

  app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const index = path.join(spaRoot, 'index.html');
    if (!fs.existsSync(index)) {
      res.status(404).json({ error: `SPA not found at ${spaRoot}` });
      return;
    }
    res.sendFile(index);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    errorHandler(err, res);
  });

  return app;
}
