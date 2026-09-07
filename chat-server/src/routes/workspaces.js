const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { mapContentClient, serializeJsonArray } = require('../clients');
const {
  listContentAuthorizations,
  grantContentAuthorization,
  revokeContentAuthorization,
  enforceGrant,
  enforceAudience,
  authClientIds,
  placeholders
} = require('../oauth');

const router = express.Router();

/**
 * @openapi
 * /api/workspaces:
 *   get:
 *     summary: List workspaces (tenants)
 *     description: |
 *       A workspace is a content tenant. It owns topics, projects, chats, personas
 *       and content-kind chat parameters. It is not an OAuth2 client and has no secret.
 *       Optional Bearer: only workspaces listed on the token topic claims (`read` or `write`).
 *     tags: [Workspaces]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Workspaces
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ContentClient'
 */
router.get('/', (req, res) => {
  if (enforceAudience(req, res, 'content')) return;
  const rows = req.auth
    ? db.prepare(`SELECT * FROM workspaces WHERE id IN (${placeholders(authClientIds(req, 'content'))})`).all(...authClientIds(req, 'content'))
    : db.prepare('SELECT * FROM workspaces ORDER BY created_at').all();
  res.json(rows.map(mapContentClient));
});

/**
 * @openapi
 * /api/workspaces:
 *   post:
 *     summary: Create a workspace
 *     description: |
 *       Allowed without a Bearer, or with an admin Bearer.
 *       A normal token already bound to workspaces cannot create another tenant.
 *     tags: [Workspaces]
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ContentClientInput'
 *     responses:
 *       201:
 *         description: Created tenant
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ContentClient'
 *       400:
 *         description: name is required
 *       403:
 *         description: Non-admin Bearer
 */
router.post('/', (req, res) => {
  if (req.auth && !req.auth.isAdmin) {
    return res.status(403).json({ error: 'token is scoped to an existing workspace' });
  }
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workspaces (id, name, redirect_uris, grant_types, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    serializeJsonArray(req.body.redirectUris ?? req.body.redirect_uris, []),
    serializeJsonArray(req.body.grantTypes ?? req.body.grant_types, ['authorization_code']),
    now,
    now
  );

  res.status(201).json(mapContentClient(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)));
});

/**
 * @openapi
 * /api/workspaces/{id}:
 *   get:
 *     summary: Get a workspace
 *     description: Optional Bearer requires a topic `read` claim on this tenant.
 *     tags: [Workspaces]
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
 *         description: Workspace
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ContentClient'
 *       404:
 *         description: Workspace not found
 */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Workspace not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: row.id })) return;
  res.json(mapContentClient(row));
});

/**
 * @openapi
 * /api/workspaces/{id}:
 *   put:
 *     summary: Update a workspace
 *     description: Optional Bearer requires a topic `write` claim on this tenant.
 *     tags: [Workspaces]
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
 *             $ref: '#/components/schemas/ContentClientInput'
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ContentClient'
 *       400:
 *         description: name is required
 *       404:
 *         description: Workspace not found
 */
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Workspace not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: existing.id })) return;

  const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const redirectUris = req.body.redirectUris !== undefined || req.body.redirect_uris !== undefined
    ? serializeJsonArray(req.body.redirectUris ?? req.body.redirect_uris, [])
    : existing.redirect_uris;
  const grantTypes = req.body.grantTypes !== undefined || req.body.grant_types !== undefined
    ? serializeJsonArray(req.body.grantTypes ?? req.body.grant_types, ['authorization_code'])
    : existing.grant_types;

  db.prepare(`
    UPDATE workspaces
    SET name = ?, redirect_uris = ?, grant_types = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, redirectUris, grantTypes, existing.id);

  res.json(mapContentClient(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(existing.id)));
});

/**
 * @openapi
 * /api/workspaces/{id}:
 *   delete:
 *     summary: Delete a workspace
 *     description: Optional Bearer requires a topic `write` claim. Topics in the tenant are set to no workspace (FK SET NULL).
 *     tags: [Workspaces]
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
 *         description: Workspace not found
 */
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Workspace not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: existing.id })) return;
  const result = db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Workspace not found' });
  res.status(204).end();
});

/**
 * @openapi
 * /api/workspaces/{id}/authorizations:
 *   get:
 *     summary: List grant ceilings on this workspace
 *     description: |
 *       These rows cap what a later access token may claim (`topics.read` / `topics.write`).
 *       They are not tokens. Optional Bearer requires topic `read` on this tenant.
 *     tags: [Workspaces]
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
 *       404:
 *         description: Workspace not found
 */
router.get('/:id/authorizations', (req, res) => {
  const client = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Workspace not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: req.params.id })) return;
  res.json(listContentAuthorizations({ clientId: req.params.id }));
});

/**
 * @openapi
 * /api/workspaces/{id}/authorizations:
 *   post:
 *     summary: Grant a user access to this workspace
 *     description: |
 *       Creates or updates a workspace authorization. scopes are `topics.read` and/or `topics.write`.
 *       Optional Bearer requires topic `write` on this tenant.
 *     tags: [Workspaces]
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
 *                 items: { type: string, enum: [topics.read, topics.write] }
 *               status: { type: string, enum: [granted, revoked] }
 *     responses:
 *       201:
 *         description: Grant stored
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ClientAuthorization'
 *       400:
 *         description: Unknown user or workspace
 */
router.post('/:id/authorizations', (req, res) => {
  if (enforceGrant(req, res, { audience: 'content', clientId: req.params.id })) return;
  const userId = req.body.userId ?? req.body.user_id;
  const result = grantContentAuthorization({
    userId,
    clientId: req.params.id,
    scopes: req.body.scopes,
    status: req.body.status
  });
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  res.status(201).json(result.authorization);
});

/**
 * @openapi
 * /api/workspaces/{id}/authorizations/{userId}:
 *   delete:
 *     summary: Revoke a user's workspace grant
 *     description: Optional Bearer requires topic `write` on this tenant.
 *     tags: [Workspaces]
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
 *         description: Workspace or authorization not found
 */
router.delete('/:id/authorizations/:userId', (req, res) => {
  const client = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Workspace not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: req.params.id })) return;
  if (!revokeContentAuthorization(req.params.userId, req.params.id)) {
    return res.status(404).json({ error: 'Authorization not found' });
  }
  res.status(204).end();
});

/**
 * @openapi
 * /api/workspaces/{id}/topics:
 *   get:
 *     summary: List topics in this workspace
 *     description: Optional Bearer requires topic `read` on this tenant.
 *     tags: [Workspaces]
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
 *         description: Topics owned by the tenant
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Topic'
 *       404:
 *         description: Workspace not found
 */
router.get('/:id/topics', (req, res) => {
  const client = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Workspace not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: req.params.id })) return;

  const rows = db.prepare(
    'SELECT * FROM topics WHERE workspace_id = ? ORDER BY name'
  ).all(req.params.id);

  const projectStmt = db.prepare('SELECT project_id FROM topic_projects WHERE topic_id = ?');
  res.json(rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description || '',
    defaultModelId: row.default_model_id || null,
    chatParametersId: row.chat_parameters_id || null,
    defaultSystemPrompt: row.default_system_prompt || '',
    icon: row.icon || '',
    projectIds: projectStmt.all(row.id).map(r => r.project_id),
    contentClientId: row.workspace_id || null,
    defaultProjectId: row.default_project_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })));
});

module.exports = router;
