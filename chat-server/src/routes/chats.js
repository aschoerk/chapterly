const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const router = express.Router();

// ---------- Chats ----------

/**
 * @openapi
 * /api/chats:
 *   get:
 *     summary: List all chats
 *     description: Returns every chat ordered by most recently updated first.
 *     tags:
 *       - Chats
 *     responses:
 *       200:
 *         description: A list of chats
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     format: uuid
 *                     example: "550e8400-e29b-41d4-a716-446655440000"
 *                   title:
 *                     type: string
 *                     example: "My first chat"
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *                   updated_at:
 *                     type: string
 *                     format: date-time
 */
router.get('/', (req, res) => {
  const { projectId } = req.query;
  let rows;
  if (projectId) {
    rows = db.prepare(`
      SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC
    `).all(projectId);
  } else {
    rows = db.prepare(`
      SELECT * FROM chats ORDER BY updated_at DESC
    `).all();
  }
  res.json(rows.map(mapChat));
});

/**
 * @openapi
 * /api/chats:
 *   post:
 *     summary: Create a new chat
 *     description: Creates a chat with an optional title. Defaults to "New Chat".
 *     tags:
 *       - Chats
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *                 example: "My first chat"
 *                 description: Optional title for the new chat
 *     responses:
 *       201:
 *         description: Chat created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: uuid
 *                 title:
 *                   type: string
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *                 updated_at:
 *                   type: string
 *                   format: date-time
 */
router.post('/', (req, res) => {
  const { title = 'New Chat', projectId = null } = req.body;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO chats (id, title, project_id) VALUES (?, ?, ?)
  `).run(id, title, projectId || null);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  res.status(201).json(mapChat(chat));
});

/**
 * @openapi
 * /api/chats/{id}:
 *   get:
 *     summary: Get a single chat by ID
 *     tags:
 *       - Chats
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Chat UUID
 *     responses:
 *       200:
 *         description: The requested chat
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: uuid
 *                 title:
 *                   type: string
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *                 updated_at:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Chat not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Chat not found"
 */
router.get('/:id', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  res.json(mapChat(chat));
});

/**
 * @openapi
 * /api/chats/{id}:
 *   delete:
 *     summary: Delete a chat
 *     description: Permanently removes a chat. Returns 204 on success.
 *     tags:
 *       - Chats
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Chat UUID
 *     responses:
 *       204:
 *         description: Chat deleted successfully (no content)
 *       404:
 *         description: Chat not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Chat not found"
 */
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Chat not found' });
  res.status(204).end();
});

// ---------- Nodes ----------

/**
 * @openapi
 * /api/chats/{chatId}/nodes:
 *   get:
 *     summary: List all nodes of a chat
 *     description: Returns the full tree of nodes belonging to the given chat, ordered by creation time.
 *     tags:
 *       - Nodes
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Parent chat UUID
 *     responses:
 *       200:
 *         description: Array of chat nodes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ChatNode'
 */
router.get('/:chatId/nodes', (req, res) => {
  const nodes = db.prepare(`
    SELECT * FROM chat_nodes
    WHERE chat_id = ?
    ORDER BY created_at
  `).all(req.params.chatId);
  res.json(nodes.map(mapNode));
});

/**
 * @openapi
 * /api/chats/{chatId}/nodes:
 *   post:
 *     summary: Create a new question or answer node
 *     description: |
 *       Adds a new node (question or answer) to the chat tree.
 *       parentId may be null for root-level questions.
 *     tags:
 *       - Nodes
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Parent chat UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - content
 *             properties:
 *               parentId:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *                 description: ID of the parent node (null for root)
 *               type:
 *                 type: string
 *                 enum: [question, answer]
 *                 description: Node type
 *               content:
 *                 type: string
 *                 description: Text content of the node
 *               modelId:
 *                 type: string
 *                 nullable: true
 *                 description: Optional model identifier
 *               providerId:
 *                 type: string
 *                 nullable: true
 *                 description: Optional provider identifier
 *     responses:
 *       201:
 *         description: Node created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatNode'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "type and content are required"
 */
router.post('/:chatId/nodes', (req, res) => {
  const { chatId } = req.params;
  const {
    parentId = null,
    type,
    content,
    modelId = null,
    providerId = null
  } = req.body;

  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }
  if (type !== 'question' && type !== 'answer') {
    return res.status(400).json({ error: 'type must be "question" or "answer"' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO chat_nodes (
      id, chat_id, parent_id, type, content,
      model_id, provider_id, version, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
  `).run(id, chatId, parentId, type, content, modelId, providerId);

  // Touch the chat
  db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(chatId);

  const node = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(id);
  res.status(201).json(mapNode(node));
});

/**
 * @openapi
 * /api/chats/{chatId}/nodes/{nodeId}/edit-answer:
 *   post:
 *     summary: Create a new version of an answer
 *     description: |
 *       Marks the existing answer as not current and inserts a new version
 *       with an incremented version number. Only answer nodes can be versioned this way.
 *     tags:
 *       - Nodes
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Parent chat UUID
 *       - in: path
 *         name: nodeId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID of the answer node to version
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: New content for the answer version
 *     responses:
 *       201:
 *         description: New answer version created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatNode'
 *       400:
 *         description: Invalid request (missing content or node is not an answer)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       404:
 *         description: Node not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Node not found"
 */
router.post('/:chatId/nodes/:nodeId/edit-answer', (req, res) => {
  const { nodeId } = req.params;
  const { content } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }

  const oldNode = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
  if (!oldNode) return res.status(404).json({ error: 'Node not found' });
  if (oldNode.type !== 'answer') {
    return res.status(400).json({ error: 'Only answers can be versioned this way' });
  }

  // Mark old version as not current
  db.prepare('UPDATE chat_nodes SET is_current = 0 WHERE id = ?').run(nodeId);

  const newId = uuidv4();
  const newVersion = oldNode.version + 1;

  db.prepare(`
    INSERT INTO chat_nodes (
      id, chat_id, parent_id, type, content,
      model_id, provider_id, version, previous_version_id, is_current
    ) VALUES (?, ?, ?, 'answer', ?, ?, ?, ?, ?, 1)
  `).run(
    newId,
    oldNode.chat_id,
    oldNode.parent_id,
    content,
    oldNode.model_id,
    oldNode.provider_id,
    newVersion,
    nodeId
  );

  db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(oldNode.chat_id);

  const node = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(newId);
  res.status(201).json(mapNode(node));
});

/**
 * @openapi
 * /api/chats/{chatId}/nodes/{nodeId}/branch-question:
 *   post:
 *     summary: Branch a new question from an existing one
 *     description: |
 *       Creates a sibling question that shares the same parent as the original.
 *       Used when the user edits a previous question and wants to explore a different path.
 *     tags:
 *       - Nodes
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Parent chat UUID
 *       - in: path
 *         name: nodeId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID of the question node to branch from
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: Content of the new branched question
 *               modelId:
 *                 type: string
 *                 nullable: true
 *                 description: Optional override for model
 *               providerId:
 *                 type: string
 *                 nullable: true
 *                 description: Optional override for provider
 *     responses:
 *       201:
 *         description: Branched question created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatNode'
 *       400:
 *         description: Validation error or node is not a question
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       404:
 *         description: Node not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Node not found"
 */
router.post('/:chatId/nodes/:nodeId/branch-question', (req, res) => {
  const { nodeId } = req.params;
  const { content, modelId, providerId } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }

  const oldNode = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
  if (!oldNode) return res.status(404).json({ error: 'Node not found' });
  if (oldNode.type !== 'question') {
    return res.status(400).json({ error: 'Only questions can be branched this way' });
  }

  const newId = uuidv4();

  // New question becomes a sibling (same parent)
  db.prepare(`
    INSERT INTO chat_nodes (
      id, chat_id, parent_id, type, content,
      model_id, provider_id, version, is_current
    ) VALUES (?, ?, ?, 'question', ?, ?, ?, 1, 1)
  `).run(
    newId,
    oldNode.chat_id,
    oldNode.parent_id,
    content,
    modelId || oldNode.model_id,
    providerId || oldNode.provider_id
  );

  db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(oldNode.chat_id);

  const node = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(newId);
  res.status(201).json(mapNode(node));
});

// DELETE /api/chats/:chatId/nodes/:nodeId
router.delete('/:chatId/nodes/:nodeId', (req, res) => {
  const { nodeId } = req.params;

  const node = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
  if (!node) {
    return res.status(404).json({ error: 'Node not found' });
  }

  // Because of ON DELETE CASCADE on parent_id,
  // deleting a node will also delete all its children.
  const result = db.prepare('DELETE FROM chat_nodes WHERE id = ?').run(nodeId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Node not found' });
  }

  // Touch the chat
  db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(node.chat_id);

  res.status(204).end();
});

// PATCH /api/chats/:id
router.patch('/:id', (req, res) => {
  const { title, projectId } = req.body;
  const id = req.params.id;

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found' });
  }

  // only update title when a non-empty string is provided
  const newTitle =
    typeof title === 'string' && title.trim() !== ''
      ? title.trim()
      : chat.title;

  // projectId is updated only when the key is present in the body
  // (allows explicit null = unassign)
  const newProjectId =
    projectId !== undefined
      ? (projectId === null || projectId === '' ? null : projectId)
      : chat.project_id;

  db.prepare(`
    UPDATE chats
    SET title      = ?,
        project_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(newTitle, newProjectId, id);

  const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  res.json(mapChat(updated));
});



// Helper

function mapChat(row) {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function mapNode(row) {
  return {
    id: row.id,
    chatId: row.chat_id,
    parentId: row.parent_id,
    type: row.type,
    content: row.content,
    modelId: row.model_id,
    providerId: row.provider_id,
    version: row.version,
    previousVersionId: row.previous_version_id,
    isCurrent: !!row.is_current,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = router;
