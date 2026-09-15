const fs = require('fs');
const { isConfigured } = require('./googleAuth');

const RUNTIMES = [
  'electron-sqlite',
  'electron-chat-server',
  'docker-prod',
  'docker-dev',
  'gcloud'
];

const STORAGE_PROFILES = [
  'sqlite-all',
  'chats-idb',
  'chats-params-idb',
  'content-idb',
  'theme-local'
];

function env(name, fallback = null) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') return fallback;
  return String(value).trim();
}

function inDocker() {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

function detectRuntime() {
  const forced = env('CHAPTERLY_RUNTIME');
  if (forced && RUNTIMES.includes(forced)) return forced;

  if (env('K_SERVICE') || env('CLOUD_RUN_JOB') || env('CHAPTERLY_GCLOUD') === '1') {
    return 'gcloud';
  }
  if (env('CHAPTERLY_ELECTRON') === '1' || env('ELECTRON_RUN_AS_NODE') || process.versions.electron) {
    return env('CHAPTERLY_PURE_SQLITE') === '1' ? 'electron-sqlite' : 'electron-chat-server';
  }
  if (inDocker() || env('CHAPTERLY_DOCKER') === '1') {
    return env('NODE_ENV') === 'production' ? 'docker-prod' : 'docker-dev';
  }
  return env('NODE_ENV') === 'production' ? 'docker-prod' : 'docker-dev';
}

function isLocalShell(runtime) {
  return runtime === 'electron-sqlite'
    || runtime === 'electron-chat-server'
    || runtime === 'docker-prod'
    || runtime === 'docker-dev';
}

function defaultStorageProfile(runtime) {
  switch (runtime) {
    case 'electron-sqlite':
      return 'sqlite-all';
    case 'electron-chat-server':
      return env('CHAPTERLY_STORAGE', 'sqlite-all');
    case 'docker-prod':
    case 'docker-dev':
      // Same two modes as Electron: all SQLite, or chats in IDB.
      return env('CHAPTERLY_STORAGE', 'sqlite-all');
    case 'gcloud':
      return env('CHAPTERLY_STORAGE', 'content-idb');
    default:
      return 'sqlite-all';
  }
}

function detectStorageProfile(runtime) {
  const forced = env('CHAPTERLY_STORAGE');
  if (forced && STORAGE_PROFILES.includes(forced)) return forced;
  const fallback = defaultStorageProfile(runtime);
  return STORAGE_PROFILES.includes(fallback) ? fallback : 'sqlite-all';
}

function storageSplit(profile) {
  if (profile === 'sqlite-all') {
    return {
      profile,
      sqlite: ['users', 'auth', 'chats', 'chat-parameters', 'projects', 'topics', 'personas', 'providers', 'models'],
      idb: []
    };
  }
  if (profile === 'chats-idb') {
    return {
      profile,
      sqlite: ['users', 'auth', 'chat-parameters', 'projects', 'topics', 'personas', 'providers', 'models'],
      idb: ['chats']
    };
  }
  if (profile === 'chats-params-idb') {
    return {
      profile,
      sqlite: ['users', 'auth', 'projects', 'topics', 'personas', 'providers', 'models'],
      idb: ['chats', 'chat-parameters']
    };
  }
  if (profile === 'theme-local') {
    return {
      profile,
      sqlite: ['users', 'auth', 'chats', 'chat-parameters', 'topics', 'providers', 'models'],
      idb: ['personas', 'projects']
    };
  }
  return {
    profile: 'content-idb',
    sqlite: ['users', 'auth', 'providers', 'models'],
    idb: ['chats', 'chat-parameters', 'projects', 'topics', 'personas']
  };
}

function skipLogin(runtime) {
  if (!isLocalShell(runtime)) return false;
  const forced = env('CHAPTERLY_REQUIRE_AUTH');
  if (forced === '1' || forced === 'true') return false;
  if (forced === '0' || forced === 'false') return true;
  return true;
}

function loginInfo(req, runtime) {
  const googleConfigured = isConfigured();
  if (skipLogin(runtime)) {
    return {
      login: 'none',
      username: null,
      userId: null,
      googleConfigured,
      required: false,
      skipLogin: true
    };
  }
  if (!req.auth || !req.auth.userId) {
    return {
      login: 'none',
      username: null,
      userId: null,
      googleConfigured,
      required: true,
      skipLogin: false
    };
  }
  const db = require('./db');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);
  const google = db.prepare(
    `SELECT id FROM user_identities WHERE user_id = ? AND provider = 'google' LIMIT 1`
  ).get(req.auth.userId);
  return {
    login: google ? 'google' : 'direct',
    username: user ? user.username : null,
    userId: req.auth.userId,
    googleConfigured,
    required: true,
    skipLogin: false
  };
}

function describeEnvironment(req) {
  const runtime = detectRuntime();
  const storage = storageSplit(detectStorageProfile(runtime));
  const localShell = isLocalShell(runtime);
  return {
    runtime,
    electron: runtime === 'electron-sqlite' || runtime === 'electron-chat-server',
    docker: runtime === 'docker-prod' || runtime === 'docker-dev',
    localShell,
    partlySqlite: storage.profile !== 'sqlite-all',
    storage,
    auth: loginInfo(req, runtime)
  };
}

module.exports = {
  RUNTIMES,
  STORAGE_PROFILES,
  detectRuntime,
  detectStorageProfile,
  storageSplit,
  describeEnvironment
};
