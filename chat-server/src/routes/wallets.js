const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { mapProviderClient, serializeJsonArray } = require('../clients');
const {
  listProviderAuthorizations,
  grantProviderAuthorization,
  revokeProviderAuthorization,
  enforceGrant,
  enforceAudience,
  authClientIds,
  placeholders
} = require('../oauth');

const router = express.Router();

/**
 * @openapi
 * /api/wallets:
 *   get:
 *     summary: List wallets
 *     description: |
 *       A wallet is a credential vault. It owns providers, API keys, models and
 *       run-kind chat parameters. It is not an OAuth2 client and has no secret.
 *       Optional Bearer: only the single wallet named on the token (`run` or `manage`).
 *     tags: [Wallets]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Wallets
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Wallet'
 *   post:
 *     summary: Create a wallet
 *     description: |
 *       Allowed without a Bearer, or with an admin Bearer.
 *       A normal token already bound to a wallet cannot create another vault.
 *       Users later choose either their own wallet or a platform economy wallet; one token names one wallet.
 *     tags: [Wallets]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WalletInput'
 *     responses:
 *       201:
 *         description: Created wallet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Wallet'
 *       403:
 *         description: Non-admin Bearer
 *
 * /api/wallets/{id}:
 *   get:
 *     summary: Get a wallet
 *     description: Optional Bearer requires a `run` or `manage` claim on this wallet.
 *     tags: [Wallets]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Wallet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Wallet'
 *       404:
 *         description: Wallet not found
 *   put:
 *     summary: Update a wallet
 *     description: Optional Bearer requires `manage` on this wallet.
 *     tags: [Wallets]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WalletInput'
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Wallet'
 *       404:
 *         description: Wallet not found
 *   delete:
 *     summary: Delete a wallet
 *     description: Optional Bearer requires `manage`. Provider rows may remain until deleted separately.
 *     tags: [Wallets]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Wallet not found
 *
 * /api/wallets/{id}/authorizations:
 *   get:
 *     summary: List grant ceilings on this wallet
 *     description: |
 *       These rows cap later token claims. `providers.read` → token `run`,
 *       `providers.write` → token `manage`. A token still binds only one wallet.
 *     tags: [Wallets]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Authorizations
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ClientAuthorization'
 *   post:
 *     summary: Grant a user access to this wallet
 *     description: |
 *       Optional Bearer requires `manage` on this wallet.
 *       Platform/economy wallets should grant `providers.read` only so users cannot rotate keys.
 *     tags: [Wallets]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId: { type: string, format: uuid }
 *               scopes:
 *                 type: array
 *                 items: { type: string, enum: [providers.read, providers.write] }
 *               status: { type: string, enum: [granted, revoked] }
 *     responses:
 *       201:
 *         description: Grant stored
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ClientAuthorization'
 *
 * /api/wallets/{id}/authorizations/{userId}:
 *   delete:
 *     summary: Revoke a user's wallet grant
 *     description: Optional Bearer requires `manage` on this wallet.
 *     tags: [Wallets]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Revoked
 *       404:
 *         description: Wallet or authorization not found
 *
 * /api/wallets/{id}/providers:
 *   get:
 *     summary: List providers in this wallet
 *     description: |
 *       Optional Bearer requires `run` or `manage` on this wallet.
 *       A `run` token currently still receives apiKey on each row.
 *     tags: [Wallets]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Providers owned by the wallet
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Provider'
 *       404:
 *         description: Wallet not found
 */

router.get('/', (req, res) => {
  if (enforceAudience(req, res, 'provider')) return;
  const rows = req.auth
    ? db.prepare(`SELECT * FROM wallets WHERE id IN (${placeholders(authClientIds(req, 'provider'))})`).all(...authClientIds(req, 'provider'))
    : db.prepare('SELECT * FROM wallets ORDER BY created_at').all();
  res.json(rows.map(mapProviderClient));
});

router.post('/', (req, res) => {
  if (req.auth && !req.auth.isAdmin) {
    return res.status(403).json({ error: 'token is scoped to an existing wallet' });
  }
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO wallets (id, name, redirect_uris, grant_types, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    serializeJsonArray(req.body.redirectUris ?? req.body.redirect_uris, []),
    serializeJsonArray(req.body.grantTypes ?? req.body.grant_types, ['authorization_code']),
    now,
    now
  );

  res.status(201).json(mapProviderClient(db.prepare('SELECT * FROM wallets WHERE id = ?').get(id)));
});

router.get('/:id/authorizations', (req, res) => {
  const client = db.prepare('SELECT id FROM wallets WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Wallet not found' });
  if (enforceGrant(req, res, { audience: 'provider', clientId: req.params.id })) return;
  res.json(listProviderAuthorizations({ clientId: req.params.id }));
});

router.post('/:id/authorizations', (req, res) => {
  if (enforceGrant(req, res, { audience: 'provider', clientId: req.params.id })) return;
  const userId = req.body.userId ?? req.body.user_id;
  const result = grantProviderAuthorization({
    userId,
    clientId: req.params.id,
    scopes: req.body.scopes,
    status: req.body.status
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result.authorization);
});

router.delete('/:id/authorizations/:userId', (req, res) => {
  const client = db.prepare('SELECT id FROM wallets WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Wallet not found' });
  if (enforceGrant(req, res, { audience: 'provider', clientId: req.params.id })) return;
  if (!revokeProviderAuthorization(req.params.userId, req.params.id)) {
    return res.status(404).json({ error: 'Authorization not found' });
  }
  res.status(204).end();
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Wallet not found' });
  if (enforceGrant(req, res, { audience: 'provider', clientId: row.id })) return;
  res.json(mapProviderClient(row));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Wallet not found' });
  if (enforceGrant(req, res, { audience: 'provider', clientId: existing.id })) return;

  const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const redirectUris = req.body.redirectUris !== undefined || req.body.redirect_uris !== undefined
    ? serializeJsonArray(req.body.redirectUris ?? req.body.redirect_uris, [])
    : existing.redirect_uris;
  const grantTypes = req.body.grantTypes !== undefined || req.body.grant_types !== undefined
    ? serializeJsonArray(req.body.grantTypes ?? req.body.grant_types, ['authorization_code'])
    : existing.grant_types;

  db.prepare(`
    UPDATE wallets
    SET name = ?, redirect_uris = ?, grant_types = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, redirectUris, grantTypes, existing.id);

  res.json(mapProviderClient(db.prepare('SELECT * FROM wallets WHERE id = ?').get(existing.id)));
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM wallets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Wallet not found' });
  if (enforceGrant(req, res, { audience: 'provider', clientId: existing.id })) return;
  const result = db.prepare('DELETE FROM wallets WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Wallet not found' });
  res.status(204).end();
});

router.get('/:id/providers', (req, res) => {
  const client = db.prepare('SELECT id FROM wallets WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Wallet not found' });
  if (enforceGrant(req, res, { audience: 'provider', clientId: req.params.id })) return;

  const rows = db.prepare(
    'SELECT * FROM providers WHERE wallet_id = ? ORDER BY created_at'
  ).all(req.params.id);

  res.json(rows.map(row => ({
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    enabled: !!row.enabled,
    providerClientId: row.wallet_id || null
  })));
});

module.exports = router;
