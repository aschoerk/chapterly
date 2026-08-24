const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

function parsePersonaIds(raw) {
  if (Array.isArray(raw)) {
    return raw.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim());
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim());
      }
    } catch {
      // ignore invalid JSON
    }
  }
  return [];
}

function serializePersonaIds(ids) {
  return JSON.stringify(parsePersonaIds(ids));
}

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
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Project'
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
 *               greeting:
 *                 type: string
 *               systemPrompt:
 *                 type: string
 *               defaultModelId:
 *                 type: string
 *                 nullable: true
 *               avatar:
 *                 type: string
 *                 description: URL or data URL for the project avatar
 *               personaIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 description: IDs of personas linked to this project
 *     responses:
 *       201:
 *         description: Project created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/', (req, res) => {
  const {
    name,
    greeting,
    systemPrompt = '',
    defaultModelId = null,
    avatar = '',
    personaIds = []
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO projects (id, name, greeting, system_prompt, default_model_id, avatar, persona_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name.trim(),
    greeting,
    systemPrompt || '',
    defaultModelId || null,
    avatar || '',
    serializePersonaIds(personaIds)
  );

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
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Project found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               greeting:
 *                 type: string
 *               systemPrompt:
 *                 type: string
 *               defaultModelId:
 *                 type: string
 *                 nullable: true
 *               avatar:
 *                 type: string
 *               personaIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       200:
 *         description: Project updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       400:
 *         description: Validation or constraint error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, greeting, systemPrompt, defaultModelId, avatar, personaIds } = req.body;

  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  try {

    db.prepare(`
    UPDATE projects
    SET name = COALESCE(?, name),
        greeting = COALESCE(?, greeting),
        system_prompt = COALESCE(?, system_prompt),
        default_model_id = COALESCE(?, default_model_id),
        avatar = COALESCE(?, avatar),
        persona_ids = COALESCE(?, persona_ids),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
      name !== undefined ? name.trim() : null,
      greeting !== undefined ? greeting : null,
      systemPrompt !== undefined ? systemPrompt : null,
      defaultModelId !== undefined ? defaultModelId : null,
      avatar !== undefined ? avatar : null,
      personaIds !== undefined ? serializePersonaIds(personaIds) : null,
      id
    );
  } catch (err) {
    console.error('Project update failed:', err.message, { id, body: req.body });
    return res.status(400).json({ error: err.message });
  }

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
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Project deleted
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
    greeting: row.greeting,
    systemPrompt: row.system_prompt || '',
    defaultModelId: row.default_model_id || null,
    avatar: row.avatar || '',
    personaIds: parsePersonaIds(row.persona_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = router;
