const express = require('express');
const db = require('../db');
const {
  mapChatParameters,
  insertChatParameters,
  updateChatParameters,
  listOwners,
  findByOwner,
  OWNER_TABLES
} = require('../chatParameters');

const router = express.Router();

/**
 * @openapi
 * /api/chat-parameters:
 *   get:
 *     summary: List chat parameter sets
 *     description: |
 *       Reusable generation settings (OpenAI-compatible extensions):
 *       temperature, top_k, top_m / top_p, stream, thinking and thinkingLevel
 *       (reasoning_effort). Filter by owner with ownerType + ownerId.
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: query
 *         name: ownerType
 *         schema:
 *           type: string
 *           enum: [model, topic, project, chat, chat_node]
 *       - in: query
 *         name: ownerId
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Parameter sets
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ChatParameters'
 *       400:
 *         description: Invalid ownerType
 */
router.get('/', (req, res) => {
  const { ownerType, ownerId } = req.query;

  if (ownerType || ownerId) {
    if (!ownerType || !ownerId) {
      return res.status(400).json({ error: 'ownerType and ownerId must be provided together' });
    }
    if (!OWNER_TABLES[ownerType]) {
      return res.status(400).json({
        error: 'ownerType must be one of model, topic, project, chat, chat_node'
      });
    }
    const row = findByOwner(ownerType, ownerId);
    return res.json(row ? [mapChatParameters(row)] : []);
  }

  const rows = db.prepare(`
    SELECT * FROM chat_parameters ORDER BY updated_at DESC
  `).all();
  res.json(rows.map(mapChatParameters));
});

/**
 * @openapi
 * /api/chat-parameters:
 *   post:
 *     summary: Create a chat parameter set
 *     tags:
 *       - ChatParameters
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatParametersInput'
 *     responses:
 *       201:
 *         description: Created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatParameters'
 */
router.post('/', (req, res) => {
  const row = insertChatParameters(req.body || {});
  res.status(201).json(mapChatParameters(row));
});

/**
 * @openapi
 * /api/chat-parameters/{id}:
 *   get:
 *     summary: Get a chat parameter set
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatParameters'
 *       404:
 *         description: Not found
 */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM chat_parameters WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat parameters not found' });
  res.json(mapChatParameters(row));
});

/**
 * @openapi
 * /api/chat-parameters/{id}/owners:
 *   get:
 *     summary: List entities that own this parameter set
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Owners referring this parameter set
 *       404:
 *         description: Not found
 */
router.get('/:id/owners', (req, res) => {
  const row = db.prepare('SELECT id FROM chat_parameters WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chat parameters not found' });
  res.json(listOwners(req.params.id));
});

/**
 * @openapi
 * /api/chat-parameters/{id}:
 *   put:
 *     summary: Replace or update a chat parameter set
 *     tags:
 *       - ChatParameters
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
 *             $ref: '#/components/schemas/ChatParametersInput'
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatParameters'
 *       404:
 *         description: Not found
 */
router.put('/:id', (req, res) => {
  const row = updateChatParameters(req.params.id, req.body || {});
  if (!row) return res.status(404).json({ error: 'Chat parameters not found' });
  res.json(mapChatParameters(row));
});

/**
 * @openapi
 * /api/chat-parameters/{id}:
 *   patch:
 *     summary: Partially update a chat parameter set
 *     tags:
 *       - ChatParameters
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
 *             $ref: '#/components/schemas/ChatParametersInput'
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatParameters'
 *       404:
 *         description: Not found
 */
router.patch('/:id', (req, res) => {
  const row = updateChatParameters(req.params.id, req.body || {});
  if (!row) return res.status(404).json({ error: 'Chat parameters not found' });
  res.json(mapChatParameters(row));
});

/**
 * @openapi
 * /api/chat-parameters/{id}:
 *   delete:
 *     summary: Delete a chat parameter set
 *     description: |
 *       Owners (models, topics, projects, chats, chat_nodes) keep their rows.
 *       Their chatParametersId is set to null via ON DELETE SET NULL.
 *     tags:
 *       - ChatParameters
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM chat_parameters WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Chat parameters not found' });
  }
  res.status(204).end();
});

module.exports = router;
