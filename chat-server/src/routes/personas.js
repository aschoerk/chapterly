const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// ---------- Personas ----------

/**
 * @openapi
 * /api/personas:
 *   get:
 *     summary: List all personas
 *     tags:
 *       - Personas
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
  const rows = db.prepare(`
    SELECT * FROM personas ORDER BY name COLLATE NOCASE
  `).all();
  res.json(rows.map(mapPersona));
});

/**
 * @openapi
 * /api/personas:
 *   post:
 *     summary: Create a new persona
 *     tags:
 *       - Personas
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

  const id = uuidv4();
  db.prepare(`
    INSERT INTO personas (id, name, short_name, description, avatar)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    name.trim(),
    shortName.trim(),
    description || '',
    avatar || ''
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

  db.prepare(`
    UPDATE personas
    SET name = COALESCE(?, name),
        short_name = COALESCE(?, short_name),
        description = COALESCE(?, description),
        avatar = COALESCE(?, avatar),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : null,
    shortName !== undefined ? shortName.trim() : null,
    description !== undefined ? description : null,
    avatar !== undefined ? avatar : null,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = router;
