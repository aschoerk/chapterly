const { v4: uuidv4 } = require('uuid');
const db = require('../db');

/**
 * Title for a cloned story: "Name" → "Name (copy)", "Name (copy)" → "Name (copy 2)".
 */
function cloneChatTitle(title) {
  const base = String(title || '').trim() || 'Untitled story';
  const m = base.match(/^(.*) \(copy(?: (\d+))?\)$/);
  if (!m) return `${base} (copy)`;
  const n = m[2] ? Number(m[2]) + 1 : 2;
  return `${m[1]} (copy ${n})`;
}

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

/**
 * Register POST /:id/clone.
 * Deep-copies the chat and every node, remapping parentId and previousVersionId.
 */
module.exports = function registerCloneChat(router) {
  /**
   * @openapi
   * /api/chats/{id}/clone:
   *   post:
   *     summary: Clone a chat including its full node tree
   *     description: |
   *       Creates a new chat in the same project with a copy of every node.
   *       Node ids are new. parentId and previousVersionId are remapped so
   *       the tree, sibling forks, and version chains match the original.
   *       Content, thinking, attachments, model/provider, version flags,
   *       and timestamps are copied as-is.
   *     tags:
   *       - Chats
   *     security:
   *       - {}
   *       - BearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *         description: Source chat UUID
   *     responses:
   *       201:
   *         description: Cloned chat
   *       404:
   *         description: Chat not found
   */
  router.post('/:id/clone', (req, res) => {
    const srcId = req.params.id;
    const src = db.prepare('SELECT * FROM chats WHERE id = ?').get(srcId);
    if (!src) return res.status(404).json({ error: 'Chat not found' });

    const srcNodes = db.prepare(`
      SELECT * FROM chat_nodes WHERE chat_id = ? ORDER BY created_at
    `).all(srcId);

    try {
      const cloned = db.transaction(() => {
        const newChatId = uuidv4();
        const title = cloneChatTitle(src.title);
        db.prepare(`
          INSERT INTO chats (id, title, project_id, chat_parameters_id, node_number)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          newChatId,
          title,
          src.project_id || null,
          src.chat_parameters_id || null,
          srcNodes.length
        );

        const idMap = new Map();
        for (const n of srcNodes) idMap.set(n.id, uuidv4());

        const remap = (oldId) => {
          if (!oldId) return null;
          return idMap.has(oldId) ? idMap.get(oldId) : null;
        };

        const remaining = [...srcNodes];
        const inserted = new Set();
        while (remaining.length) {
          const idx = remaining.findIndex((n) => {
            const parentOk = !n.parent_id || inserted.has(n.parent_id) || !idMap.has(n.parent_id);
            const prevOk = !n.previous_version_id || inserted.has(n.previous_version_id) || !idMap.has(n.previous_version_id);
            return parentOk && prevOk;
          });
          if (idx < 0) {
            const err = new Error('Cannot clone chat: cyclic node references');
            err.status = 400;
            throw err;
          }
          const n = remaining.splice(idx, 1)[0];
          db.prepare(`
            INSERT INTO chat_nodes (
              id, chat_id, parent_id, role, content, thinking,
              model_id, provider_id, version, previous_version_id, is_current,
              attachments, chat_parameters_id, prompt_tokens, completion_tokens,
              total_cost, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            idMap.get(n.id),
            newChatId,
            remap(n.parent_id),
            n.role,
            n.content ?? '',
            n.thinking ?? null,
            n.model_id ?? null,
            n.provider_id ?? null,
            n.version ?? 1,
            remap(n.previous_version_id),
            n.is_current ? 1 : 0,
            n.attachments || '[]',
            n.chat_parameters_id || null,
            n.prompt_tokens ?? null,
            n.completion_tokens ?? null,
            n.total_cost ?? null,
            n.created_at,
            n.updated_at ?? null
          );
          inserted.add(n.id);
        }

        return db.prepare('SELECT * FROM chats WHERE id = ?').get(newChatId);
      })();

      res.status(201).json(mapChat(cloned));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
};
