const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Store the database next to the server (or in a data folder)
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'chat.db');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables if they don't exist
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
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
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

console.log(`📦 SQLite database ready: ${dbPath}`);

module.exports = db;
