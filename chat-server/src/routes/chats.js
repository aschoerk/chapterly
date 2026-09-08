const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { resolveChatParametersId, assertChatParametersExists, assertChatParametersKind } = require('../chatParameters');
const { resolveRequiredProjectId } = require('../assignment');
const {
  enforceGrant,
  enforceAudience,
  enforceModelUse,
  consumeContingent,
  workspaceIdOfChat,
  workspaceIdOfProject,
  authClientIds,
  placeholders
} = require('../oauth');
const router = express.Router();

function paramChatGrant(req, res, next, chatId) {
  if (enforceGrant(req, res, { audience: 'content', clientId: workspaceIdOfChat(chatId) })) return;
  next();
}
router.param('id', paramChatGrant);
router.param('chatId', paramChatGrant);

// ---------- Chats ----------

/**
 * @openapi
 * /api/chats:
 *   get:
 *     summary: List chats
 *     description: |
 *       Optional Bearer. With a token, only chats whose topic workspace is in the token
 *       topic claims are returned. Without a token, every chat (optionally filtered by projectId).
 *     tags:
 *       - Chats
 *     security:
 *       - {}
 *       - BearerAuth: []
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
  if (enforceAudience(req, res, 'content')) return;
  const { projectId } = req.query;
  if (projectId && enforceGrant(req, res, { audience: 'content', clientId: workspaceIdOfProject(projectId) })) return;
  let rows;
  if (req.auth) {
    const clientIds = authClientIds(req, 'content');
    rows = db.prepare(`
      SELECT DISTINCT c.* FROM chats c
      JOIN topic_projects tp ON tp.project_id = c.project_id
      JOIN topics t ON t.id = tp.topic_id
      WHERE t.workspace_id IN (${placeholders(clientIds)})
        AND (? IS NULL OR c.project_id = ?)
      ORDER BY c.updated_at DESC
    `).all(...clientIds, projectId || null, projectId || null);
    return res.json(rows.map(mapChat));
  }
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
 *     description: |
 *       Creates a chat with an optional title (default "New Chat").
 *       Every chat must belong to a project, and every project to a topic.
 *       Optional Bearer: the project/topic workspace must match a `write` topic claim.
 *     tags:
 *       - Chats
 *     security:
 *       - {}
 *       - BearerAuth: []
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
  const chatParametersId = resolveChatParametersId(req.body, null);
  if (!assertChatParametersExists(chatParametersId)) {
    return res.status(400).json({ error: 'chatParametersId does not exist' });
  }
  const paramKind = assertChatParametersKind(chatParametersId, 'content');
  if (!paramKind.ok) {
    return res.status(400).json({ error: paramKind.error });
  }
  if (enforceAudience(req, res, 'content')) return;
  let resolved;
  if (req.auth && !projectId) {
    const owned = db.prepare(`
      SELECT t.default_project_id AS project_id
      FROM topics t
      WHERE t.workspace_id IN (${placeholders(authClientIds(req, 'content'))}) AND t.default_project_id IS NOT NULL
      ORDER BY t.name
      LIMIT 1
    `).get(...authClientIds(req, 'content'));
    if (!owned) return res.status(400).json({ error: 'no project exists for the authorized content client' });
    resolved = { projectId: owned.project_id };
  } else {
    resolved = resolveRequiredProjectId(projectId || null, null);
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }
  }
  if (enforceGrant(req, res, { audience: 'content', clientId: workspaceIdOfProject(resolved.projectId) })) return;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO chats (id, title, project_id, chat_parameters_id) VALUES (?, ?, ?, ?)
  `).run(id, title, resolved.projectId, chatParametersId);
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
 *       Adds a node to the chat tree. parentId may be null for a root question.
 *       Optional attachments can be supplied as data-URLs.
 *       Optional Bearer: needs a `write` topic claim on the chat workspace.
 *       If modelId or providerId is set, also needs the token provider claim (`run` or `manage`)
 *       for that wallet, and the contingent must not be exhausted.
 *     tags:
 *       - Nodes
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
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
 *             required: [type, content]
 *             properties:
 *               parentId:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *               role:
 *                 type: string
 *                 enum: [system, question, answer]
 *               content:
 *                 type: string
 *               thinking:
 *                 type: string
 *                 nullable: true
 *               modelId:
 *                 type: string
 *                 nullable: true
 *               providerId:
 *                 type: string
 *                 nullable: true
 *               attachments:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/NodeAttachment'
 *                 description: Optional list of file attachments
 *     responses:
 *       201:
 *         description: Node created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatNode'
 *       400:
 *         description: Validation error
 */
router.post('/:chatId/nodes', (req, res) => {
  const { chatId } = req.params;
  const {
    parentId = null,
    role,
    content,
    thinking,
    modelId = null,
    providerId = null,
    attachments = []
  } = req.body;
  const chatParametersId = resolveChatParametersId(req.body, null);
  if (!assertChatParametersExists(chatParametersId)) {
    return res.status(400).json({ error: 'chatParametersId does not exist' });
  }
  const paramKind = assertChatParametersKind(chatParametersId, 'content');
  if (!paramKind.ok) {
    return res.status(400).json({ error: paramKind.error });
  }

  if (!role) {
    return res.status(400).json({ error: 'role is required' });
  }
  if (role !== 'system' && role !== 'user' && role != 'assistant') {
    return res.status(400).json({ error: 'role must be "system","user" or "assistant"' });
  }
  if (enforceModelUse(req, res, { modelId, providerId })) return;

  const id = uuidv4();
  const attachmentsJson = JSON.stringify(Array.isArray(attachments) ? attachments : []);

  db.prepare(`
    INSERT INTO chat_nodes (
      id, chat_id, parent_id, role, content, thinking,
      model_id, provider_id, version, is_current, attachments, chat_parameters_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(id, chatId, parentId, role, content ?? '',
    thinking ?? null, modelId, providerId, attachmentsJson, chatParametersId);

  db.prepare(`UPDATE chats SET updated_at = datetime('now'), node_number = node_number + 1 WHERE id = ?`).run(chatId);

  const node = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(id);
  if (modelId || providerId) {
    consumeContingent(req, {
      cost: req.body.totalCost || req.body.total_cost || 0,
      tokens: req.body.totalTokens || req.body.total_tokens || req.body.promptTokens || 0
    });
  }
  res.status(201).json(mapNode(node));
});


/**
 * Shared helper to create a new version of a node (question or answer).
 */
function editNodeVersion(nodeId, expectedRole, { content, thinking, attachments }) {
  if (content === undefined || content === null) {
    const err = new Error('content is required');
    err.status = 400;
    throw err;
  }

  const oldNode = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
  if (!oldNode) {
    const err = new Error('Node not found');
    err.status = 404;
    throw err;
  }

  if (oldNode.role != 'system' && oldNode.role != expectedRole) {
    const err = new Error(`Only ${expectedRole}s can be versioned this way`);
    err.status = 400;
    throw err;
  }

  const childNode = db.prepare(
    'SELECT * FROM chat_nodes WHERE parent_id = ?'
  ).get(nodeId);

  const isEmptyNode = !String(oldNode.content || '').trim();

  const attachmentsJson = attachments !== undefined
    ? JSON.stringify(Array.isArray(attachments) ? attachments : [])
    : (oldNode.attachments || '[]');

  const newThinking = thinking !== undefined && expectedRole === 'assistant'
    ? thinking
    : oldNode.thinking;

  // Empty leaf: mutate the current row. Anything else: insert a new version.
  const executeEditTransaction = db.transaction(() => {
    if (isEmptyNode && !childNode) {
      db.prepare(`
        UPDATE chat_nodes
        SET content = ?, thinking = ?, attachments = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(content, newThinking, attachmentsJson, nodeId);
      db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(oldNode.chat_id);
      return db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
    }

    db.prepare('UPDATE chat_nodes SET is_current = 0 WHERE id = ?').run(oldNode.id);

    const newId = uuidv4();
    const newVersion = (oldNode.version || 1) + 1;
    db.prepare(`
      INSERT INTO chat_nodes (
        id, chat_id, parent_id, role, content, thinking,
        model_id, provider_id, version, previous_version_id, is_current, attachments, chat_parameters_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      newId,
      oldNode.chat_id,
      oldNode.parent_id,
      oldNode.role,
      content,
      newThinking,
      oldNode.model_id,
      oldNode.provider_id,
      newVersion,
      nodeId,
      attachmentsJson,
      oldNode.chat_parameters_id || null
    );
    db.prepare(`UPDATE chats SET updated_at = datetime('now'), node_number = node_number + 1 WHERE id = ?`).run(oldNode.chat_id);
    db.prepare(`UPDATE chat_nodes SET parent_id = ?, updated_at = datetime('now') WHERE parent_id = ?`).run(newId, nodeId);
    return db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(newId);
  });

  return executeEditTransaction();
}



/**
 * @openapi
 * /api/chats/{chatId}/nodes/{nodeId}/edit-assistant:
 *   post:
 *     summary: Create a new version of an answer
 *     description: |
 *       Marks the existing answer as not current and inserts a new version
 *       with an incremented version number. Attachments can be supplied or updated.
 *     tags:
 *       - Nodes
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: nodeId
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
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *               thinking:
 *                 type: string
 *                 nullable: true
 *               attachments:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/NodeAttachment'
 *                 description: |
 *                   Optional. If omitted, the previous version's attachments are kept.
 *                   Pass an empty array to clear attachments.
 *     responses:
 *       201:
 *         description: New answer version created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatNode'
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Node not found
 */
router.post('/:chatId/nodes/:nodeId/edit-assistant', (req, res) => {
  try {
    const node = editNodeVersion(req.params.nodeId, 'assistant', req.body);
    res.status(201).json(mapNode(node));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:chatId/nodes/:nodeId/edit-user', (req, res) => {
  try {
    const node = editNodeVersion(req.params.nodeId, 'user', req.body);
    res.status(201).json(mapNode(node));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
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
 *               thinking:
 *                  type: string
 *                  nullable: true
 *                  description: LLM thinking process if requested
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
router.post('/:chatId/nodes/:nodeId/branch-user', (req, res) => {
  const { nodeId } = req.params;
  const { content, thinking, modelId, providerId, attachments } = req.body;

  if (content === undefined || content === null) {
    return res.status(400).json({ error: 'content is required' });
  }

  const oldNode = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
  if (!oldNode) return res.status(404).json({ error: 'Node not found' });
  if (oldNode.role !== 'user') {
    return res.status(400).json({ error: 'Only questions can be branched this way' });
  }
  if (enforceModelUse(req, res, { modelId, providerId })) return;
  const chatParametersId = resolveChatParametersId(req.body, oldNode.chat_parameters_id);
  if (!assertChatParametersExists(chatParametersId)) {
    return res.status(400).json({ error: 'chatParametersId does not exist' });
  }
  const paramKind = assertChatParametersKind(chatParametersId, 'content');
  if (!paramKind.ok) {
    return res.status(400).json({ error: paramKind.error });
  }

  const newId = uuidv4();

  // If attachments supplied use them, otherwise copy from the original question
  const attachmentsJson = attachments !== undefined
    ? JSON.stringify(Array.isArray(attachments) ? attachments : [])
    : (oldNode.attachments || '[]');

  db.prepare(`
    INSERT INTO chat_nodes (
      id, chat_id, parent_id, role, content, thinking,
      model_id, provider_id, version, is_current, attachments, chat_parameters_id
    ) VALUES (?, ?, ?, 'user', ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(
    newId,
    oldNode.chat_id,
    oldNode.parent_id,
    content,
    thinking,
    modelId || oldNode.model_id,
    providerId || oldNode.provider_id,
    attachmentsJson,
    chatParametersId
  );

  db.prepare(`UPDATE chats SET updated_at = datetime('now'), node_number = node_number + 1 WHERE id = ?`).run(oldNode.chat_id);

  const node = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(newId);
  res.status(201).json(mapNode(node));
});

// DELETE /api/chats/:chatId/nodes/:nodeId
// Query: keepChildren=true reparents direct children to this node's parent
// (or NULL) before deleting, so the subtree is not lost. Default is cascade.
router.delete('/:chatId/nodes/:nodeId', (req, res) => {
  const { chatId, nodeId } = req.params;
  const keepChildren = ['1', 'true', 'yes'].includes(
    String(req.query.keepChildren || '').toLowerCase()
  );

  const node = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
  if (!node || node.chat_id !== chatId) {
    return res.status(404).json({ error: 'Node not found' });
  }

  const txn = db.transaction(() => {
    if (keepChildren) {
      db.prepare(`
        UPDATE chat_nodes
        SET previous_version_id = ?
        WHERE previous_version_id = ?
      `).run(node.previous_version_id ?? null, nodeId);

      db.prepare(`
        UPDATE chat_nodes
        SET parent_id = ?
        WHERE parent_id = ?
      `).run(node.parent_id ?? null, nodeId);
    }

    const result = db.prepare('DELETE FROM chat_nodes WHERE id = ?').run(nodeId);
    if (result.changes === 0) {
      const err = new Error('NOT_FOUND');
      err.status = 404;
      throw err;
    }

    const removed = keepChildren ? 1 : result.changes;
    db.prepare(`
      UPDATE chats
      SET updated_at = datetime('now'), node_number = node_number - ?
      WHERE id = ?
    `).run(removed, node.chat_id);
    return result;
  });

  try {
    txn();
  } catch (err) {
    if (err.status === 404 || err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Node not found' });
    }
    throw err;
  }

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
  const chatParametersId = resolveChatParametersId(req.body, chat.chat_parameters_id);
  if (!assertChatParametersExists(chatParametersId)) {
    return res.status(400).json({ error: 'chatParametersId does not exist' });
  }
  const paramKind = assertChatParametersKind(chatParametersId, 'content');
  if (!paramKind.ok) {
    return res.status(400).json({ error: paramKind.error });
  }

  // only update title when a non-empty string is provided
  const newTitle =
    typeof title === 'string' && title.trim() !== ''
      ? title.trim()
      : chat.title;

  // projectId is updated only when the key is present in the body.
  // null / '' unassigns from the current project and places the chat
  // on the default project of the same topic.
  let newProjectId = chat.project_id;
  if (projectId !== undefined) {
    const requested = (projectId === null || projectId === '') ? null : projectId;
    const resolved = resolveRequiredProjectId(requested, chat.project_id);
    if (!resolved.error && enforceGrant(req, res, { audience: 'content', clientId: workspaceIdOfProject(resolved.projectId) })) return;
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }
    newProjectId = resolved.projectId;
  }

  db.prepare(`
    UPDATE chats
    SET title      = ?,
        project_id = ?,
        chat_parameters_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(newTitle, newProjectId, chatParametersId, id);

  const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  res.json(mapChat(updated));
});

router.patch('/:chatId/nodes/:nodeId', (req, res) => {
  const { nodeId } = req.params;
  const { content, thinking, attachments, modelId, providerId } = req.body || {};

  const oldNode = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
  if (!oldNode) return res.status(404).json({ error: 'Node not found' });
  const chatParametersId = resolveChatParametersId(req.body || {}, oldNode.chat_parameters_id);
  if (!assertChatParametersExists(chatParametersId)) {
    return res.status(400).json({ error: 'chatParametersId does not exist' });
  }
  const paramKind = assertChatParametersKind(chatParametersId, 'content');
  if (!paramKind.ok) {
    return res.status(400).json({ error: paramKind.error });
  }
  if (enforceModelUse(req, res, {
    modelId: modelId !== undefined ? modelId : oldNode.model_id,
    providerId: providerId !== undefined ? providerId : oldNode.provider_id
  })) return;

  const nextContent = content !== undefined ? content : oldNode.content;
  const nextThinking = thinking !== undefined ? thinking : oldNode.thinking;
  const nextAttachments = attachments !== undefined
    ? JSON.stringify(Array.isArray(attachments) ? attachments : [])
    : (oldNode.attachments || '[]');
  const nextModel = modelId !== undefined ? modelId : oldNode.model_id;
  const nextProvider = providerId !== undefined ? providerId : oldNode.provider_id;

  db.prepare(`
    UPDATE chat_nodes
    SET content = ?, thinking = ?, attachments = ?, model_id = ?, provider_id = ?,
        chat_parameters_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nextContent, nextThinking, nextAttachments, nextModel, nextProvider, chatParametersId, nodeId);

  db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(oldNode.chat_id);

  const node = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
  res.json(mapNode(node));
});



// Helper

function mapChat(row) {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id || null,
    chatParametersId: row.chat_parameters_id || null,
    node_number: row.node_number,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function mapNode(row) {
  return {
    id: row.id,
    chatId: row.chat_id,
    parentId: row.parent_id,
    role: row.role,
    content: row.content,
    thinking: row.thinking ?? null,
    modelId: row.model_id,
    providerId: row.provider_id,
    version: row.version,
    previousVersionId: row.previous_version_id,
    isCurrent: !!row.is_current,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    promptTokens: row.prompt_tokens ?? null,
    completionTokens: row.completion_tokens ?? null,
    attachments: JSON.parse(row.attachments || '[]'),
    chatParametersId: row.chat_parameters_id || null
  };
}

module.exports = router;
