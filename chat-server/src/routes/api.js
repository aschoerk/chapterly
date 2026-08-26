const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// ---------- Providers ----------

/**
 * @openapi
 * /api/providers:
 *   get:
 *     summary: List all providers
 *     tags:
 *       - Providers
 *     responses:
 *       200:
 *         description: List of providers
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Provider'
 */
router.get('/providers', (req, res) => {
  const rows = db.prepare('SELECT * FROM providers ORDER BY created_at').all();
  res.json(rows.map(row => ({
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    enabled: !!row.enabled
  })));
});

/**
 * @openapi
 * /api/providers:
 *   post:
 *     summary: Create a new provider
 *     tags:
 *       - Providers
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, baseUrl, apiKey]
 *             properties:
 *               name:
 *                 type: string
 *                 example: OpenRouter
 *               type:
 *                 type: string
 *                 example: openrouter
 *               baseUrl:
 *                 type: string
 *                 example: https://openrouter.ai/api/v1
 *               apiKey:
 *                 type: string
 *               enabled:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       201:
 *         description: Provider created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Provider'
 *       400:
 *         description: Missing required fields
 */
router.post('/providers', (req, res) => {
  const { name, type, baseUrl, apiKey, enabled = true } = req.body;

  if (!name || !baseUrl || !apiKey) {
    return res.status(400).json({ error: 'name, baseUrl and apiKey are required' });
  }

  const id = uuidv4();

  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, api_key, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, type || 'custom', baseUrl, apiKey, enabled ? 1 : 0);

  res.status(201).json({ id, name, type: type || 'custom', baseUrl, apiKey, enabled });
});

/**
 * @openapi
 * /api/providers/{id}:
 *   put:
 *     summary: Update a provider
 *     tags:
 *       - Providers
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *               baseUrl:
 *                 type: string
 *               apiKey:
 *                 type: string
 *               enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Provider updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Provider'
 *       404:
 *         description: Provider not found
 */
router.put('/providers/:id', (req, res) => {
  const { id } = req.params;
  const { name, type, baseUrl, apiKey, enabled } = req.body;

  const result = db.prepare(`
    UPDATE providers
    SET name = COALESCE(?, name),
        type = COALESCE(?, type),
        base_url = COALESCE(?, base_url),
        api_key = COALESCE(?, api_key),
        enabled = COALESCE(?, enabled)
    WHERE id = ?
  `).run(name, type, baseUrl, apiKey, enabled === undefined ? null : (enabled ? 1 : 0), id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Provider not found' });
  }

  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
  res.json({
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    enabled: !!row.enabled
  });
});

/**
 * @openapi
 * /api/providers/{id}:
 *   delete:
 *     summary: Delete a provider
 *     tags:
 *       - Providers
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Provider deleted
 *       404:
 *         description: Provider not found
 */
router.delete('/providers/:id', (req, res) => {
  const result = db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  res.status(204).end();
});

// ---------- Models ----------

function parseCatalog(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function extractCatalog(body = {}) {
  const catalog = body.catalog && typeof body.catalog === 'object'
    ? body.catalog
    : {};

  // Accept both nested catalog and flattened ModelEntry fields
  const merged = {
    object: body.object ?? catalog.object,
    created: body.created ?? catalog.created,
    ownedBy: body.ownedBy ?? catalog.ownedBy,
    shutdownDate: body.shutdownDate ?? catalog.shutdownDate ?? null,
    canonicalSlug: body.canonicalSlug ?? catalog.canonicalSlug,
    description: body.description ?? catalog.description,
    architecture: body.architecture ?? catalog.architecture,
    pricing: body.pricing ?? catalog.pricing,
    topProvider: body.topProvider ?? catalog.topProvider,
    supportedParameters: body.supportedParameters
      ?? body.supported_parameters
      ?? catalog.supportedParameters,
    reasoning: body.reasoning ?? catalog.reasoning,
    knowledgeCutoff: body.knowledgeCutoff ?? catalog.knowledgeCutoff ?? null,
    expirationDate: body.expirationDate ?? catalog.expirationDate ?? null,
    perRequestLimits: body.perRequestLimits ?? catalog.perRequestLimits ?? null,
    pricing_prompt: body.pricing_prompt
      ?? catalog.pricing_prompt
      ?? body.pricing?.prompt
      ?? catalog.pricing?.prompt,
    pricing_completion: body.pricing_completion
      ?? catalog.pricing_completion
      ?? body.pricing?.completion
      ?? catalog.pricing?.completion,
    pricing_input_cache_read: body.pricing_input_cache_read
      ?? catalog.pricing_input_cache_read
      ?? body.pricing?.input_cache_read
      ?? catalog.pricing?.input_cache_read
  };

  // Drop undefined so SQLite does not store noise
  return Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined)
  );
}

function mapModelRow(row) {
  const catalog = parseCatalog(row.catalog_json);
  return {
    id: row.id,
    displayName: row.display_name,
    modelId: row.model_id,
    providerId: row.provider_id,
    type: row.type,
    enabled: !!row.enabled,
    contextLength: row.context_length,
    description: catalog.description ?? '',
    architecture: catalog.architecture,
    pricing: catalog.pricing,
    topProvider: catalog.topProvider,
    supportedParameters: catalog.supportedParameters ?? catalog.supported_parameters ?? [],
    supported_parameters: catalog.supportedParameters ?? catalog.supported_parameters ?? [],
    reasoning: catalog.reasoning,
    created: catalog.created,
    ownedBy: catalog.ownedBy,
    shutdownDate: catalog.shutdownDate ?? null,
    canonicalSlug: catalog.canonicalSlug,
    knowledgeCutoff: catalog.knowledgeCutoff ?? null,
    expirationDate: catalog.expirationDate ?? null,
    perRequestLimits: catalog.perRequestLimits ?? null,
    pricing_prompt: catalog.pricing_prompt ?? catalog.pricing?.prompt,
    pricing_completion: catalog.pricing_completion ?? catalog.pricing?.completion,
    pricing_input_cache_read: catalog.pricing_input_cache_read ?? catalog.pricing?.input_cache_read
  };
}

/**
 * @openapi
 * /api/models:
 *   get:
 *     summary: List all models
 *     tags:
 *       - Models
 *     responses:
 *       200:
 *         description: List of models
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Model'
 */
router.get('/models', (req, res) => {
  const rows = db.prepare('SELECT * FROM models ORDER BY enabled DESC, display_name').all();
  res.json(rows.map(mapModelRow));
});

/**
 * @openapi
 * /api/models:
 *   post:
 *     summary: Create a model / preset
 *     tags:
 *       - Models
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [displayName, modelId, providerId]
 *             properties:
 *               displayName:
 *                 type: string
 *               modelId:
 *                 type: string
 *               providerId:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [fetched, preset, discontinued]
 *                 default: preset
 *               enabled:
 *                 type: boolean
 *                 default: true
 *               contextLength:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Model created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Model'
 *       400:
 *         description: Missing required fields
 */
router.post('/models', (req, res) => {
  const {
    displayName,
    modelId,
    providerId,
    type = 'preset',
    enabled = true,
    contextLength
  } = req.body;

  if (!displayName || !modelId || !providerId) {
    return res.status(400).json({ error: 'displayName, modelId and providerId are required' });
  }

  const id = uuidv4();
  const catalog = extractCatalog(req.body);

  db.prepare(`
    INSERT INTO models (id, display_name, model_id, provider_id, type, enabled, context_length, catalog_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    displayName,
    modelId,
    providerId,
    type,
    enabled ? 1 : 0,
    contextLength ?? null,
    Object.keys(catalog).length ? JSON.stringify(catalog) : null
  );

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  res.status(201).json(mapModelRow(row));
});

router.put('/models/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const nextDisplayName = req.body.displayName ?? existing.display_name;
  const nextModelId = req.body.modelId ?? existing.model_id;
  const nextType = req.body.type ?? existing.type;
  const nextEnabled = req.body.enabled === undefined
    ? existing.enabled
    : (req.body.enabled ? 1 : 0);
  const nextContext = req.body.contextLength === undefined
    ? existing.context_length
    : req.body.contextLength;

  const incomingCatalog = extractCatalog(req.body);
  const previousCatalog = parseCatalog(existing.catalog_json);
  const catalog = Object.keys(incomingCatalog).length
    ? { ...previousCatalog, ...incomingCatalog }
    : previousCatalog;

  db.prepare(`
    UPDATE models
    SET display_name = ?,
        model_id = ?,
        type = ?,
        enabled = ?,
        context_length = ?,
        catalog_json = ?
    WHERE id = ?
  `).run(
    nextDisplayName,
    nextModelId,
    nextType,
    nextEnabled,
    nextContext ?? null,
    Object.keys(catalog).length ? JSON.stringify(catalog) : null,
    id
  );

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  res.json(mapModelRow(row));
});

/**
 * @openapi
 * /api/models/{id}:
 *   delete:
 *     summary: Delete a model
 *     tags:
 *       - Models
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Model deleted
 *       404:
 *         description: Model not found
 */
router.delete('/models/:id', (req, res) => {
  const result = db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Model not found' });
  }
  res.status(204).end();
});

/**
 * @openapi
 * /api/models/{id}/toggle:
 *   patch:
 *     summary: Toggle enabled state of a model
 *     tags:
 *       - Models
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: New enabled state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 enabled:
 *                   type: boolean
 *       404:
 *         description: Model not found
 */
router.patch('/models/:id/toggle', (req, res) => {
  const row = db.prepare('SELECT enabled FROM models WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const newEnabled = row.enabled ? 0 : 1;
  db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(newEnabled, req.params.id);

  res.json({ id: req.params.id, enabled: !!newEnabled });
});

module.exports = router;
