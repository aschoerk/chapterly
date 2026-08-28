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

/**
 * Applies all necessary migrations/schema definitions to the given database instance
 */
function initializeSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
                                        catalog_json TEXT,
                                        created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
      );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
                                          id TEXT PRIMARY KEY,
                                          name TEXT NOT NULL,
                                          greeting TEXT DEFAULT '',
                                          system_prompt TEXT DEFAULT '',
                                          default_model_id TEXT,
                                          avatar TEXT DEFAULT '',
                                          persona_ids TEXT DEFAULT '[]',
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
      thinking TEXT,
      model_id TEXT,
      provider_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      previous_version_id TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      attachments TEXT DEFAULT '[]',
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      description           TEXT DEFAULT '',
      default_model_id      TEXT,
      default_system_prompt TEXT DEFAULT '',
      icon                  TEXT DEFAULT '',
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS topic_projects (
      topic_id   TEXT NOT NULL,
      project_id TEXT NOT NULL,
      PRIMARY KEY (topic_id, project_id),
      FOREIGN KEY (topic_id)   REFERENCES topics(id)   ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_topic_projects_topic   ON topic_projects(topic_id);
    CREATE INDEX IF NOT EXISTS idx_topic_projects_project ON topic_projects(project_id);
  `);

  // Migration example
  try {
    const modelCols = db.prepare(`PRAGMA table_info(models)`).all().map(c => c.name);
    if (!modelCols.includes('catalog_json')) {
      db.exec(`ALTER TABLE models ADD COLUMN catalog_json TEXT`);
      console.log('Migrated models: added catalog_json');
    }
    const nodeCols = db.prepare(`PRAGMA table_info(chat_nodes)`).all().map(c => c.name);
    if (!nodeCols.includes('catalog_json')) {
      db.exec(`ALTER TABLE chat_nodes ADD COLUMN thinking   TEXT`);
      console.log('Migrated models: added catalog_json');
    }
  } catch (e) {
    console.warn('models.catalog_json migration skipped', e.message);
  }

  console.log(`📦 SQLite initialized`);
}

/**
 * Creates a persistent database at the standard location
 */
function createPersistentDB(verbose = false) {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'chat.db');
  const db = new Database(dbPath, {
    verbose: verbose ? (sql) => console.log(`[SQL ${new Date().toISOString()}] ${sql}`) : null
  });

  initializeSchema(db);
  return db;
}

/**
 * Creates an in-memory database for unit testing
 */
function createInMemoryDB(verbose = false) {
  const db = new Database(':memory:', {
    verbose: verbose ? (sql) => console.log(`[SQL ${new Date().toISOString()}] ${sql}`) : null
  });

  initializeSchema(db);
  return db;
}

// Automatically create the appropriate database based on environment
const IS_TEST = process.env.NODE_ENV === 'test';
const db = IS_TEST ? createInMemoryDB() : createPersistentDB(true);

module.exports = db;

