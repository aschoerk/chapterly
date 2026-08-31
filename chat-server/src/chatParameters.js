const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const THINKING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high'];

const OWNER_TABLES = {
  model: { table: 'models', idColumn: 'id', type: 'model' },
  topic: { table: 'topics', idColumn: 'id', type: 'topic' },
  project: { table: 'projects', idColumn: 'id', type: 'project' },
  chat: { table: 'chats', idColumn: 'id', type: 'chat' },
  chat_node: { table: 'chat_nodes', idColumn: 'id', type: 'chat_node' }
};

function toBoolOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  }
  return Boolean(value);
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeThinkingLevel(value) {
  if (value === undefined || value === null || value === '') return null;
  const level = String(value).trim().toLowerCase();
  if (THINKING_LEVELS.includes(level)) return level;
  const aliases = {
    off: 'none',
    disabled: 'none',
    min: 'minimal',
    med: 'medium',
    max: 'high',
    default: 'medium'
  };
  return aliases[level] || null;
}

function parseChatParametersInput(body = {}) {
  const nested = body.chatParameters && typeof body.chatParameters === 'object'
    ? body.chatParameters
    : body;

  const temperature = toNumberOrNull(
    nested.temperature ?? nested.Temperature
  );
  const topK = toNumberOrNull(
    nested.topK ?? nested.top_k
  );
  // OpenAI uses top_p; this schema stores it as top_m and accepts both names.
  const topM = toNumberOrNull(
    nested.topM ?? nested.top_m ?? nested.topP ?? nested.top_p
  );
  const stream = toBoolOrNull(nested.stream);
  const thinking = toBoolOrNull(
    nested.thinking ?? nested.reasoning ?? nested.includeThoughts
  );
  const thinkingLevel = normalizeThinkingLevel(
    nested.thinkingLevel
    ?? nested.thinking_level
    ?? nested.reasoningEffort
    ?? nested.reasoning_effort
    ?? nested.reasoning?.effort
  );

  const name = nested.name !== undefined
    ? String(nested.name)
    : undefined;

  return {
    name,
    temperature,
    topK,
    topM,
    stream,
    thinking,
    thinkingLevel
  };
}

function mapChatParameters(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || '',
    temperature: row.temperature ?? null,
    topK: row.top_k ?? null,
    topM: row.top_m ?? null,
    topP: row.top_m ?? null,
    stream: row.stream === null || row.stream === undefined ? null : !!row.stream,
    thinking: row.thinking === null || row.thinking === undefined ? null : !!row.thinking,
    thinkingLevel: row.thinking_level || null,
    reasoningEffort: row.thinking_level || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function insertChatParameters(input = {}) {
  const parsed = parseChatParametersInput(input);
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO chat_parameters (
      id, name, temperature, top_k, top_m, stream, thinking, thinking_level, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    parsed.name || '',
    parsed.temperature,
    parsed.topK,
    parsed.topM,
    parsed.stream === null ? null : (parsed.stream ? 1 : 0),
    parsed.thinking === null ? null : (parsed.thinking ? 1 : 0),
    parsed.thinkingLevel,
    now,
    now
  );
  return db.prepare('SELECT * FROM chat_parameters WHERE id = ?').get(id);
}

function updateChatParameters(id, body = {}) {
  const existing = db.prepare('SELECT * FROM chat_parameters WHERE id = ?').get(id);
  if (!existing) return null;

  const parsed = parseChatParametersInput(body);
  const nextName = parsed.name !== undefined ? parsed.name : existing.name;
  const nextTemperature = body.temperature !== undefined || body.chatParameters?.temperature !== undefined
    ? parsed.temperature
    : existing.temperature;
  const nextTopK = (body.topK !== undefined || body.top_k !== undefined || body.chatParameters?.topK !== undefined)
    ? parsed.topK
    : existing.top_k;
  const hasTopM = [
    body.topM, body.top_m, body.topP, body.top_p,
    body.chatParameters?.topM, body.chatParameters?.top_m,
    body.chatParameters?.topP, body.chatParameters?.top_p
  ].some(v => v !== undefined);
  const nextTopM = hasTopM ? parsed.topM : existing.top_m;
  const hasStream = body.stream !== undefined || body.chatParameters?.stream !== undefined;
  const nextStream = hasStream
    ? (parsed.stream === null ? null : (parsed.stream ? 1 : 0))
    : existing.stream;
  const hasThinking = [
    body.thinking, body.reasoning, body.includeThoughts,
    body.chatParameters?.thinking
  ].some(v => v !== undefined);
  const nextThinking = hasThinking
    ? (parsed.thinking === null ? null : (parsed.thinking ? 1 : 0))
    : existing.thinking;
  const hasLevel = [
    body.thinkingLevel, body.thinking_level, body.reasoningEffort, body.reasoning_effort,
    body.chatParameters?.thinkingLevel, body.reasoning?.effort
  ].some(v => v !== undefined);
  const nextLevel = hasLevel ? parsed.thinkingLevel : existing.thinking_level;

  db.prepare(`
    UPDATE chat_parameters
    SET name = ?,
        temperature = ?,
        top_k = ?,
        top_m = ?,
        stream = ?,
        thinking = ?,
        thinking_level = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    nextName || '',
    nextTemperature,
    nextTopK,
    nextTopM,
    nextStream,
    nextThinking,
    nextLevel,
    id
  );

  return db.prepare('SELECT * FROM chat_parameters WHERE id = ?').get(id);
}

/**
 * Resolve a chat_parameters id from a request body.
 * Accepts chatParametersId / chat_parameters_id, or a nested chatParameters object
 * which is inserted as a new row.
 */
function resolveChatParametersId(body = {}, previousId = undefined) {
  if (!body || typeof body !== 'object') return previousId ?? null;

  if (Object.prototype.hasOwnProperty.call(body, 'chatParametersId')) {
    return body.chatParametersId || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'chat_parameters_id')) {
    return body.chat_parameters_id || null;
  }
  if (body.chatParameters && typeof body.chatParameters === 'object') {
    if (body.chatParameters.id) return body.chatParameters.id;
    const created = insertChatParameters(body.chatParameters);
    return created.id;
  }
  return previousId ?? null;
}

function assertChatParametersExists(id) {
  if (!id) return true;
  const row = db.prepare('SELECT id FROM chat_parameters WHERE id = ?').get(id);
  return !!row;
}

function listOwners(parameterId) {
  const owners = [];
  for (const spec of Object.values(OWNER_TABLES)) {
    const rows = db.prepare(
      `SELECT ${spec.idColumn} AS id FROM ${spec.table} WHERE chat_parameters_id = ?`
    ).all(parameterId);
    for (const row of rows) {
      owners.push({ type: spec.type, id: row.id });
    }
  }
  return owners;
}

function findByOwner(ownerType, ownerId) {
  const spec = OWNER_TABLES[ownerType];
  if (!spec) return null;
  const row = db.prepare(
    `SELECT chat_parameters_id FROM ${spec.table} WHERE ${spec.idColumn} = ?`
  ).get(ownerId);
  if (!row || !row.chat_parameters_id) return null;
  return db.prepare('SELECT * FROM chat_parameters WHERE id = ?').get(row.chat_parameters_id);
}

module.exports = {
  THINKING_LEVELS,
  OWNER_TABLES,
  parseChatParametersInput,
  mapChatParameters,
  insertChatParameters,
  updateChatParameters,
  resolveChatParametersId,
  assertChatParametersExists,
  listOwners,
  findByOwner
};
