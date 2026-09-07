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
    CREATE TABLE IF NOT EXISTS users (
                                       id            TEXT PRIMARY KEY,
                                       username      TEXT NOT NULL UNIQUE,
                                       email         TEXT UNIQUE,
                                       phone_number  TEXT UNIQUE,
                                       password_hash TEXT NOT NULL,
                                       is_admin      INTEGER NOT NULL DEFAULT 0,
                                       created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
      );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
  `);

  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (userCols.length && !userCols.includes('is_admin')) {
    db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
    console.log('Migrated users: added is_admin');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      redirect_uris TEXT DEFAULT '[]',
      grant_types   TEXT DEFAULT '["authorization_code"]',
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      redirect_uris TEXT DEFAULT '[]',
      grant_types   TEXT DEFAULT '["authorization_code"]',
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_authorizations (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      scopes       TEXT NOT NULL DEFAULT '["topics.read","topics.write"]',
      status       TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now')),
      UNIQUE (user_id, workspace_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_auth_user ON workspace_authorizations(user_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_auth_workspace ON workspace_authorizations(workspace_id);

    CREATE TABLE IF NOT EXISTS wallet_authorizations (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      wallet_id  TEXT NOT NULL,
      scopes     TEXT NOT NULL DEFAULT '["providers.read","providers.write"]',
      status     TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (user_id, wallet_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_auth_user ON wallet_authorizations(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_auth_wallet ON wallet_authorizations(wallet_id);

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id          TEXT PRIMARY KEY,
      token_hash  TEXT NOT NULL UNIQUE,
      token_type  TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
      user_id     TEXT NOT NULL,
      audience    TEXT NOT NULL CHECK (audience IN ('content', 'provider')),
      client_id   TEXT NOT NULL,
      scopes      TEXT NOT NULL,
      grants_json TEXT NOT NULL DEFAULT '[]',
      expires_at  TEXT NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_hash ON oauth_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);

    CREATE TABLE IF NOT EXISTS oauth_codes (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      code_hash   TEXT NOT NULL UNIQUE,
      grants_json TEXT NOT NULL DEFAULT '[]',
      expires_at  TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_codes_user ON oauth_codes(user_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
                                           id TEXT PRIMARY KEY,
                                           name TEXT NOT NULL,
                                           type TEXT NOT NULL,
                                           base_url TEXT NOT NULL,
                                           api_key TEXT NOT NULL,
                                           enabled INTEGER DEFAULT 1,
                                           wallet_id TEXT,
                                           created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE SET NULL
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
                                          is_default INTEGER DEFAULT 0,
                                          created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
      );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS personas (
                                          id TEXT PRIMARY KEY,
                                          name TEXT NOT NULL,
                                          short_name TEXT NOT NULL,
                                          description TEXT DEFAULT '',
                                          avatar TEXT DEFAULT '',
                                          workspace_id TEXT,
                                          created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
      );
  `);

  db.exec(`

    CREATE TABLE IF NOT EXISTS chats (
                                       id TEXT PRIMARY KEY,
                                       title TEXT NOT NULL,
                                       project_id TEXT,
                                       created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      node_number INTEGER DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
      );

  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_nodes (
                                            id TEXT PRIMARY KEY,
                                            chat_id TEXT NOT NULL,
                                            parent_id TEXT,
                                            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      thinking TEXT,
      model_id TEXT,
      provider_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      previous_version_id TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_cost REAL,
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
                                        workspace_id     TEXT,
                                        default_project_id    TEXT,
                                        created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
      );


  `);



  db.exec(`

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_parameters (
      id                 TEXT PRIMARY KEY,
      name               TEXT DEFAULT '',
      temperature        REAL,
      top_k              INTEGER,
      top_m              REAL,
      stream             INTEGER,
      thinking           INTEGER,
      thinking_level     TEXT,
      workspace_id  TEXT,
      wallet_id TEXT,
      created_at         TEXT DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
      FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE SET NULL
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

    const providerColsForClient = db.prepare(`PRAGMA table_info(providers)`).all().map(c => c.name);
    if (!providerColsForClient.includes('wallet_id')) {
      db.exec(`ALTER TABLE providers ADD COLUMN wallet_id TEXT REFERENCES wallets(id) ON DELETE SET NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_providers_wallet_id ON providers(wallet_id)`);
      console.log('Migrated providers: added wallet_id');
    }

    const topicColsForClient = db.prepare(`PRAGMA table_info(topics)`).all().map(c => c.name);
    if (!topicColsForClient.includes('workspace_id')) {
      db.exec(`ALTER TABLE topics ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_topics_workspace_id ON topics(workspace_id)`);
      console.log('Migrated topics: added workspace_id');
    }

    const leftoverProviderUser = db.prepare(`PRAGMA table_info(providers)`).all().map(c => c.name);
    if (leftoverProviderUser.includes('user_id')) {
      db.exec(`DROP INDEX IF EXISTS idx_providers_user_id`);
      db.exec(`ALTER TABLE providers DROP COLUMN user_id`);
      console.log('Migrated providers: dropped user_id');
    }

    const leftoverTopicUser = db.prepare(`PRAGMA table_info(topics)`).all().map(c => c.name);
    if (leftoverTopicUser.includes('user_id')) {
      db.exec(`DROP INDEX IF EXISTS idx_topics_user_id`);
      db.exec(`ALTER TABLE topics DROP COLUMN user_id`);
      console.log('Migrated topics: dropped user_id');
    }

    const workspaceCols = db.prepare(`PRAGMA table_info(workspaces)`).all().map(c => c.name);
    if (workspaceCols.includes('user_id')) {
      db.exec(`DROP INDEX IF EXISTS idx_workspaces_user_id`);
      db.exec(`ALTER TABLE workspaces DROP COLUMN user_id`);
      console.log('Migrated workspaces: dropped user_id');
    }
    if (!workspaceCols.includes('redirect_uris')) {
      db.exec(`ALTER TABLE workspaces ADD COLUMN redirect_uris TEXT DEFAULT '[]'`);
    }
    if (!workspaceCols.includes('grant_types')) {
      db.exec(`ALTER TABLE workspaces ADD COLUMN grant_types TEXT DEFAULT '["authorization_code"]'`);
    }

    const walletCols = db.prepare(`PRAGMA table_info(wallets)`).all().map(c => c.name);
    if (walletCols.includes('user_id')) {
      db.exec(`DROP INDEX IF EXISTS idx_wallets_user_id`);
      db.exec(`ALTER TABLE wallets DROP COLUMN user_id`);
      console.log('Migrated wallets: dropped user_id');
    }
    if (!walletCols.includes('redirect_uris')) {
      db.exec(`ALTER TABLE wallets ADD COLUMN redirect_uris TEXT DEFAULT '[]'`);
    }
    if (!walletCols.includes('grant_types')) {
      db.exec(`ALTER TABLE wallets ADD COLUMN grant_types TEXT DEFAULT '["authorization_code"]'`);
    }

    const tokenCols = db.prepare(`PRAGMA table_info(oauth_tokens)`).all().map(c => c.name);
    if (tokenCols.length && !tokenCols.includes('grants_json')) {
      db.exec(`ALTER TABLE oauth_tokens ADD COLUMN grants_json TEXT NOT NULL DEFAULT '[]'`);
      console.log('Migrated oauth_tokens: added grants_json');
    }

    const personaCols = db.prepare(`PRAGMA table_info(personas)`).all().map(c => c.name);
    if (personaCols.length && !personaCols.includes('workspace_id')) {
      db.exec(`ALTER TABLE personas ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
      console.log('Migrated personas: added workspace_id');
    }

    const paramCols = db.prepare(`PRAGMA table_info(chat_parameters)`).all().map(c => c.name);
    if (paramCols.length && !paramCols.includes('workspace_id')) {
      db.exec(`ALTER TABLE chat_parameters ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
      console.log('Migrated chat_parameters: added workspace_id');
    }
    if (paramCols.length && !paramCols.includes('wallet_id')) {
      db.exec(`ALTER TABLE chat_parameters ADD COLUMN wallet_id TEXT REFERENCES wallets(id) ON DELETE SET NULL`);
      console.log('Migrated chat_parameters: added wallet_id');
    }

    const chatNodeCols = db.prepare(`PRAGMA table_info(chat_nodes)`).all().map(c => c.name);
    if (!chatNodeCols.includes('role')) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN;

        CREATE TABLE chat_nodes_new (
                                                      id TEXT PRIMARY KEY,
                                                      chat_id TEXT NOT NULL,
                                                      parent_id TEXT,
                                                      version INTEGER NOT NULL DEFAULT 1,
                                                      previous_version_id TEXT,
                                                      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                                                      content TEXT NOT NULL,
                                                      thinking TEXT,
                                                      attachments TEXT DEFAULT '[]',
                                                      is_current INTEGER NOT NULL DEFAULT 1,
                                                      provider_id TEXT,
                                                      model_id TEXT,
                                                      prompt_tokens INTEGER,
                                                      completion_tokens INTEGER,
                                                      total_cost REAL,
                                                      chat_parameters_id TEXT REFERENCES chat_parameters(id) ON DELETE SET NULL,
                                                      created_at TEXT NOT NULL DEFAULT (datetime('now')),
                                                      updated_at TEXT,
                                                      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
                                                      FOREIGN KEY (parent_id) REFERENCES chat_nodes_new(id) ON DELETE CASCADE,
                                                      FOREIGN KEY (previous_version_id) REFERENCES chat_nodes_new(id)
        );

        INSERT INTO chat_nodes_new (
            id, chat_id, parent_id, version, previous_version_id,
            role, content, thinking, attachments, is_current,
            provider_id, model_id,
            prompt_tokens, completion_tokens, total_cost,
            chat_parameters_id,
            created_at, updated_at
        )
        SELECT
            id,
            chat_id,
            parent_id,
            version,
            previous_version_id,
            CASE type
                WHEN 'question' THEN 'user'
                WHEN 'answer'   THEN 'assistant'
                WHEN 'system'   THEN 'system'
                ELSE 'assistant'
                END,
            COALESCE(content, ''),
            thinking,
            COALESCE(attachments, '[]'),
            is_current,
            provider_id,
            model_id,
            prompt_tokens,
            completion_tokens,
            0.0,
            chat_parameters_id,
            created_at,
            updated_at
        FROM chat_nodes;

        DROP TABLE chat_nodes;
        ALTER TABLE chat_nodes_new RENAME TO chat_nodes;

        CREATE INDEX IF NOT EXISTS idx_chat_nodes_chat_id ON chat_nodes(chat_id);
        CREATE INDEX IF NOT EXISTS idx_chat_nodes_parent_id ON chat_nodes(parent_id);

        COMMIT;
        PRAGMA foreign_keys = ON;
        PRAGMA foreign_key_check;
      `);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_topics_workspace_id ON topics(workspace_id);
             CREATE INDEX IF NOT EXISTS idx_providers_wallet_id ON providers(wallet_id);
     `);

    const projectCols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name);
    if (!projectCols.includes('is_default')) {
      db.exec(`ALTER TABLE projects ADD COLUMN is_default INTEGER DEFAULT 0`);
      console.log('Migrated projects: added is_default');
    }

    const topicColsForDefault = db.prepare(`PRAGMA table_info(topics)`).all().map(c => c.name);
    if (!topicColsForDefault.includes('default_project_id')) {
      db.exec(`ALTER TABLE topics ADD COLUMN default_project_id TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_topics_default_project_id ON topics(default_project_id)`);
      console.log('Migrated topics: added default_project_id');
    }

    const assignment = require('./assignment');
    assignment.setDb(db);
    assignment.backfillAssignmentInvariants();

  } catch (e) {
    console.warn('chat_nodes.role migration skipped', e.message);
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

  const dbFileName = (process.env.CHAPTERLY_DB_NAME || 'chapterly') + '.db';
  const dbPath = path.join(dataDir, dbFileName);
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
