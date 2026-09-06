const express = require('express');
const db = require('../db');
const {
  mapChatParameters,
  insertChatParameters,
  updateChatParameters,
  listOwners,
  findByOwner,
  getChatParameters,
  parameterKind,
  OWNER_TABLES
} = require('../chatParameters');
const {
  enforceGrant,
  enforceAudience,
  authClientIds,
  primaryClientId,
  placeholders
} = require('../oauth');

const router = express.Router();

function enforceParamsRow(req, res, row) {
  if (!req.auth) return false;
  if (row.wallet_id) {
    return enforceGrant(req, res, { audience: 'provider', clientId: row.wallet_id });
  }
  if (row.workspace_id) {
    return enforceGrant(req, res, { audience: 'content', clientId: row.workspace_id });
  }
  res.status(403).json({ error: 'token cannot access unscoped chat parameters' });
  return true;
}

/**
 * @openapi
 * /api/chat-parameters:
 *   get:
 *     summary: List chat parameter sets
 *     description: |
 *       Two kinds of parameter sets:
 *       - content: documentation attached to chats/nodes, owned by a workspace
 *       - run: generation settings attached to topics/projects/models, owned by a wallet
 *       Optional Bearer filters to claimed workspaces and the token wallet.
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: query
 *         name: ownerType
 *         schema:
 *           type: string
 *           enum: [model, topic, project, chat, chat_node]
 *       - in: query
 *         name: ownerId
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Parameter sets
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ChatParameters'
 *       400:
 *         description: Invalid ownerType
 */
router.get('/', (req, res) => {
  const { ownerType, ownerId } = req.query;

  if (ownerType || ownerId) {
    if (!ownerType || !ownerId) {
      return res.status(400).json({ error: 'ownerType and ownerId must be provided together' });
    }
    if (!OWNER_TABLES[ownerType]) {
      return res.status(400).json({
        error: 'ownerType must be one of model, topic, project, chat, chat_node'
      });
    }
    const row = findByOwner(ownerType, ownerId);
    if (row && enforceParamsRow(req, res, row)) return;
    return res.json(row ? [mapChatParameters(row)] : []);
  }

  let rows;
  if (req.auth) {
    const contentIds = authClientIds(req, 'content');
    const walletId = primaryClientId(req, 'provider');
    const clauses = [];
    const params = [];
    if (contentIds.length) {
      clauses.push(`workspace_id IN (${placeholders(contentIds)})`);
      params.push(...contentIds);
    }
    if (walletId) {
      clauses.push('wallet_id = ?');
      params.push(walletId);
    }
    if (!clauses.length) return res.json([]);
    rows = db.prepare(
      `SELECT * FROM chat_parameters WHERE ${clauses.join(' OR ')} ORDER BY updated_at DESC`
    ).all(...params);
  } else {
    rows = db.prepare(`SELECT * FROM chat_parameters ORDER BY updated_at DESC`).all();
  }
  res.json(rows.map(mapChatParameters));
});

/**
 * @openapi
 * /api/chat-parameters:
 *   post:
 *     summary: Create a chat parameter set
 *     tags:
 *       - ChatParameters
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatParametersInput'
 *     responses:
 *       201:
 *         description: Created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatParameters'
 */
router.post('/', (req, res) => {
  const body = req.body || {};
  if (req.auth) {
    if (!body.walletId && !body.wallet_id && !body.workspaceId && !body.workspace_id) {
      if (body.kind === 'run') body.walletId = primaryClientId(req, 'provider');
      else body.workspaceId = primaryClientId(req, 'content');
    }
  }
  let row;
  try {
    row = insertChatParameters(body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (enforceParamsRow(req, res, row)) {
    db.prepare('DELETE FROM chat_parameters WHERE id = ?').run(row.id);
    return;
  }
  res.status(201).json(mapChatParameters(row));
});

/**
 * @openapi
 * /api/chat-parameters/{id}:
 *   get:
 *     summary: Get a chat parameter set
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatParameters'
 *       404:
 *         description: Not found
 */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM chat_parameters WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat parameters not found' });
  if (enforceParamsRow(req, res, row)) return;
  res.json(mapChatParameters(row));
});

/**
 * @openapi
 * /api/chat-parameters/{id}/owners:
 *   get:
 *     summary: List entities that own this parameter set
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Owners referring this parameter set
 *       404:
 *         description: Not found
 */
router.get('/:id/owners', (req, res) => {
  const row = db.prepare('SELECT * FROM chat_parameters WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat parameters not found' });
  if (enforceParamsRow(req, res, row)) return;
  res.json(listOwners(req.params.id));
});

/**
 * @openapi
 * /api/chat-parameters/{id}:
 *   put:
 *     summary: Replace or update a chat parameter set
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatParametersInput'
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatParameters'
 *       404:
 *         description: Not found
 */
router.put('/:id', (req, res) => {
  const existing = getChatParameters(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Chat parameters not found' });
  if (enforceParamsRow(req, res, existing)) return;
  let row;
  try {
    row = updateChatParameters(req.params.id, req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (row && enforceParamsRow(req, res, row)) return;
  res.json(mapChatParameters(row));
});

/**
 * @openapi
 * /api/chat-parameters/{id}:
 *   patch:
 *     summary: Partially update a chat parameter set
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatParametersInput'
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatParameters'
 *       404:
 *         description: Not found
 */
router.patch('/:id', (req, res) => {
  const existing = getChatParameters(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Chat parameters not found' });
  if (enforceParamsRow(req, res, existing)) return;
  let row;
  try {
    row = updateChatParameters(req.params.id, req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (row && enforceParamsRow(req, res, row)) return;
  res.json(mapChatParameters(row));
});

/**
 * @openapi
 * /api/chat-parameters/{id}:
 *   delete:
 *     summary: Delete a chat parameter set
 *     description: |
 *       Owners (models, topics, projects, chats, chat_nodes) keep their rows.
 *       Their chatParametersId is set to null via ON DELETE SET NULL.
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete('/:id', (req, res) => {
  const existing = getChatParameters(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Chat parameters not found' });
  if (enforceParamsRow(req, res, existing)) return;
  const result = db.prepare('DELETE FROM chat_parameters WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Chat parameters not found' });
  }
  res.status(204).end();
});

module.exports = router;
