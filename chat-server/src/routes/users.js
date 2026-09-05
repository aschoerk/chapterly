const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const {
  mapUser,
  hashPassword,
  verifyPassword,
  findUserByLogin,
  findConflictingUser,
  normalizeOptional
} = require('../users');

const router = express.Router();

function mapProvider(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    enabled: !!row.enabled,
    userId: row.user_id || null
  };
}

function mapTopic(row) {
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
    userId: row.user_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * @openapi
 * /api/users:
 *   get:
 *     summary: List all users
 *     tags:
 *       - Users
 *     responses:
 *       200:
 *         description: Array of users (password hashes are never returned)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 */
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  res.json(rows.map(mapUser));
});

/**
 * @openapi
 * /api/users:
 *   post:
 *     summary: Create a user (local client account)
 *     description: |
 *       Stores the password with Argon2id. Email and phone number are optional.
 *       No OIDC / federated identity is involved.
 *     tags:
 *       - Users
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserCreate'
 *     responses:
 *       201:
 *         description: User created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Validation error
 *       409:
 *         description: Username, email or phone already in use
 */
router.post('/', async (req, res) => {
  const username = normalizeOptional(req.body.username);
  const email = normalizeOptional(req.body.email);
  const phoneNumber = normalizeOptional(req.body.phoneNumber ?? req.body.phone_number);
  const password = req.body.password;

  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 1) {
    return res.status(400).json({ error: 'password is required' });
  }

  const conflict = findConflictingUser({ username, email, phoneNumber });
  if (conflict) {
    return res.status(409).json({ error: `${conflict.field} already in use` });
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);

  db.prepare(`
    INSERT INTO users (id, username, email, phone_number, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, username, email, phoneNumber, passwordHash, now, now);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json(mapUser(row));
});

/**
 * @openapi
 * /api/users/login:
 *   post:
 *     summary: Verify local credentials
 *     description: |
 *       Accepts username, email or phoneNumber plus password.
 *       On success returns the user record. No session or OIDC token is issued yet.
 *     tags:
 *       - Users
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserLogin'
 *     responses:
 *       200:
 *         description: Credentials accepted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Missing fields
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', async (req, res) => {
  const username = normalizeOptional(req.body.username);
  const email = normalizeOptional(req.body.email);
  const phoneNumber = normalizeOptional(req.body.phoneNumber ?? req.body.phone_number);
  const password = req.body.password;

  if (!password) {
    return res.status(400).json({ error: 'password is required' });
  }
  if (!username && !email && !phoneNumber) {
    return res.status(400).json({ error: 'username, email or phoneNumber is required' });
  }

  const row = findUserByLogin({ username, email, phoneNumber });
  if (!row) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = await verifyPassword(row.password_hash, password);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json(mapUser(row));
});

/**
 * @openapi
 * /api/users/{id}:
 *   get:
 *     summary: Get a user by ID
 *     tags:
 *       - Users
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: User found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       404:
 *         description: User not found
 */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json(mapUser(row));
});

/**
 * @openapi
 * /api/users/{id}:
 *   put:
 *     summary: Update a user
 *     tags:
 *       - Users
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
 *             $ref: '#/components/schemas/UserUpdate'
 *     responses:
 *       200:
 *         description: User updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       404:
 *         description: User not found
 *       409:
 *         description: Username, email or phone already in use
 */
router.put('/:id', async (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const username = req.body.username !== undefined
    ? normalizeOptional(req.body.username)
    : existing.username;
  const email = req.body.email !== undefined
    ? normalizeOptional(req.body.email)
    : existing.email;
  const phoneNumber = (req.body.phoneNumber !== undefined || req.body.phone_number !== undefined)
    ? normalizeOptional(req.body.phoneNumber ?? req.body.phone_number)
    : existing.phone_number;

  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  const conflict = findConflictingUser({
    username,
    email,
    phoneNumber,
    excludeId: existing.id
  });
  if (conflict) {
    return res.status(409).json({ error: `${conflict.field} already in use` });
  }

  let passwordHash = existing.password_hash;
  if (req.body.password !== undefined) {
    if (!req.body.password || typeof req.body.password !== 'string') {
      return res.status(400).json({ error: 'password must be a non-empty string' });
    }
    passwordHash = await hashPassword(req.body.password);
  }

  db.prepare(`
    UPDATE users
    SET username = ?,
        email = ?,
        phone_number = ?,
        password_hash = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(username, email, phoneNumber, passwordHash, existing.id);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  res.json(mapUser(row));
});

/**
 * @openapi
 * /api/users/{id}:
 *   delete:
 *     summary: Delete a user
 *     description: |
 *       Owned topics and providers keep existing rows; their user_id is set to NULL
 *       (ON DELETE SET NULL) so unscoped clients continue to see that data.
 *     tags:
 *       - Users
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: User deleted
 *       404:
 *         description: User not found
 */
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.status(204).end();
});

/**
 * @openapi
 * /api/users/{id}/topics:
 *   get:
 *     summary: List topics owned by a user
 *     tags:
 *       - Users
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Topics owned by the user
 *       404:
 *         description: User not found
 */
router.get('/:id/topics', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const rows = db.prepare(
    'SELECT * FROM topics WHERE user_id = ? ORDER BY name'
  ).all(req.params.id);
  res.json(rows.map(mapTopic));
});

/**
 * @openapi
 * /api/users/{id}/providers:
 *   get:
 *     summary: List providers owned by a user
 *     tags:
 *       - Users
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Providers owned by the user
 *       404:
 *         description: User not found
 */
router.get('/:id/providers', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const rows = db.prepare(
    'SELECT * FROM providers WHERE user_id = ? ORDER BY created_at'
  ).all(req.params.id);
  res.json(rows.map(mapProvider));
});

module.exports = router;
