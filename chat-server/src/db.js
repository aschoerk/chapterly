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
      node_number INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS chat_parameters (
      id              TEXT PRIMARY KEY,
      name            TEXT DEFAULT '',
      temperature     REAL,
      top_k           INTEGER,
      top_m           REAL,
      stream          INTEGER,
      thinking        INTEGER,
      thinking_level  TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_parameters_updated
      ON chat_parameters(updated_at);
  `);

  // Migration example
  try {
    const modelCols = db.prepare(`PRAGMA table_info(models)`).all().map(c => c.name);
    if (!modelCols.includes('catalog_json')) {
      db.exec(`ALTER TABLE models ADD COLUMN catalog_json TEXT`);
      console.log('Migrated models: added catalog_json');
    }
    const nodeCols = db.prepare(`PRAGMA table_info(chat_nodes)`).all().map(c => c.name);
    if (!nodeCols.includes('thinking')) {
      db.exec(`ALTER TABLE chat_nodes ADD COLUMN thinking   TEXT`);
      console.log('Migrated models: added thinking');
    }
    const chatCols = db.prepare(`PRAGMA table_info(chats)`).all().map(c => c.name);
    if (!chatCols.includes('node_number')) {
      db.exec(`ALTER TABLE chats ADD COLUMN node_number  INTEGER DEFAULT 1`);
      console.log('Migrated models: added node_number');
      db.exec(`UPDATE chats
               SET node_number = COALESCE(node_counts.cnt, 0)
               FROM (
                      SELECT chat_id, COUNT(*) AS cnt
                      FROM chat_nodes
                      GROUP BY chat_id
                    ) AS node_counts
               WHERE chats.id = node_counts.chat_id `)
    }

    const paramOwnerTables = ['models', 'topics', 'projects', 'chats', 'chat_nodes'];
    for (const table of paramOwnerTables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes('chat_parameters_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN chat_parameters_id TEXT REFERENCES chat_parameters(id) ON DELETE SET NULL`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_chat_parameters_id ON ${table}(chat_parameters_id)`);
        console.log(`Migrated ${table}: added chat_parameters_id`);
      }
    }
  } catch (e) {
    console.warn('chats.node_number migration skipped', e.message);
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
