const db = require('./db');
const { parseJsonArray } = require('./oauth');

function mapContentClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    redirectUris: parseJsonArray(row.redirect_uris),
    grantTypes: parseJsonArray(row.grant_types, ['authorization_code']),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProviderClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    redirectUris: parseJsonArray(row.redirect_uris),
    grantTypes: parseJsonArray(row.grant_types, ['authorization_code']),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function assertContentClientExists(id) {
  if (id === undefined || id === null || id === '') return true;
  return !!db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id);
}

function assertProviderClientExists(id) {
  if (id === undefined || id === null || id === '') return true;
  return !!db.prepare('SELECT id FROM wallets WHERE id = ?').get(id);
}

function pickId(body, camel, snake) {
  if (body[camel] === undefined && body[snake] === undefined) return undefined;
  const raw = body[camel] !== undefined ? body[camel] : body[snake];
  if (raw === null || raw === '') return null;
  return raw;
}

function resolveContentClientId(body, fallback = null) {
  const explicit = pickId(body, 'workspaceId', 'workspace_id');
  if (explicit !== undefined) return explicit;
  const legacy = pickId(body, 'workspaceId', 'content_client_id');
  if (legacy !== undefined) return legacy;
  return fallback === undefined ? null : fallback;
}

function resolveProviderClientId(body, fallback = null) {
  const explicit = pickId(body, 'walletId', 'wallet_id');
  if (explicit !== undefined) return explicit;
  const legacy = pickId(body, 'walletId', 'provider_client_id');
  if (legacy !== undefined) return legacy;
  return fallback === undefined ? null : fallback;
}

function validateContentClientId(id) {
  if (!id) return { ok: true, id: null };
  if (!assertContentClientExists(id)) return { ok: false, error: 'workspaceId does not exist' };
  return { ok: true, id };
}

function validateProviderClientId(id) {
  if (!id) return { ok: true, id: null };
  if (!assertProviderClientExists(id)) return { ok: false, error: 'walletId does not exist' };
  return { ok: true, id };
}

function serializeJsonArray(value, fallback = []) {
  if (value === undefined) return JSON.stringify(fallback);
  return JSON.stringify(parseJsonArray(value, fallback));
}

module.exports = {
  mapContentClient,
  mapProviderClient,
  assertContentClientExists,
  assertProviderClientExists,
  resolveContentClientId,
  resolveProviderClientId,
  validateContentClientId,
  validateProviderClientId,
  serializeJsonArray
};
