const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { hashPassword, findUserByLogin, normalizeOptional } = require('./users');
const {
  grantContentAuthorization,
  grantProviderAuthorization
} = require('./oauth');

function env(name, fallback = null) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') return fallback;
  return String(value).trim();
}

function upsertNamed(table, name) {
  const existing = db.prepare(`SELECT * FROM ${table} WHERE name = ?`).get(name);
  if (existing) return existing;
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ${table} (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(id, name, now, now);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

/**
 * Seeds CHAPTERLY_ADMIN_* from the environment.
 * Idempotent: existing username is reused; password is only reset when
 * CHAPTERLY_ADMIN_RESET=1.
 */
async function seedAdmin() {
  if (process.env.NODE_ENV === 'test' && env('CHAPTERLY_ADMIN_IN_TESTS') !== '1') {
    return null;
  }
  const username = env('CHAPTERLY_ADMIN_USERNAME');
  const password = env('CHAPTERLY_ADMIN_PASSWORD');
  if (!username || !password) return null;

  const email = env('CHAPTERLY_ADMIN_EMAIL');
  const phone = env('CHAPTERLY_ADMIN_PHONE');
  const reset = env('CHAPTERLY_ADMIN_RESET') === '1';
  const workspaceName = env('CHAPTERLY_ADMIN_WORKSPACE', 'default');
  const walletName = env('CHAPTERLY_ADMIN_WALLET', 'default');

  let user = findUserByLogin({ username, email, phoneNumber: phone });
  const now = new Date().toISOString();

  if (!user) {
    const id = uuidv4();
    const passwordHash = await hashPassword(password);
    db.prepare(`
      INSERT INTO users (id, username, email, phone_number, password_hash, is_admin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, username, email || null, phone || null, passwordHash, now, now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    console.log(`Seeded admin user '${username}'`);
  } else {
    db.prepare(`
      UPDATE users SET is_admin = 1, updated_at = datetime('now') WHERE id = ?
    `).run(user.id);
    if (reset) {
      const passwordHash = await hashPassword(password);
      db.prepare(`
        UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
      `).run(passwordHash, user.id);
      console.log(`Reset password for admin user '${username}'`);
    }
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  const workspace = upsertNamed('workspaces', workspaceName);
  const wallet = upsertNamed('wallets', walletName);

  grantContentAuthorization({
    userId: user.id,
    clientId: workspace.id,
    scopes: ['topics.read', 'topics.write'],
    status: 'granted'
  });
  grantProviderAuthorization({
    userId: user.id,
    clientId: wallet.id,
    scopes: ['providers.read', 'providers.write'],
    status: 'granted'
  });

  return { user, workspace, wallet };
}

module.exports = { seedAdmin };
