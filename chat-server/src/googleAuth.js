const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { hashPassword, findUserByLogin, findIdentity, linkIdentity, normalizeOptional } = require('./users');
const {
  grantContentAuthorization,
  grantProviderAuthorization,
  claimsFromUserAuthorizations,
  createAuthorizationCode
} = require('./oauth');

const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function env(name, fallback = null) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') return fallback;
  return String(value).trim();
}

function googleConfig() {
  const clientId = env('GOOGLE_CLIENT_ID') || env('CHAPTERLY_GOOGLE_CLIENT_ID');
  const clientSecret = env('GOOGLE_CLIENT_SECRET') || env('CHAPTERLY_GOOGLE_CLIENT_SECRET');
  const redirectUri = env('GOOGLE_REDIRECT_URI') || env('CHAPTERLY_GOOGLE_REDIRECT_URI')
    || 'http://localhost:3847/api/oauth/google/callback';
  const walletName = env('CHAPTERLY_GOOGLE_WALLET', 'google-shared');
  const workspaceName = env('CHAPTERLY_GOOGLE_WORKSPACE');
  const spaOrigin = env('CHAPTERLY_SPA_ORIGIN', 'http://localhost:4200');
  return { clientId, clientSecret, redirectUri, walletName, workspaceName, spaOrigin };
}

function isConfigured() {
  const cfg = googleConfig();
  return !!(cfg.clientId && cfg.clientSecret);
}

function gcPending() {
  const now = Date.now();
  for (const [key, row] of pending) {
    if (row.expiresAt <= now) pending.delete(key);
  }
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

function allowedReturnTo(returnTo, spaOrigin) {
  if (!returnTo) return `${spaOrigin}/#/login`;
  try {
    const dummy = returnTo.includes('://') ? returnTo : `${spaOrigin}${returnTo.startsWith('/') ? '' : '/'}${returnTo}`;
    const url = new URL(dummy);
    const allowed = new URL(spaOrigin);
    if (url.origin !== allowed.origin) return `${spaOrigin}/#/login`;
    return dummy;
  } catch {
    return `${spaOrigin}/#/login`;
  }
}

function appendHashParams(returnTo, params) {
  const hashIdx = returnTo.indexOf('#');
  const base = hashIdx >= 0 ? returnTo.slice(0, hashIdx) : returnTo;
  let hash = hashIdx >= 0 ? returnTo.slice(hashIdx + 1) : '/login';
  if (!hash.startsWith('/')) hash = '/' + hash;
  const u = new URL(hash, 'http://chapterly.local');
  for (const [key, value] of Object.entries(params)) {
    if (value != null) u.searchParams.set(key, String(value));
  }
  return `${base}#${u.pathname}${u.search}`;
}

function startLogin(returnTo) {
  if (!isConfigured()) return { error: 'Google login is not configured', status: 503 };
  const cfg = googleConfig();
  gcPending();
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  pending.set(state, {
    nonce,
    returnTo: allowedReturnTo(returnTo, cfg.spaOrigin),
    expiresAt: Date.now() + STATE_TTL_MS
  });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'select_account');
  return { url: url.toString() };
}

async function exchangeGoogleCode(code) {
  const cfg = googleConfig();
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.id_token) {
    return { error: json.error_description || json.error || 'Google token exchange failed', status: 401 };
  }
  return { tokens: json };
}

async function verifyIdToken(idToken, expectedNonce) {
  const cfg = googleConfig();
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const claims = await res.json().catch(() => ({}));
  if (!res.ok || claims.aud !== cfg.clientId) {
    return { error: 'invalid Google id_token', status: 401 };
  }
  if (expectedNonce && claims.nonce && claims.nonce !== expectedNonce) {
    return { error: 'invalid Google nonce', status: 401 };
  }
  if (claims.email_verified === 'false' || claims.email_verified === false) {
    return { error: 'Google email is not verified', status: 403 };
  }
  if (!claims.sub) return { error: 'Google token missing sub', status: 401 };
  return { claims };
}

function uniqueUsername(email, subject) {
  const local = normalizeOptional(email) ? String(email).split('@')[0] : null;
  const candidates = [];
  if (local) candidates.push(local);
  if (normalizeOptional(email)) candidates.push(email);
  candidates.push(`google-${String(subject).slice(0, 12)}`);
  for (const name of candidates) {
    const taken = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
    if (!taken) return name;
  }
  return `google-${subject}`;
}

async function upsertGoogleUser({ subject, email, name }) {
  const identity = findIdentity('google', subject);
  if (identity) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(identity.user_id);
    if (user) return user;
  }

  let user = null;
  if (email) user = findUserByLogin({ email });
  if (!user) {
    const id = uuidv4();
    const now = new Date().toISOString();
    const username = uniqueUsername(email, subject);
    const passwordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
    db.prepare(`
      INSERT INTO users (id, username, email, phone_number, password_hash, is_admin, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, 0, ?, ?)
    `).run(id, username, email || null, passwordHash, now, now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  } else if (email && !user.email) {
    db.prepare(`UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ?`).run(email, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  linkIdentity({ userId: user.id, provider: 'google', subject, email: email || null });
  return user;
}

function grantSharedWalletAndWorkspace(user) {
  const cfg = googleConfig();
  const wallet = upsertNamed('wallets', cfg.walletName);
  grantProviderAuthorization({
    userId: user.id,
    clientId: wallet.id,
    scopes: ['providers.read'],
    status: 'granted'
  });
  // A token may bind only one wallet. Google users share this vault.
  db.prepare(
    `DELETE FROM wallet_authorizations WHERE user_id = ? AND wallet_id != ?`
  ).run(user.id, wallet.id);

  let workspace = null;
  if (cfg.workspaceName) {
    workspace = upsertNamed('workspaces', cfg.workspaceName);
    grantContentAuthorization({
      userId: user.id,
      clientId: workspace.id,
      scopes: ['topics.read', 'topics.write'],
      status: 'granted'
    });
  } else {
    workspace = upsertNamed('workspaces', user.username);
    grantContentAuthorization({
      userId: user.id,
      clientId: workspace.id,
      scopes: ['topics.read', 'topics.write'],
      status: 'granted'
    });
  }
  return { wallet, workspace };
}

async function finishGoogleLogin({ code, state }) {
  if (!state) return { error: 'missing state', status: 400 };
  const pendingRow = pending.get(state);
  pending.delete(state);
  if (!pendingRow || pendingRow.expiresAt <= Date.now()) {
    return { error: 'invalid or expired state', status: 400 };
  }

  const exchanged = await exchangeGoogleCode(code);
  if (exchanged.error) return { ...exchanged, returnTo: pendingRow.returnTo };

  const verified = await verifyIdToken(exchanged.tokens.id_token, pendingRow.nonce);
  if (verified.error) return { ...verified, returnTo: pendingRow.returnTo };

  const g = verified.claims;
  const user = await upsertGoogleUser({
    subject: g.sub,
    email: g.email || null,
    name: g.name || null
  });
  grantSharedWalletAndWorkspace(user);

  const fromGrants = claimsFromUserAuthorizations(user.id);
  if (fromGrants.error) {
    return { error: fromGrants.error, status: fromGrants.status || 403, returnTo: pendingRow.returnTo };
  }
  const created = createAuthorizationCode({ userId: user.id, claims: fromGrants.claims });
  return {
    code: created.code,
    returnTo: pendingRow.returnTo,
    userId: user.id,
    claims: fromGrants.claims
  };
}

module.exports = {
  googleConfig,
  isConfigured,
  startLogin,
  finishGoogleLogin,
  appendHashParams
};
