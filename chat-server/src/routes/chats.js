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
    rows = db.prepare(`SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId);
  } else {
    rows = db.prepare(`SELECT * FROM chats ORDER BY updated_at DESC`).all();
  }
  res.json(rows.map(mapChat));
});

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
  db.prepare(`INSERT INTO chats (id, title, project_id, chat_parameters_id) VALUES (?, ?, ?, ?)`).run(id, title, resolved.projectId, chatParametersId);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  res.status(201).json(mapChat(chat));
});

router.get('/:id', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  res.json(mapChat(chat));
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Chat not found' });
  res.status(204).end();
});

router.get('/:chatId/nodes', (req, res) => {
  const nodes = db.prepare(`SELECT * FROM chat_nodes WHERE chat_id = ? ORDER BY created_at`).all(req.params.chatId);
  res.json(nodes.map(mapNode));
});

router.post('/:chatId/nodes', (req, res) => {
  const { chatId } = req.params;
  const { parentId = null, role, content, thinking, modelId = null, providerId = null, attachments = [] } = req.body;
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
  `).run(id, chatId, parentId, role, content ?? '', thinking ?? null, modelId, providerId, attachmentsJson, chatParametersId);
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
  const childNode = db.prepare('SELECT * FROM chat_nodes WHERE parent_id = ?').get(nodeId);
  const isEmptyNode = !String(oldNode.content || '').trim();
  const attachmentsJson = attachments !== undefined
    ? JSON.stringify(Array.isArray(attachments) ? attachments : [])
    : (oldNode.attachments || '[]');
  const newThinking = thinking !== undefined && expectedRole === 'assistant' ? thinking : oldNode.thinking;
  const executeEditTransaction = db.transaction(() => {
    if (isEmptyNode && !childNode) {
      db.prepare(`UPDATE chat_nodes SET content = ?, thinking = ?, attachments = ?, updated_at = datetime('now') WHERE id = ?`).run(content, newThinking, attachmentsJson, nodeId);
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
    `).run(newId, oldNode.chat_id, oldNode.parent_id, oldNode.role, content, newThinking, oldNode.model_id, oldNode.provider_id, newVersion, nodeId, attachmentsJson, oldNode.chat_parameters_id || null);
    db.prepare(`UPDATE chats SET updated_at = datetime('now'), node_number = node_number + 1 WHERE id = ?`).run(oldNode.chat_id);
    db.prepare(`UPDATE chat_nodes SET parent_id = ?, updated_at = datetime('now') WHERE parent_id = ?`).run(newId, nodeId);
    return db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(newId);
  });
  return executeEditTransaction();
}

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
  const attachmentsJson = attachments !== undefined
    ? JSON.stringify(Array.isArray(attachments) ? attachments : [])
    : (oldNode.attachments || '[]');
  db.prepare(`
    INSERT INTO chat_nodes (
      id, chat_id, parent_id, role, content, thinking,
      model_id, provider_id, version, is_current, attachments, chat_parameters_id
    ) VALUES (?, ?, ?, 'user', ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(newId, oldNode.chat_id, oldNode.parent_id, content, thinking, modelId || oldNode.model_id, providerId || oldNode.provider_id, attachmentsJson, chatParametersId);
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
  const newTitle = typeof title === 'string' && title.trim() !== '' ? title.trim() : chat.title;
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
  db.prepare(`UPDATE chats SET title = ?, project_id = ?, chat_parameters_id = ?, updated_at = datetime('now') WHERE id = ?`).run(newTitle, newProjectId, chatParametersId, id);
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
        chat_parameters_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nextContent, nextThinking, nextAttachments, nextModel, nextProvider, chatParametersId, nodeId);
  db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(oldNode.chat_id);
  const node = db.prepare('SELECT * FROM chat_nodes WHERE id = ?').get(nodeId);
  res.json(mapNode(node));
});

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
