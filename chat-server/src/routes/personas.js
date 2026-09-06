const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const {
  resolveContentClientId,
  validateContentClientId
} = require('../clients');
const {
  enforceGrant,
  enforceAudience,
  authClientIds,
  placeholders,
  primaryClientId
} = require('../oauth');

const router = express.Router();

// ---------- Personas ----------

/**
 * @openapi
 * /api/personas:
 *   get:
 *     summary: List personas
 *     description: |
 *       Content objects owned by a workspace. Optional Bearer: only personas of claimed workspaces.
 *     tags:
 *       - Personas
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of personas ordered by name
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Persona'
 */
router.get('/', (req, res) => {
  if (enforceAudience(req, res, 'content')) return;
  let rows;
  if (req.auth) {
    const ids = authClientIds(req, 'content');
    rows = db.prepare(
      `SELECT * FROM personas WHERE workspace_id IN (${placeholders(ids)}) ORDER BY name COLLATE NOCASE`
    ).all(...ids);
  } else {
    rows = db.prepare(`SELECT * FROM personas ORDER BY name COLLATE NOCASE`).all();
  }
  res.json(rows.map(mapPersona));
});

/**
 * @openapi
 * /api/personas:
 *   post:
 *     summary: Create a new persona
 *     description: Optional Bearer requires a write topic claim on the target workspace.
 *     tags:
 *       - Personas
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, shortName]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Full display name of the persona
 *               shortName:
 *                 type: string
 *                 description: Short / handle name
 *               description:
 *                 type: string
 *                 description: Textual description / system prompt style text
 *               avatar:
 *                 type: string
 *                 description: Avatar URL or data URL
 *     responses:
 *       201:
 *         description: Persona created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Persona'
 *       400:
 *         description: Validation error
 */
router.post('/', (req, res) => {
  const { name, shortName, description = '', avatar = '' } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!shortName || !shortName.trim()) {
    return res.status(400).json({ error: 'shortName is required' });
  }

  const workspaceId = resolveContentClientId(req.body, req.auth ? primaryClientId(req, 'content') : null);
  const workspace = validateContentClientId(workspaceId);
  if (!workspace.ok) return res.status(400).json({ error: workspace.error });
  if (enforceGrant(req, res, { audience: 'content', clientId: workspace.id })) return;

  const id = uuidv4();
  db.prepare(`
    INSERT INTO personas (id, name, short_name, description, avatar, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name.trim(),
    shortName.trim(),
    description || '',
    avatar || '',
    workspace.id
  );

  const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
  res.status(201).json(mapPersona(row));
});

/**
 * @openapi
 * /api/personas/{id}:
 *   get:
 *     summary: Get a single persona
 *     tags:
 *       - Personas
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Persona found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Persona'
 *       404:
 *         description: Persona not found
 */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Persona not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: row.workspace_id })) return;
  res.json(mapPersona(row));
});

/**
 * @openapi
 * /api/personas/{id}:
 *   put:
 *     summary: Update a persona
 *     tags:
 *       - Personas
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
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               shortName:
 *                 type: string
 *               description:
 *                 type: string
 *               avatar:
 *                 type: string
 *     responses:
 *       200:
 *         description: Persona updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Persona'
 *       404:
 *         description: Persona not found
 */
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, shortName, description, avatar } = req.body;

  const existing = db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Persona not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: existing.workspace_id })) return;

  const nextClientId = resolveContentClientId(req.body, existing.workspace_id);
  const workspace = validateContentClientId(nextClientId);
  if (!workspace.ok) return res.status(400).json({ error: workspace.error });
  if (workspace.id !== existing.workspace_id) {
    if (enforceGrant(req, res, { audience: 'content', clientId: workspace.id })) return;
  }

  db.prepare(`
    UPDATE personas
    SET name = COALESCE(?, name),
        short_name = COALESCE(?, short_name),
        description = COALESCE(?, description),
        avatar = COALESCE(?, avatar),
        workspace_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : null,
    shortName !== undefined ? shortName.trim() : null,
    description !== undefined ? description : null,
    avatar !== undefined ? avatar : null,
    workspace.id,
    id
  );

  const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
  res.json(mapPersona(row));
});

/**
 * @openapi
 * /api/personas/{id}:
 *   delete:
 *     summary: Delete a persona
 *     tags:
 *       - Personas
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Persona deleted
 *       404:
 *         description: Persona not found
 */
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM personas WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Persona not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: existing.workspace_id })) return;
  const result = db.prepare('DELETE FROM personas WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Persona not found' });
  }
  res.status(204).end();
});

function mapPersona(row) {
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    description: row.description || '',
    avatar: row.avatar || '',
    workspaceId: row.workspace_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = router;
