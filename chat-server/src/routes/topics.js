const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { resolveChatParametersId, assertChatParametersExists, assertChatParametersKind } = require('../chatParameters');
const {
  attachProjectToTopic,
  ensureTopicDefaultProject,
  ensureProjectHasTopic,
  rehomeOrphanProjects
} = require('../assignment');
const {
  resolveContentClientId,
  validateContentClientId
} = require('../clients');
const { enforceGrant, enforceAudience, workspaceIdOfTopic, primaryClientId } = require('../oauth');

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
    chatParametersId: row.chat_parameters_id || null,
    defaultSystemPrompt: row.default_system_prompt || '',
    icon: row.icon || '',
    projectIds,
    workspaceId: row.workspace_id || null,
    defaultProjectId: row.default_project_id || null,
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
 *     summary: List topics
 *     description: |
 *       Optional Bearer. With a token, only topics whose workspace is in the token topic claims
 *       and that allow `read` (or `write`) are listed. Without a token, all topics (or the
 *       workspaceId query filter) are returned.
 *     tags:
 *       - Topics
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: false
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Ignored when a Bearer is present. Otherwise filters by workspace.
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
router.get('/', (req, res) => {
  if (enforceAudience(req, res, 'content')) return;
  const workspaceId = req.auth
    ? primaryClientId(req, 'content')
    : (req.query.workspaceId || req.query.workspace_id);
  const rows = workspaceId
    ? db.prepare('SELECT * FROM topics WHERE workspace_id = ? ORDER BY name').all(workspaceId)
    : db.prepare('SELECT * FROM topics ORDER BY name').all();
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
  if (enforceGrant(req, res, { audience: 'content', clientId: row.workspace_id })) return;
  res.json(mapTopic(row));
});

/**
 * @openapi
 * /api/topics:
 *   post:
 *     summary: Create a new topic
 *     description: |
 *       Optional Bearer. With a token, the topic is created in a workspace from a `write` topic claim.
 *       Without a token, workspaceId may be set freely.
 *     tags:
 *       - Topics
 *     security:
 *       - {}
 *       - BearerAuth: []
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
 *               workspaceId:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *                 description: Owning content client.
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

  const chatParametersId = resolveChatParametersId(req.body, null);
  if (!assertChatParametersExists(chatParametersId)) {
    return res.status(400).json({ error: 'chatParametersId does not exist' });
  }
  const paramKind = assertChatParametersKind(chatParametersId, 'run');
  if (!paramKind.ok) {
    return res.status(400).json({ error: paramKind.error });
  }

  const workspaceId = resolveContentClientId(req.body, req.auth ? primaryClientId(req, 'content') : null);
  const workspace = validateContentClientId(workspaceId);
  if (!workspace.ok) {
    return res.status(400).json({ error: workspace.error });
  }
  if (enforceGrant(req, res, { audience: 'content', clientId: workspace.id })) return;

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO topics
    (id, name, description, default_model_id, default_system_prompt, icon, chat_parameters_id, workspace_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name.trim(),
    description,
    defaultModelId,
    defaultSystemPrompt,
    icon,
    chatParametersId,
    workspace.id,
    now,
    now
  );

  for (const pid of projectIds) {
    attachProjectToTopic(id, pid);
  }
  ensureTopicDefaultProject(id);

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
 *               workspaceId:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
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
  if (enforceGrant(req, res, { audience: 'content', clientId: existing.workspace_id })) return;

  const {
    name,
    description,
    defaultModelId,
    defaultSystemPrompt,
    icon
  } = req.body;

  const chatParametersId = resolveChatParametersId(req.body, existing.chat_parameters_id);
  if (!assertChatParametersExists(chatParametersId)) {
    return res.status(400).json({ error: 'chatParametersId does not exist' });
  }
  const paramKind = assertChatParametersKind(chatParametersId, 'run');
  if (!paramKind.ok) {
    return res.status(400).json({ error: paramKind.error });
  }

  const workspaceId = resolveContentClientId(req.body, existing.workspace_id);
  const workspace = validateContentClientId(workspaceId);
  if (!workspace.ok) {
    return res.status(400).json({ error: workspace.error });
  }
  if (enforceGrant(req, res, { audience: 'content', clientId: workspace.id })) return;

  db.prepare(`
    UPDATE topics SET
                    name                  = COALESCE(?, name),
                    description           = COALESCE(?, description),
                    default_model_id      = COALESCE(?, default_model_id),
                    default_system_prompt = COALESCE(?, default_system_prompt),
                    icon                  = COALESCE(?, icon),
                    chat_parameters_id    = ?,
                    workspace_id     = ?,
                    updated_at            = datetime('now')
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : null,
    description !== undefined ? description : null,
    defaultModelId !== undefined ? defaultModelId : null,
    defaultSystemPrompt !== undefined ? defaultSystemPrompt : null,
    icon !== undefined ? icon : null,
    chatParametersId,
    workspace.id,
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
  const existing = db.prepare('SELECT * FROM topics WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Topic not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: existing.workspace_id })) return;
  const result = db.prepare('DELETE FROM topics WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Topic not found' });
  }
  rehomeOrphanProjects();
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

  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: topic.workspace_id })) return;

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  attachProjectToTopic(topicId, projectId);
  ensureTopicDefaultProject(topicId);

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
  const topicRow = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  if (!topicRow) return res.status(404).json({ error: 'Topic not found' });
  if (enforceGrant(req, res, { audience: 'content', clientId: topicRow.workspace_id })) return;

  const result = db
    .prepare('DELETE FROM topic_projects WHERE topic_id = ? AND project_id = ?')
    .run(topicId, projectId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Membership not found' });
  }

  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  if (topic && topic.default_project_id === projectId) {
    db.prepare('UPDATE topics SET default_project_id = NULL WHERE id = ?').run(topicId);
    ensureTopicDefaultProject(topicId);
  }

  ensureProjectHasTopic(projectId);

  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  res.json(mapTopic(row));
});

module.exports = router;
