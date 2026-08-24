const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * Returns a stable directory for the database.
 * - Under Electron → uses the userData folder (survives updates)
 * - In normal Node development → uses chat-server/data
 */
function getDataDir() {
  // Running inside Electron?
  if (process.versions.electron) {
    try {
      const { app } = require('electron');
      // This path is writable and survives app updates
      return path.join(app.getPath('userData'), 'data');
    } catch (err) {
      console.warn('Could not get Electron userData path, falling back to local data dir');
    }
  }

  // Fallback for development / pure Node
  return path.join(__dirname, '..', 'data');
}

const dataDir = getDataDir();

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'chat.db');
const db = new Database(dbPath);

// Better performance and less locking issues
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Schema ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
                                         id TEXT PRIMARY KEY,
                                         name TEXT NOT NULL,
                                         type TEXT NOT NULL,
                                         base_url TEXT NOT NULL,
                                         api_key TEXT NOT NULL,
                                         enabled INTEGER DEFAULT 1,
                                         created_at TEXT DEFAULT (datetime('now'))
    );

  CREATE TABLE IF NOT EXISTS models (
                                      id TEXT PRIMARY KEY,
                                      display_name TEXT NOT NULL,
                                      model_id TEXT NOT NULL,
                                      provider_id TEXT NOT NULL,
                                      type TEXT NOT NULL,          -- 'fetched' | 'preset' | 'discontinued'
                                      enabled INTEGER DEFAULT 1,
                                      context_length INTEGER,
                                      created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
                                        id TEXT PRIMARY KEY,
                                        name TEXT NOT NULL,
                                        system_prompt TEXT DEFAULT '',
                                        default_model_id TEXT,
                                        created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS personas (
                                        id TEXT PRIMARY KEY,
                                        name TEXT NOT NULL,
                                        short_name TEXT NOT NULL,
                                        description TEXT DEFAULT '',
                                        avatar TEXT DEFAULT '',
                                        created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
    );

  CREATE TABLE IF NOT EXISTS chats (
                                     id TEXT PRIMARY KEY,
                                     title TEXT NOT NULL,
                                     project_id TEXT,
                                     created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

  CREATE TABLE IF NOT EXISTS chat_nodes (
                                          id TEXT PRIMARY KEY,
                                          chat_id TEXT NOT NULL,
                                          parent_id TEXT,
                                          type TEXT NOT NULL CHECK(type IN ('question', 'answer')),
    content TEXT NOT NULL,
    model_id TEXT,
    provider_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    previous_version_id TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    is_current INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES chat_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (previous_version_id) REFERENCES chat_nodes(id)
    );

  CREATE INDEX IF NOT EXISTS idx_chat_nodes_chat_id ON chat_nodes(chat_id);
  CREATE INDEX IF NOT EXISTS idx_chat_nodes_parent_id ON chat_nodes(parent_id);
`);

// Migration for existing DBs that already have chats without project_id
try {
  const cols = db.prepare(`PRAGMA table_info(chats)`).all().map(c => c.name);
  if (!cols.includes('project_id')) {
    db.exec(`ALTER TABLE chats ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`);
    console.log('Migrated chats table: added project_id');
  }
} catch (e) {
  // ignore if already present or other issues
}

console.log(`📦 SQLite database ready: ${dbPath}`);

module.exports = db;
