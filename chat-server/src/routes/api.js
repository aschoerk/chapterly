const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// ---------- Providers ----------

// GET /api/providers
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

// POST /api/providers
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

// PUT /api/providers/:id
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

// DELETE /api/providers/:id
router.delete('/providers/:id', (req, res) => {
  const result = db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  res.status(204).end();
});

// ---------- Models ----------

// GET /api/models
router.get('/models', (req, res) => {
  const rows = db.prepare('SELECT * FROM models ORDER BY enabled DESC, display_name').all();
  res.json(rows.map(row => ({
    id: row.id,
    displayName: row.display_name,
    modelId: row.model_id,
    providerId: row.provider_id,
    type: row.type,
    enabled: !!row.enabled,
    contextLength: row.context_length
  })));
});

// POST /api/models  (mainly for presets)
router.post('/models', (req, res) => {
  const { displayName, modelId, providerId, type = 'preset', enabled = true, contextLength } = req.body;

  if (!displayName || !modelId || !providerId) {
    return res.status(400).json({ error: 'displayName, modelId and providerId are required' });
  }

  const id = uuidv4();

  db.prepare(`
    INSERT INTO models (id, display_name, model_id, provider_id, type, enabled, context_length)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, displayName, modelId, providerId, type, enabled ? 1 : 0, contextLength || null);

  res.status(201).json({
    id,
    displayName,
    modelId,
    providerId,
    type,
    enabled,
    contextLength
  });
});

// DELETE /api/models/:id
router.delete('/models/:id', (req, res) => {
  const result = db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Model not found' });
  }
  res.status(204).end();
});

// PATCH /api/models/:id/toggle
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
