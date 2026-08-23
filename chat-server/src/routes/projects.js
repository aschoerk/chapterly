const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// ---------- Projects ----------

/**
 * @openapi
 * /api/projects:
 *   get:
 *     summary: List all projects
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: List of projects ordered by name
 */
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM projects ORDER BY name COLLATE NOCASE
  `).all();
  res.json(rows.map(mapProject));
});

/**
 * @openapi
 * /api/projects:
 *   post:
 *     summary: Create a new project
 *     tags:
 *       - Projects
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               systemPrompt:
 *                 type: string
 *               defaultModelId:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       201:
 *         description: Project created
 */
router.post('/', (req, res) => {
  const { name, systemPrompt = '', defaultModelId = null } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO projects (id, name, system_prompt, default_model_id)
    VALUES (?, ?, ?, ?)
  `).run(id, name.trim(), systemPrompt || '', defaultModelId || null);

  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.status(201).json(mapProject(row));
});

/**
 * @openapi
 * /api/projects/{id}:
 *   get:
 *     summary: Get a single project
 *     tags:
 *       - Projects
 */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json(mapProject(row));
});

/**
 * @openapi
 * /api/projects/{id}:
 *   put:
 *     summary: Update a project
 *     tags:
 *       - Projects
 */
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, systemPrompt, defaultModelId } = req.body;

  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  db.prepare(`
    UPDATE projects
    SET name = COALESCE(?, name),
        system_prompt = COALESCE(?, system_prompt),
        default_model_id = COALESCE(?, default_model_id),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : null,
    systemPrompt !== undefined ? systemPrompt : null,
    defaultModelId !== undefined ? defaultModelId : null,
    id
  );

  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.json(mapProject(row));
});

/**
 * @openapi
 * /api/projects/{id}:
 *   delete:
 *     summary: Delete a project (chats become unassigned)
 *     tags:
 *       - Projects
 */
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Project not found' });
  }
  // chats.project_id becomes NULL due to ON DELETE SET NULL
  res.status(204).end();
});

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt || '',
    defaultModelId: row.default_model_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = router;
