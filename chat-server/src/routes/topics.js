const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

function mapTopic(row) {
  if (!row) return null;
  const projectIds = db
    .prepare('SELECT project_id FROM topic_projects WHERE topic_id = ?')
    .all(row.id)
    .map(r => r.project_id);

  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    defaultModelId: row.default_model_id || null,
    defaultSystemPrompt: row.default_system_prompt || '',
    icon: row.icon || '',
    projectIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/topics:
 *   get:
 *     summary: List all topics
 *     tags:
 *       - Topics
 *     responses:
 *       200:
 *         description: Array of topics
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Topic'
 */
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM topics ORDER BY name').all();
  res.json(rows.map(mapTopic));
});

/**
 * @openapi
 * /api/topics/{id}:
 *   get:
 *     summary: Get a single topic by ID
 *     tags:
 *       - Topics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Topic found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Topic'
 *       404:
 *         description: Topic not found
 */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Topic not found' });
  res.json(mapTopic(row));
});

/**
 * @openapi
 * /api/topics:
 *   post:
 *     summary: Create a new topic
 *     tags:
 *       - Topics
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
 *                 example: "Cyberpunk Night"
 *               description:
 *                 type: string
 *                 example: "Neon-lit urban scenarios"
 *               defaultModelId:
 *                 type: string
 *                 nullable: true
 *                 description: Optional default model ID
 *               defaultSystemPrompt:
 *                 type: string
 *                 description: Default system prompt applied to chats of this topic
 *               icon:
 *                 type: string
 *                 description: Emoji, URL or storage key for the topic icon
 *               projectIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 description: Optional initial list of project IDs to attach
 *     responses:
 *       201:
 *         description: Topic created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Topic'
 *       400:
 *         description: Missing or invalid name
 */
router.post('/', (req, res) => {
  const {
    name,
    description = '',
    defaultModelId = null,
    defaultSystemPrompt = '',
    icon = '',
    projectIds = []
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO topics
    (id, name, description, default_model_id, default_system_prompt, icon, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name.trim(),
    description,
    defaultModelId,
    defaultSystemPrompt,
    icon,
    now,
    now
  );

  const insertJoin = db.prepare(
    'INSERT OR IGNORE INTO topic_projects (topic_id, project_id) VALUES (?, ?)'
  );
  for (const pid of projectIds) {
    insertJoin.run(id, pid);
  }

  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  res.status(201).json(mapTopic(row));
});

/**
 * @openapi
 * /api/topics/{id}:
 *   put:
 *     summary: Update an existing topic
 *     tags:
 *       - Topics
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
 *               description:
 *                 type: string
 *               defaultModelId:
 *                 type: string
 *                 nullable: true
 *               defaultSystemPrompt:
 *                 type: string
 *               icon:
 *                 type: string
 *     responses:
 *       200:
 *         description: Topic updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Topic'
 *       404:
 *         description: Topic not found
 */
router.put('/:id', (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Topic not found' });

  const {
    name,
    description,
    defaultModelId,
    defaultSystemPrompt,
    icon
  } = req.body;

  db.prepare(`
    UPDATE topics SET
      name                  = COALESCE(?, name),
      description           = COALESCE(?, description),
      default_model_id      = COALESCE(?, default_model_id),
      default_system_prompt = COALESCE(?, default_system_prompt),
      icon                  = COALESCE(?, icon),
      updated_at            = datetime('now')
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : null,
    description !== undefined ? description : null,
    defaultModelId !== undefined ? defaultModelId : null,
    defaultSystemPrompt !== undefined ? defaultSystemPrompt : null,
    icon !== undefined ? icon : null,
    id
  );

  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  res.json(mapTopic(row));
});

/**
 * @openapi
 * /api/topics/{id}:
 *   delete:
 *     summary: Delete a topic
 *     description: |
 *       Deletes the topic. All memberships in the join table are removed
 *       automatically via ON DELETE CASCADE. Projects themselves are not deleted.
 *     tags:
 *       - Topics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Topic deleted
 *       404:
 *         description: Topic not found
 */
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM topics WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Topic not found' });
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Project membership
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/topics/{id}/projects:
 *   post:
 *     summary: Add a project to a topic
 *     tags:
 *       - Topics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Topic ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [projectId]
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the project to attach
 *     responses:
 *       200:
 *         description: Project added (or already present). Returns the updated topic.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Topic'
 *       400:
 *         description: projectId missing
 *       404:
 *         description: Topic or Project not found
 */
router.post('/:id/projects', (req, res) => {
  const topicId = req.params.id;
  const { projectId } = req.body;

  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  const topic = db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  db.prepare(
    'INSERT OR IGNORE INTO topic_projects (topic_id, project_id) VALUES (?, ?)'
  ).run(topicId, projectId);

  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  res.json(mapTopic(row));
});

/**
 * @openapi
 * /api/topics/{id}/projects/{projectId}:
 *   delete:
 *     summary: Remove a project from a topic
 *     tags:
 *       - Topics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Topic ID
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project ID to detach
 *     responses:
 *       200:
 *         description: Project removed. Returns the updated topic.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Topic'
 *       404:
 *         description: Membership not found
 */
router.delete('/:id/projects/:projectId', (req, res) => {
  const { id: topicId, projectId } = req.params;

  const result = db
    .prepare('DELETE FROM topic_projects WHERE topic_id = ? AND project_id = ?')
    .run(topicId, projectId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Membership not found' });
  }

  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  res.json(mapTopic(row));
});

module.exports = router;
