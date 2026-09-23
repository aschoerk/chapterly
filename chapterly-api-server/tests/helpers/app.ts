import { createApp } from '../../src/http/create-app.js';
import { SqlitePersistence } from '../../src/persistence/sqlite/sqlite-persistence.js';

export async function makeApp() {
  const store = new SqlitePersistence(':memory:'); // better-sqlite3 in-memory
  await store.init();
  return { app: createApp(store), store };
}
