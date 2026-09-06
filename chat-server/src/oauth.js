const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { assertUserExists } = require('./users');

const CONTENT_SCOPES = ['topics.read', 'topics.write'];
const PROVIDER_SCOPES = ['providers.read', 'providers.write'];

function parseJson(raw, fallback = null) {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw;
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseJsonArray(raw, fallback = []) {
  const parsed = Array.isArray(raw) ? raw : parseJson(raw, fallback);
  return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : fallback;
}

function normalizeScopes(input, allowed) {
  const requested = parseJsonArray(input, allowed);
  const allow = new Set(allowed);
  const scopes = [...new Set(requested.filter(s => allow.has(s)))];
  return scopes.length ? scopes : [...allowed];
}

function mapAuthorization(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.workspace_id || row.wallet_id || row.client_id,
    workspaceId: row.workspace_id || null,
    walletId: row.wallet_id || null,
    scopes: parseJsonArray(row.scopes),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listContentAuthorizations({ userId, clientId } = {}) {
  if (userId && clientId) {
    return db.prepare(
      'SELECT * FROM workspace_authorizations WHERE user_id = ? AND workspace_id = ?'
    ).all(userId, clientId).map(mapAuthorization);
  }
  if (userId) {
    return db.prepare(
      'SELECT * FROM workspace_authorizations WHERE user_id = ? ORDER BY created_at'
    ).all(userId).map(mapAuthorization);
  }
  if (clientId) {
    return db.prepare(
      'SELECT * FROM workspace_authorizations WHERE workspace_id = ? ORDER BY created_at'
    ).all(clientId).map(mapAuthorization);
  }
  return db.prepare(
    'SELECT * FROM workspace_authorizations ORDER BY created_at'
  ).all().map(mapAuthorization);
}

function listProviderAuthorizations({ userId, clientId } = {}) {
  if (userId && clientId) {
    return db.prepare(
      'SELECT * FROM wallet_authorizations WHERE user_id = ? AND wallet_id = ?'
    ).all(userId, clientId).map(mapAuthorization);
  }
  if (userId) {
    return db.prepare(
      'SELECT * FROM wallet_authorizations WHERE user_id = ? ORDER BY created_at'
    ).all(userId).map(mapAuthorization);
  }
  if (clientId) {
    return db.prepare(
      'SELECT * FROM wallet_authorizations WHERE wallet_id = ? ORDER BY created_at'
    ).all(clientId).map(mapAuthorization);
  }
  return db.prepare(
    'SELECT * FROM wallet_authorizations ORDER BY created_at'
  ).all().map(mapAuthorization);
}

function grantContentAuthorization({ userId, clientId, scopes, status = 'granted' }) {
  if (!assertUserExists(userId) || !userId) return { error: 'userId does not exist' };
  const client = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(clientId);
  if (!client) return { error: 'workspaceId does not exist' };

  const existing = db.prepare(
    'SELECT * FROM workspace_authorizations WHERE user_id = ? AND workspace_id = ?'
  ).get(userId, clientId);
  const nextScopes = JSON.stringify(normalizeScopes(scopes, CONTENT_SCOPES));
  const nextStatus = status === 'revoked' ? 'revoked' : 'granted';

  if (existing) {
    db.prepare(`
      UPDATE workspace_authorizations
      SET scopes = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextScopes, nextStatus, existing.id);
    return { authorization: mapAuthorization(db.prepare('SELECT * FROM workspace_authorizations WHERE id = ?').get(existing.id)) };
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workspace_authorizations (id, user_id, workspace_id, scopes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, clientId, nextScopes, nextStatus, now, now);
  return { authorization: mapAuthorization(db.prepare('SELECT * FROM workspace_authorizations WHERE id = ?').get(id)) };
}

function grantProviderAuthorization({ userId, clientId, scopes, status = 'granted' }) {
  if (!assertUserExists(userId) || !userId) return { error: 'userId does not exist' };
  const client = db.prepare('SELECT id FROM wallets WHERE id = ?').get(clientId);
  if (!client) return { error: 'walletId does not exist' };

  const existing = db.prepare(
    'SELECT * FROM wallet_authorizations WHERE user_id = ? AND wallet_id = ?'
  ).get(userId, clientId);
  const nextScopes = JSON.stringify(normalizeScopes(scopes, PROVIDER_SCOPES));
  const nextStatus = status === 'revoked' ? 'revoked' : 'granted';

  if (existing) {
    db.prepare(`
      UPDATE wallet_authorizations
      SET scopes = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextScopes, nextStatus, existing.id);
    return { authorization: mapAuthorization(db.prepare('SELECT * FROM wallet_authorizations WHERE id = ?').get(existing.id)) };
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO wallet_authorizations (id, user_id, wallet_id, scopes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, clientId, nextScopes, nextStatus, now, now);
  return { authorization: mapAuthorization(db.prepare('SELECT * FROM wallet_authorizations WHERE id = ?').get(id)) };
}

function revokeContentAuthorization(userId, clientId) {
  const result = db.prepare(
    'DELETE FROM workspace_authorizations WHERE user_id = ? AND workspace_id = ?'
  ).run(userId, clientId);
  return result.changes > 0;
}

function revokeProviderAuthorization(userId, clientId) {
  const result = db.prepare(
    'DELETE FROM wallet_authorizations WHERE user_id = ? AND wallet_id = ?'
  ).run(userId, clientId);
  return result.changes > 0;
}

const crypto = require('crypto');

const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function newRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function resolveAudienceAndClient(clientId) {
  if (!clientId) return null;
  if (db.prepare('SELECT id FROM workspaces WHERE id = ?').get(clientId)) {
    return { audience: 'content', clientId };
  }
  if (db.prepare('SELECT id FROM wallets WHERE id = ?').get(clientId)) {
    return { audience: 'provider', clientId };
  }
  return null;
}

function activeGrant(audience, userId, clientId) {
  if (audience === 'content') {
    return db.prepare(
      `SELECT * FROM workspace_authorizations WHERE user_id = ? AND workspace_id = ? AND status = 'granted'`
    ).get(userId, clientId);
  }
  return db.prepare(
    `SELECT * FROM wallet_authorizations WHERE user_id = ? AND wallet_id = ? AND status = 'granted'`
  ).get(userId, clientId);
}


function emptyClaims() {
  return { topics: [], provider: null };
}

function topicAccessFromScopes(scopes) {
  return (scopes || []).includes('topics.write') ? 'write' : 'read';
}

function providerAccessFromScopes(scopes) {
  return (scopes || []).includes('providers.write') ? 'manage' : 'run';
}

function neededTopicAccess(req, scope) {
  const s = scope || scopeFor(req, 'content');
  return s === 'topics.write' ? 'write' : 'read';
}

function neededProviderAccess(req, scope) {
  const s = scope || scopeFor(req, 'provider');
  if (s === 'providers.write') return 'manage';
  return 'run';
}

function claimAllowsTopic(claim, access) {
  if (!claim) return false;
  if (access === 'read') return claim.access === 'read' || claim.access === 'write';
  return claim.access === 'write';
}

function claimAllowsProvider(claim, access) {
  if (!claim) return false;
  if (access === 'run') return claim.access === 'run' || claim.access === 'manage';
  return claim.access === 'manage';
}

function normalizeContingent(input) {
  if (!input || typeof input !== 'object') return null;
  const maxCost = input.maxCost ?? input.max_cost ?? null;
  const maxTokens = input.maxTokens ?? input.max_tokens ?? null;
  const spentCost = Number(input.spentCost ?? input.spent_cost ?? 0) || 0;
  const spentTokens = Number(input.spentTokens ?? input.spent_tokens ?? 0) || 0;
  if (maxCost == null && maxTokens == null && !spentCost && !spentTokens) return null;
  return {
    maxCost: maxCost == null ? null : Number(maxCost),
    maxTokens: maxTokens == null ? null : Number(maxTokens),
    spentCost,
    spentTokens
  };
}

function normalizeTopicClaim(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const workspaceId = raw.workspaceId || raw.workspace_id || raw.workspaceId || raw.workspace_id || raw.clientId || raw.client_id || raw.id;
  if (!workspaceId) return null;
  let access = raw.access || raw.role;
  if (!access && Array.isArray(raw.scopes)) access = topicAccessFromScopes(raw.scopes);
  if (access === 'editor' || access === 'owner') access = 'write';
  if (access === 'reader' || access === 'viewer') access = 'read';
  if (access !== 'read' && access !== 'write') access = 'write';
  return { workspaceId, workspaceId: workspaceId, access };
}

function normalizeProviderClaim(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const walletId = raw.walletId || raw.wallet_id || raw.walletId || raw.wallet_id || raw.clientId || raw.client_id || raw.id;
  if (!walletId) return null;
  let access = raw.access || raw.role;
  if (!access && Array.isArray(raw.scopes)) access = providerAccessFromScopes(raw.scopes);
  if (access === 'write' || access === 'admin') access = 'manage';
  if (access === 'read' || access === 'use') access = 'run';
  if (access !== 'run' && access !== 'manage') access = 'run';
  return {
    walletId,
    walletId: walletId,
    access,
    contingent: normalizeContingent(raw.contingent)
  };
}

function claimsFromLegacyGrants(grants) {
  const claims = emptyClaims();
  for (const g of grants || []) {
    if (!g) continue;
    if (g.audience === 'content') {
      const claim = normalizeTopicClaim({ clientId: g.clientId, scopes: g.scopes, access: topicAccessFromScopes(g.scopes) });
      if (claim && !claims.topics.some(t => t.workspaceId === claim.workspaceId)) {
        claims.topics.push(claim);
      }
    } else if (g.audience === 'provider' && !claims.provider) {
      claims.provider = normalizeProviderClaim({ clientId: g.clientId, scopes: g.scopes, access: providerAccessFromScopes(g.scopes) });
    }
  }
  return claims;
}

function parseStoredClaims(raw) {
  const parsed = parseJson(raw, null);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.topics || parsed.provider)) {
    const topics = Array.isArray(parsed.topics) ? parsed.topics.map(normalizeTopicClaim).filter(Boolean) : [];
    const provider = parsed.provider ? normalizeProviderClaim(parsed.provider) : null;
    return { topics, provider };
  }
  if (Array.isArray(parsed)) {
    return claimsFromLegacyGrants(parsed.filter(g => g && typeof g === 'object'));
  }
  return emptyClaims();
}

function grantsFromClaims(claims) {
  const grants = (claims.topics || []).map(t => ({
    audience: 'content',
    clientId: t.workspaceId,
    scopes: t.access === 'write' ? ['topics.read', 'topics.write'] : ['topics.read']
  }));
  if (claims.provider) {
    grants.push({
      audience: 'provider',
      clientId: claims.provider.walletId,
      scopes: claims.provider.access === 'manage'
        ? ['providers.read', 'providers.write']
        : ['providers.read']
    });
  }
  return grants;
}

function liveClaims(userId, claims) {
  const topics = [];
  for (const t of claims.topics || []) {
    const grant = activeGrant('content', userId, t.workspaceId);
    if (!grant) continue;
    const allowed = topicAccessFromScopes(parseJsonArray(grant.scopes));
    const access = t.access === 'write' && allowed === 'write' ? 'write' : 'read';
    topics.push({ workspaceId: t.workspaceId, access });
  }
  let provider = null;
  if (claims.provider) {
    const grant = activeGrant('provider', userId, claims.provider.walletId);
    if (grant) {
      const allowed = providerAccessFromScopes(parseJsonArray(grant.scopes));
      const access = claims.provider.access === 'manage' && allowed === 'manage' ? 'manage' : 'run';
      provider = {
        walletId: claims.provider.walletId,
        access,
        contingent: claims.provider.contingent
      };
    }
  }
  return { topics, provider };
}

function collectClaims(userId, input) {
  const claims = emptyClaims();
  const topicInputs = input.topicClaims || input.topics || (input.claims && input.claims.topics) || [];
  for (const raw of topicInputs) {
    const claim = normalizeTopicClaim(raw);
    if (!claim) continue;
    if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get(claim.workspaceId)) {
      return { error: `content client ${claim.workspaceId} does not exist`, status: 400 };
    }
    const grant = activeGrant('content', userId, claim.workspaceId);
    if (!grant) return { error: `user is not authorized for content client ${claim.workspaceId}`, status: 403 };
    const allowed = topicAccessFromScopes(parseJsonArray(grant.scopes));
    if (claim.access === 'write' && allowed !== 'write') {
      return { error: `user cannot write topics for content client ${claim.workspaceId}`, status: 403 };
    }
    if (!claims.topics.some(t => t.workspaceId === claim.workspaceId)) {
      claims.topics.push(claim);
    }
  }

  const providerRaw = input.providerClaim || input.provider || (input.claims && input.claims.provider) || null;
  if (providerRaw) {
    const claim = normalizeProviderClaim(providerRaw);
    if (!claim) return { error: 'provider claim is invalid', status: 400 };
    if (!db.prepare('SELECT id FROM wallets WHERE id = ?').get(claim.walletId)) {
      return { error: `provider client ${claim.walletId} does not exist`, status: 400 };
    }
    const grant = activeGrant('provider', userId, claim.walletId);
    if (!grant) return { error: `user is not authorized for provider client ${claim.walletId}`, status: 403 };
    const allowed = providerAccessFromScopes(parseJsonArray(grant.scopes));
    if (claim.access === 'manage' && allowed !== 'manage') {
      return { error: `user cannot manage provider client ${claim.walletId}`, status: 403 };
    }
    claims.provider = claim;
  }

  if (!claims.topics.length && !claims.provider) {
    return { error: 'at least one topic claim or a provider claim is required', status: 400 };
  }
  return { claims };
}

function claimsFromLegacyIssue({ userId, clientId, extraClientIds = [] }) {
  const ids = [clientId, ...extraClientIds].filter(Boolean);
  const topicClaims = [];
  let providerClaim = null;
  for (const id of ids) {
    const resolved = resolveAudienceAndClient(id);
    if (!resolved) return { error: `client_id ${id} does not exist`, status: 400 };
    const grant = activeGrant(resolved.audience, userId, resolved.clientId);
    if (!grant) return { error: `user is not authorized for client ${id}`, status: 403 };
    if (resolved.audience === 'content') {
      topicClaims.push({
        workspaceId: resolved.clientId,
        access: topicAccessFromScopes(parseJsonArray(grant.scopes))
      });
    } else {
      if (providerClaim && providerClaim.walletId !== resolved.clientId) {
        return { error: 'a token may bind only one provider client', status: 400 };
      }
      providerClaim = {
        walletId: resolved.clientId,
        access: providerAccessFromScopes(parseJsonArray(grant.scopes)),
        contingent: null
      };
    }
  }
  return collectClaims(userId, { topicClaims, providerClaim });
}

function persistToken({ tokenType, userId, audience, clientId, scopes, claims, ttlSeconds }) {
  const raw = newRawToken();
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.prepare(`
    INSERT INTO oauth_tokens
      (id, token_hash, token_type, user_id, audience, client_id, scopes, grants_json, expires_at, revoked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    hashToken(raw),
    tokenType,
    userId,
    audience,
    clientId,
    JSON.stringify(scopes),
    JSON.stringify(claims || emptyClaims()),
    expiresAt
  );
  return { raw, id, expiresAt, expiresIn: ttlSeconds };
}

function mapTokenRow(row, extra = {}) {
  if (!row) return null;
  const claims = extra.claims || parseStoredClaims(row.grants_json);
  const grants = grantsFromClaims(claims);
  const primary = grants[0] || { audience: row.audience, clientId: row.client_id, scopes: parseJsonArray(row.scopes) };
  return {
    active: extra.active !== undefined ? extra.active : true,
    tokenId: row.id,
    tokenType: row.token_type,
    userId: row.user_id,
    clientId: primary.clientId || row.client_id,
    audience: primary.audience || row.audience,
    scopes: [...new Set(grants.flatMap(g => g.scopes))],
    claims,
    grants,
    expiresAt: row.expires_at,
    ...extra
  };
}

function readToken(raw) {
  if (!raw) return null;
  return db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hashToken(raw));
}

function isUsable(row) {
  if (!row || row.revoked) return false;
  return Date.parse(row.expires_at) > Date.now();
}

function validateAccessToken(raw) {
  const row = readToken(raw);
  if (!row || row.token_type !== 'access' || !isUsable(row)) {
    return { active: false };
  }
  const claims = liveClaims(row.user_id, parseStoredClaims(row.grants_json));
  if (!claims.topics.length && !claims.provider) return { active: false };
  return mapTokenRow(row, { active: true, claims });
}

function tokenResponse({ raw, userId, claims, refreshRaw }) {
  const grants = grantsFromClaims(claims);
  const primary = grants[0] || {};
  const body = {
    access_token: raw,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    scope: [...new Set(grants.flatMap(g => g.scopes))].join(' '),
    audience: primary.audience || null,
    client_id: primary.clientId || null,
    user_id: userId,
    claims,
    grants
  };
  if (refreshRaw) body.refresh_token = refreshRaw;
  return body;
}

function persistPair(userId, claims) {
  const grants = grantsFromClaims(claims);
  const primary = grants[0] || { audience: 'content', clientId: 'none', scopes: [] };
  const access = persistToken({
    tokenType: 'access',
    userId,
    audience: primary.audience,
    clientId: primary.clientId,
    scopes: primary.scopes,
    claims,
    ttlSeconds: ACCESS_TTL_SECONDS
  });
  const refresh = persistToken({
    tokenType: 'refresh',
    userId,
    audience: primary.audience,
    clientId: primary.clientId,
    scopes: primary.scopes,
    claims,
    ttlSeconds: REFRESH_TTL_SECONDS
  });
  return { access, refresh };
}

function hasClaimInput(input) {
  if (input.topicClaims || input.providerClaim || input.topics || input.provider) return true;
  const c = input.claims;
  if (!c || typeof c !== 'object') return false;
  return (Array.isArray(c.topics) && c.topics.length > 0) || !!c.provider;
}

function issueTokensForGrant(input) {
  const userId = input.userId;
  let collected;
  if (hasClaimInput(input)) {
    collected = collectClaims(userId, input);
  } else {
    collected = claimsFromLegacyIssue(input);
  }
  if (collected.error) return collected;
  const claims = collected.claims;
  const pair = persistPair(userId, claims);
  return {
    token: tokenResponse({
      raw: pair.access.raw,
      userId,
      claims,
      refreshRaw: pair.refresh.raw
    })
  };
}

function refreshAccessToken(refreshRaw) {
  const row = readToken(refreshRaw);
  if (!row || row.token_type !== 'refresh' || !isUsable(row)) {
    return { error: 'invalid refresh token', status: 401 };
  }
  const claims = liveClaims(row.user_id, parseStoredClaims(row.grants_json));
  if (!claims.topics.length && !claims.provider) {
    return { error: 'user is not authorized for this token', status: 403 };
  }
  const access = persistToken({
    tokenType: 'access',
    userId: row.user_id,
    audience: row.audience,
    clientId: row.client_id,
    scopes: parseJsonArray(row.scopes),
    claims,
    ttlSeconds: ACCESS_TTL_SECONDS
  });
  return {
    token: tokenResponse({
      raw: access.raw,
      userId: row.user_id,
      claims
    })
  };
}

function revokeToken(raw) {
  const row = readToken(raw);
  if (!row) return false;
  db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE id = ?').run(row.id);
  return true;
}

function extractBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function parseBearer(req, res, next) {
  const raw = extractBearer(req);
  if (!raw) return next();
  const info = validateAccessToken(raw);
  if (!info.active) {
    return res.status(401).json({ error: 'invalid or expired access token' });
  }
  req.auth = info;
  if (info.userId) {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(info.userId);
    req.auth.isAdmin = !!(user && user.is_admin);
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.auth && req.auth.active) return next();
  return res.status(401).json({ error: 'access token required' });
}

function authClaims(req) {
  if (!req.auth) return emptyClaims();
  if (req.auth.claims) return req.auth.claims;
  return claimsFromLegacyGrants(req.auth.grants || []);
}

function authClientIds(req, audience) {
  const claims = authClaims(req);
  if (audience === 'content') return (claims.topics || []).map(t => t.workspaceId);
  if (audience === 'provider') return claims.provider ? [claims.provider.walletId] : [];
  return [];
}

function primaryClientId(req, audience) {
  const ids = authClientIds(req, audience);
  return ids[0] || null;
}

function placeholders(ids) {
  return ids.map(() => '?').join(',');
}

function tokenAllows(req, audience, clientId, scope) {
  const claims = authClaims(req);
  if (audience === 'content') {
    const claim = (claims.topics || []).find(t => t.workspaceId === clientId);
    return claimAllowsTopic(claim, neededTopicAccess(req, scope));
  }
  if (audience === 'provider') {
    if (!claims.provider || claims.provider.walletId !== clientId) return false;
    return claimAllowsProvider(claims.provider, neededProviderAccess(req, scope));
  }
  return false;
}

function requireClientAuth(audience, clientId, scope) {
  return (req, res, next) => {
    if (!req.auth) return next();
    if (!tokenAllows(req, audience, clientId, scope)) {
      return res.status(403).json({ error: 'token is not valid for this client' });
    }
    next();
  };
}

function scopeFor(req, audience) {
  const write = audience === 'content' ? 'topics.write' : 'providers.write';
  const read = audience === 'content' ? 'topics.read' : 'providers.read';
  return ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? read : write;
}

function denyGrant(res, error, status = 403) {
  res.status(status).json({ error });
  return true;
}

function enforceGrant(req, res, { audience, clientId, scope }) {
  if (!req.auth) return false;
  const needed = scope || scopeFor(req, audience);
  if (!clientId || !tokenAllows(req, audience, clientId, needed)) {
    return denyGrant(res, 'token is not valid for this client');
  }
  return false;
}

function enforceAudience(req, res, audience) {
  if (!req.auth) return false;
  const claims = authClaims(req);
  if (audience === 'content') {
    const access = neededTopicAccess(req);
    const ok = (claims.topics || []).some(t => claimAllowsTopic(t, access));
    if (!ok) return denyGrant(res, 'token has no topic claim for this operation');
    return false;
  }
  if (audience === 'provider') {
    if (!claimAllowsProvider(claims.provider, neededProviderAccess(req))) {
      return denyGrant(res, 'token has no provider claim for this operation');
    }
    return false;
  }
  return denyGrant(res, 'token audience does not match this resource');
}

function contingentBlocked(contingent) {
  if (!contingent) return null;
  if (contingent.maxCost != null && contingent.spentCost >= contingent.maxCost) {
    return 'provider contingent maxCost exceeded';
  }
  if (contingent.maxTokens != null && contingent.spentTokens >= contingent.maxTokens) {
    return 'provider contingent maxTokens exceeded';
  }
  return null;
}

function enforceModelUse(req, res, { modelId, providerId }) {
  if (!req.auth) return false;
  if (!modelId && !providerId) return false;
  const walletId = modelId
    ? walletIdOfModel(modelId)
    : walletIdOfProvider(providerId);
  const claims = authClaims(req);
  if (!claimAllowsProvider(claims.provider, 'run') || claims.provider.walletId !== walletId) {
    return denyGrant(res, 'token is not valid for this provider');
  }
  const blocked = contingentBlocked(claims.provider.contingent);
  if (blocked) return denyGrant(res, blocked);
  return false;
}

function consumeContingent(req, { cost = 0, tokens = 0 } = {}) {
  if (!req.auth || !req.auth.tokenId) return;
  const claims = authClaims(req);
  if (!claims.provider || !claims.provider.contingent) return;
  claims.provider.contingent.spentCost += Number(cost) || 0;
  claims.provider.contingent.spentTokens += Number(tokens) || 0;
  db.prepare('UPDATE oauth_tokens SET grants_json = ? WHERE id = ?')
    .run(JSON.stringify(claims), req.auth.tokenId);
  req.auth.claims = claims;
}

function workspaceIdOfTopic(topicId) {
  if (!topicId) return null;
  const row = db.prepare('SELECT workspace_id FROM topics WHERE id = ?').get(topicId);
  return row ? row.workspace_id || null : null;
}

function workspaceIdOfProject(projectId) {
  if (!projectId) return null;
  const row = db.prepare(`
    SELECT t.workspace_id AS workspace_id
    FROM topic_projects tp
    JOIN topics t ON t.id = tp.topic_id
    WHERE tp.project_id = ?
    LIMIT 1
  `).get(projectId);
  return row ? row.workspace_id || null : null;
}

function workspaceIdOfChat(chatId) {
  if (!chatId) return null;
  const row = db.prepare(`
    SELECT t.workspace_id AS workspace_id
    FROM chats c
    JOIN topic_projects tp ON tp.project_id = c.project_id
    JOIN topics t ON t.id = tp.topic_id
    WHERE c.id = ?
    LIMIT 1
  `).get(chatId);
  return row ? row.workspace_id || null : null;
}

function walletIdOfProvider(providerId) {
  if (!providerId) return null;
  const row = db.prepare('SELECT wallet_id FROM providers WHERE id = ?').get(providerId);
  return row ? row.wallet_id || null : null;
}

function walletIdOfModel(modelId) {
  if (!modelId) return null;
  const row = db.prepare(`
    SELECT p.wallet_id AS wallet_id
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get(modelId);
  return row ? row.wallet_id || null : null;
}

module.exports = {
  CONTENT_SCOPES,
  PROVIDER_SCOPES,
  parseJsonArray,
  mapAuthorization,
  listContentAuthorizations,
  listProviderAuthorizations,
  grantContentAuthorization,
  grantProviderAuthorization,
  revokeContentAuthorization,
  revokeProviderAuthorization,
  resolveAudienceAndClient,
  validateAccessToken,
  issueTokensForGrant,
  refreshAccessToken,
  revokeToken,
  parseBearer,
  requireAuth,
  requireClientAuth,
  enforceGrant,
  enforceAudience,
  enforceModelUse,
  consumeContingent,
  authClientIds,
  primaryClientId,
  placeholders,
  tokenAllows,
  workspaceIdOfTopic,
  workspaceIdOfProject,
  workspaceIdOfChat,
  walletIdOfProvider,
  walletIdOfModel
};
