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

const { mapContentClient, mapProviderClient } = require('../clients');
const {
  listContentAuthorizations,
  listProviderAuthorizations
} = require('../oauth');

function enforceSelf(req, res) {
  if (!req.auth) return false;
  if (req.auth.userId !== req.params.id) {
    res.status(403).json({ error: 'token is not valid for this user' });
    return true;
  }
  return false;
}

function mapProvider(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    enabled: !!row.enabled,
    walletId: row.wallet_id || null
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
    workspaceId: row.workspace_id || null,
    defaultProjectId: row.default_project_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * @openapi
 * /api/users:
 *   get:
 *     summary: List users
 *     description: |
 *       Optional Bearer. With a token, only the authenticated identity is returned.
 *       Without a token, all users (password hashes omitted).
 *     tags:
 *       - Users
 *     security:
 *       - {}
 *       - BearerAuth: []
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
router.get('/', (req, res) => {
  if (req.auth) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);
    return res.json(row ? [mapUser(row)] : []);
  }
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
 *       Returns the user record only. To obtain an opaque access token with claims,
 *       use POST /api/oauth/token. No OIDC yet.
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
  if (enforceSelf(req, res)) return;
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
  if (enforceSelf(req, res)) return;
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
 *       OAuth authorizations for this identity are removed.
 *       Clients, topics and providers remain.
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
  if (enforceSelf(req, res)) return;
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
 *     summary: List topics owned through this user's content clients
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
  if (enforceSelf(req, res)) return;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const rows = db.prepare(`
    SELECT DISTINCT t.* FROM topics t
    JOIN workspace_authorizations a ON a.workspace_id = t.workspace_id
    WHERE a.user_id = ? AND a.status = 'granted'
    ORDER BY t.name
  `).all(req.params.id);
  res.json(rows.map(mapTopic));
});

/**
 * @openapi
 * /api/users/{id}/content-clients:
 *   get:
 *     summary: List content clients linked to this identity
 *     tags:
 *       - Users
 */
router.get('/:id/workspaces', (req, res) => {
  if (enforceSelf(req, res)) return;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const rows = db.prepare(`
    SELECT c.* FROM workspaces c
    JOIN workspace_authorizations a ON a.workspace_id = c.id
    WHERE a.user_id = ? AND a.status = 'granted'
    ORDER BY c.created_at
  `).all(req.params.id);
  res.json(rows.map(mapContentClient));
});

router.get('/:id/content-authorizations', (req, res) => {
  if (enforceSelf(req, res)) return;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(listContentAuthorizations({ userId: req.params.id }));
});

/**
 * @openapi
 * /api/users/{id}/providers:
 *   get:
 *     summary: List providers owned through this user's provider clients
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
  if (enforceSelf(req, res)) return;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const rows = db.prepare(`
    SELECT DISTINCT p.* FROM providers p
    JOIN wallet_authorizations a ON a.wallet_id = p.wallet_id
    WHERE a.user_id = ? AND a.status = 'granted'
    ORDER BY p.created_at
  `).all(req.params.id);
  res.json(rows.map(mapProvider));
});

/**
 * @openapi
 * /api/users/{id}/provider-clients:
 *   get:
 *     summary: List provider clients linked to this identity
 *     tags:
 *       - Users
 */
router.get('/:id/wallets', (req, res) => {
  if (enforceSelf(req, res)) return;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const rows = db.prepare(`
    SELECT c.* FROM wallets c
    JOIN wallet_authorizations a ON a.wallet_id = c.id
    WHERE a.user_id = ? AND a.status = 'granted'
    ORDER BY c.created_at
  `).all(req.params.id);
  res.json(rows.map(mapProviderClient));
});

router.get('/:id/provider-authorizations', (req, res) => {
  if (enforceSelf(req, res)) return;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(listProviderAuthorizations({ userId: req.params.id }));
});

module.exports = router;
