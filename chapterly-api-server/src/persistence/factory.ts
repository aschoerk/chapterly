import fs from 'node:fs';
import path from 'node:path';
import type { PersistenceKind, PersistencePort } from '../domain/chat-api.port.js';
import { MemoryPersistence } from './memory/memory-persistence.js';
import { SnapshotPersistence } from './snapshot-store.js';

function env(name: string): string | undefined {
  const value = process.env[name];
  if (value == null || value.trim() === '') return undefined;
  return value.trim();
}

export function detectPersistenceKind(): PersistenceKind {
  const forced = env('PERSISTENCE');
  if (forced === 'memory' || forced === 'sqlite' || forced === 'firebase') return forced;
  if (env('K_SERVICE') || env('CLOUD_RUN_JOB') || env('AWS_EXECUTION_ENV') || env('AWS_REGION')) {
    return 'firebase';
  }
  return 'sqlite';
}

function sqlitePath(): string {
  const explicit = env('SQLITE_PATH');
  if (explicit) return explicit;
  if (process.versions.electron) {
    try {
      const electron = require('electron') as { app: { getPath: (name: string) => string } };
      return path.join(electron.app.getPath('userData'), 'data', 'chapterly.sqlite');
    } catch {
      // fall through
    }
  }
  return path.join(process.cwd(), 'data', 'chapterly.sqlite');
}

export async function createPersistence(): Promise<PersistencePort> {
  const kind = detectPersistenceKind();
  if (kind === 'memory') {
    const store = new MemoryPersistence();
    await store.init();
    return store;
  }
  if (kind === 'firebase') {
    const { FirebaseSnapshotBackend } = await import('./firebase/firebase-backend.js');
    const store = new SnapshotPersistence(new FirebaseSnapshotBackend());
    await store.init();
    return store;
  }
  const file = sqlitePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { SqlitePersistence } = await import('./sqlite/sqlite-persistence.js');
  const store = new SqlitePersistence(file);
  await store.init();
  return store;
}
