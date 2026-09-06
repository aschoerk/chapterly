const { v4: uuidv4 } = require('uuid');

const FALLBACK_TOPIC_NAME = 'General';
const DEFAULT_PROJECT_NAME = 'Unassigned';

let dbInstance = null;

function setDb(db) {
  dbInstance = db;
}

function db() {
  if (!dbInstance) {
    dbInstance = require('./db');
  }
  return dbInstance;
}

function topicIdsOfProject(projectId) {
  if (!projectId) return [];
  return db()
    .prepare('SELECT topic_id FROM topic_projects WHERE project_id = ? ORDER BY topic_id')
    .all(projectId)
    .map(r => r.topic_id);
}

function attachProjectToTopic(topicId, projectId) {
  db().prepare(
    'INSERT OR IGNORE INTO topic_projects (topic_id, project_id) VALUES (?, ?)'
  ).run(topicId, projectId);
}

function createDefaultProject(topicId) {
  const topic = db().prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  const id = uuidv4();
  const now = new Date().toISOString();
  const name = topic && topic.name && topic.name !== FALLBACK_TOPIC_NAME
    ? `${DEFAULT_PROJECT_NAME}`
    : DEFAULT_PROJECT_NAME;

  db().prepare(`
    INSERT INTO projects (id, name, greeting, system_prompt, default_model_id, avatar, persona_ids, is_default, created_at, updated_at)
    VALUES (?, ?, '', '', NULL, '', '[]', 1, ?, ?)
  `).run(id, name, now, now);

  attachProjectToTopic(topicId, id);
  db().prepare(`
    UPDATE topics SET default_project_id = ?, updated_at = datetime('now') WHERE id = ?
  `).run(id, topicId);

  return id;
}

function ensureTopicDefaultProject(topicId) {
  const topic = db().prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  if (!topic) return null;

  if (topic.default_project_id) {
    const existing = db().prepare('SELECT id FROM projects WHERE id = ?').get(topic.default_project_id);
    if (existing) {
      attachProjectToTopic(topicId, existing.id);
      return existing.id;
    }
  }

  const marked = db().prepare(`
    SELECT p.id
    FROM projects p
    JOIN topic_projects tp ON tp.project_id = p.id
    WHERE tp.topic_id = ? AND p.is_default = 1
    ORDER BY p.created_at
    LIMIT 1
  `).get(topicId);
  if (marked) {
    db().prepare('UPDATE topics SET default_project_id = ? WHERE id = ?').run(marked.id, topicId);
    return marked.id;
  }

  const named = db().prepare(`
    SELECT p.id
    FROM projects p
    JOIN topic_projects tp ON tp.project_id = p.id
    WHERE tp.topic_id = ? AND p.name = ?
    ORDER BY p.created_at
    LIMIT 1
  `).get(topicId, DEFAULT_PROJECT_NAME);
  if (named) {
    db().prepare('UPDATE projects SET is_default = 1 WHERE id = ?').run(named.id);
    db().prepare('UPDATE topics SET default_project_id = ? WHERE id = ?').run(named.id, topicId);
    return named.id;
  }

  return createDefaultProject(topicId);
}

function ensureFallbackTopic() {
  const existing = db().prepare(
    'SELECT * FROM topics WHERE name = ? ORDER BY created_at LIMIT 1'
  ).get(FALLBACK_TOPIC_NAME);

  if (existing) {
    ensureTopicDefaultProject(existing.id);
    return existing;
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  db().prepare(`
    INSERT INTO topics (id, name, description, default_model_id, default_system_prompt, icon, created_at, updated_at)
    VALUES (?, ?, ?, NULL, '', '', ?, ?)
  `).run(
    id,
    FALLBACK_TOPIC_NAME,
    'Fallback topic for projects and chats that need a home',
    now,
    now
  );

  ensureTopicDefaultProject(id);
  return db().prepare('SELECT * FROM topics WHERE id = ?').get(id);
}

function ensureProjectHasTopic(projectId) {
  if (!projectId) return null;
  const ids = topicIdsOfProject(projectId);
  if (ids.length) return ids[0];
  const fallback = ensureFallbackTopic();
  attachProjectToTopic(fallback.id, projectId);
  return fallback.id;
}

function resolveTopicIdForProject(projectId) {
  if (!projectId) return ensureFallbackTopic().id;
  const ids = topicIdsOfProject(projectId);
  if (ids.length) return ids[0];
  return ensureProjectHasTopic(projectId);
}

function resolveUnassignProjectId(fromProjectId) {
  const topicId = resolveTopicIdForProject(fromProjectId);
  const inboxId = ensureTopicDefaultProject(topicId);
  return inboxId;
}

function assertProjectExists(projectId) {
  if (!projectId) return false;
  return !!db().prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
}

function resolveRequiredProjectId(requestedProjectId, previousProjectId = null) {
  if (requestedProjectId) {
    if (!assertProjectExists(requestedProjectId)) return { error: 'projectId does not exist' };
    ensureProjectHasTopic(requestedProjectId);
    return { projectId: requestedProjectId };
  }
  return { projectId: resolveUnassignProjectId(previousProjectId) };
}

function rehomeChatsFromProject(projectId) {
  const targetId = resolveUnassignProjectId(projectId);
  if (!targetId || targetId === projectId) {
    const topicId = resolveTopicIdForProject(projectId);
    db().prepare('UPDATE topics SET default_project_id = NULL WHERE default_project_id = ?').run(projectId);
    db().prepare('UPDATE projects SET is_default = 0 WHERE id = ?').run(projectId);
    const replacement = createDefaultProject(topicId);
    db().prepare(`
      UPDATE chats SET project_id = ?, updated_at = datetime('now')
      WHERE project_id = ?
    `).run(replacement, projectId);
    return replacement;
  }

  db().prepare(`
    UPDATE chats SET project_id = ?, updated_at = datetime('now')
    WHERE project_id = ?
  `).run(targetId, projectId);
  return targetId;
}

function rehomeOrphanProjects() {
  const orphans = db().prepare(`
    SELECT p.id
    FROM projects p
    WHERE NOT EXISTS (
      SELECT 1 FROM topic_projects tp WHERE tp.project_id = p.id
    )
  `).all();
  for (const row of orphans) {
    ensureProjectHasTopic(row.id);
  }
}

function rehomeOrphanChats() {
  const orphans = db().prepare('SELECT id, project_id FROM chats WHERE project_id IS NULL').all();
  if (!orphans.length) return;
  const fallbackProjectId = resolveUnassignProjectId(null);
  for (const row of orphans) {
    db().prepare('UPDATE chats SET project_id = ? WHERE id = ?').run(fallbackProjectId, row.id);
  }
}

function backfillAssignmentInvariants() {
  const topics = db().prepare('SELECT id FROM topics').all();
  for (const topic of topics) {
    ensureTopicDefaultProject(topic.id);
  }
  rehomeOrphanProjects();
  rehomeOrphanChats();
}

module.exports = {
  setDb,
  FALLBACK_TOPIC_NAME,
  DEFAULT_PROJECT_NAME,
  topicIdsOfProject,
  attachProjectToTopic,
  ensureTopicDefaultProject,
  ensureFallbackTopic,
  ensureProjectHasTopic,
  resolveTopicIdForProject,
  resolveUnassignProjectId,
  assertProjectExists,
  resolveRequiredProjectId,
  rehomeChatsFromProject,
  rehomeOrphanProjects,
  rehomeOrphanChats,
  backfillAssignmentInvariants
};
