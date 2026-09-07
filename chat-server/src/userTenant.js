const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { parseJsonArray, issueTokensForGrant } = require('./oauth');

/**
 * Returns the client row, creating it when no client with that name exists.
 */
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
 * Grants the requested scopes to the user on a client, but never downgrades a
 * ceiling the user already has there. Creates the authorization row on first use.
 */
function upgradeGrant(grant) {
  const existing = db.prepare(
    `SELECT * FROM ${grant.table} WHERE user_id = ? AND ${grant.clientColumn} = ?`
  ).get(grant.userId, grant.clientId);
  const existingScopes = existing ? parseJsonArray(existing.scopes) : [];
  const wanted = new Set(grant.scopes);
  const nextScopes = [...new Set([...existingScopes, ...grant.scopes].filter(s => wanted.has(s)))];
  const jsonScopes = JSON.stringify(nextScopes);
  const now = new Date().toISOString();

  if (existing) {
    db.prepare(`
      UPDATE ${grant.table}
      SET scopes = ?, status = 'granted', updated_at = ?
      WHERE id = ?
    `).run(jsonScopes, now, existing.id);
    return;
  }

  db.prepare(`
    INSERT INTO ${grant.table}
      (id, user_id, ${grant.clientColumn}, scopes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'granted', ?, ?)
  `).run(uuidv4(), grant.userId, grant.clientId, jsonScopes, now, now);
}

/**
 * Sets up a workspace, a wallet and a full write access token for a brand-new
 * local user. Used by POST /api/users so a fresh identity can immediately
 * create topics/limits and manage its own provider keys.
 *
 * A workspace and a wallet named after the username are created up front and
 * granted to the identity (`topics.write` / `providers.manage`), and an opaque
 * access token (with refresh) is minted so the client can start working right
 * away.
 *
 * Idempotent: existing clients named after the user are reused, grants are
 * merged (never downgraded) and existing access/refresh tokens are regenerated.
 */
function createUserWorkspaceWalletAndToken({ user }) {
  const workspace = upsertNamed('workspaces', user.username);
  const wallet = upsertNamed('wallets', user.username);

  upgradeGrant({
    table: 'workspace_authorizations',
    clientColumn: 'workspace_id',
    userId: user.id,
    clientId: workspace.id,
    scopes: ['topics.read', 'topics.write']
  });

  upgradeGrant({
    table: 'wallet_authorizations',
    clientColumn: 'wallet_id',
    userId: user.id,
    clientId: wallet.id,
    scopes: ['providers.read', 'providers.write']
  });

  // Drop any prior complete token pair for this identity to avoid the UNIQUE
  // (user_id, token_type, audience, client_id) constraint on insert.
  db.prepare(`
    DELETE FROM oauth_tokens
    WHERE user_id = ? AND token_type IN ('access', 'refresh')
  `).run(user.id);

  const pair = issueTokensForGrant({
    userId: user.id,
    claims: {
      topics: [{ workspaceId: workspace.id, access: 'write' }],
      provider: { walletId: wallet.id, access: 'manage' }
    }
  });

  return {
    workspace,
    wallet,
    token: {
      accessToken: pair.token.access_token,
      refreshToken: pair.token.refresh_token,
      tokenType: pair.token.token_type,
      expiresIn: pair.token.expires_in,
      audience: pair.token.audience,
      clientId: pair.token.client_id,
      claims: pair.token.claims,
      grants: pair.token.grants
    }
  };
}

module.exports = { createUserWorkspaceWalletAndToken };
