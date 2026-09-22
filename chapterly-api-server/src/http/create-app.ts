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

export function createApp(store: PersistencePort) {
  const app = express();
  const spaRoot = publicDir();

  app.use(cors({ origin: ['http://localhost:4200'] }));
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
  });

  return app;
}
