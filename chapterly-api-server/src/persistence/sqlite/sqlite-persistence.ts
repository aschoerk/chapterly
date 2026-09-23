import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { PersistencePort } from '../../domain/chat-api.port.js';
import type {
  Chat, ChatNode, ChatParameters, ChatParametersDraft, CreateNodeRequest, ModelEntry,
  NodeAttachment, Persona, Project, ProviderConfig, Topic,
} from '../../domain/models.js';
import type {
  BranchQuestionRequest, CreateModelRequest, CreatePersonaRequest, CreateProjectRequest,
  CreateProviderRequest, CreateTopicRequest, PatchChatRequest, PatchNodeRequest,
  ToggleModelResponse, UpdateModelRequest, UpdatePersonaRequest, UpdateProjectRequest,
  UpdateProviderRequest, UpdateTopicRequest,
} from '../../domain/requests.js';
import { badRequest, notFound } from '../../http/http-error.js';

type Row = Record<string, unknown>;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function now(): string { return new Date().toISOString(); }

function bool(value: unknown): boolean { return value === true || value === 1; }

function mapChat(row: Row): Chat {
  return { id: row.id as string, title: row.title as string, projectId: (row.project_id as string | null) ?? null,
    chatParametersId: (row.chat_parameters_id as string | null) ?? null, node_number: Number(row.node_number ?? 0),
    created_at: row.created_at as string, updated_at: row.updated_at as string };
}

function mapNode(row: Row): ChatNode {
  return { id: row.id as string, chatId: row.chat_id as string, parentId: (row.parent_id as string | null) ?? null,
    role: row.role as ChatNode['role'], content: row.content as string, thinking: (row.thinking as string | null) ?? null,
    modelId: (row.model_id as string | null) ?? null, providerId: (row.provider_id as string | null) ?? null,
    version: Number(row.version), previousVersionId: (row.previous_version_id as string | null) ?? null,
    isCurrent: bool(row.is_current), createdAt: row.created_at as string, updatedAt: (row.updated_at as string | null) ?? null,
    promptTokens: (row.prompt_tokens as number | null) ?? null, completionTokens: (row.completion_tokens as number | null) ?? null,
    attachments: json<NodeAttachment[]>(row.attachments, []), chatParametersId: (row.chat_parameters_id as string | null) ?? null };
}

function mapProject(row: Row, topicIds: string[]): Project {
  return { id: row.id as string, name: row.name as string, greeting: (row.greeting as string) ?? '',
    systemPrompt: (row.system_prompt as string) ?? '', defaultModelId: (row.default_model_id as string | null) ?? null,
    chatParametersId: (row.chat_parameters_id as string | null) ?? null, avatar: (row.avatar as string) ?? '',
    personaIds: json<string[]>(row.persona_ids, []), mainTopicId: (row.main_topic_id as string | null) ?? topicIds[0] ?? null,
    topicIds, createdAt: row.created_at as string, updatedAt: row.updated_at as string };
}

function mapTopic(row: Row, projectIds: string[]): Topic {
  return { id: row.id as string, name: row.name as string, description: (row.description as string) ?? '',
    defaultModelId: (row.default_model_id as string | null) ?? null, chatParametersId: (row.chat_parameters_id as string | null) ?? null,
    defaultSystemPrompt: (row.default_system_prompt as string) ?? '', icon: (row.icon as string) ?? '', projectIds,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string };
}

function mapPersona(row: Row): Persona {
  return { id: row.id as string, name: row.name as string, shortName: row.short_name as string,
    description: (row.description as string) ?? '', avatar: (row.avatar as string) ?? '',
    mainTopicId: (row.main_topic_id as string | null) ?? null, createdAt: row.created_at as string, updatedAt: row.updated_at as string };
}

function mapProvider(row: Row): ProviderConfig {
  return { id: row.id as string, name: row.name as string, type: row.type as ProviderConfig['type'],
    baseUrl: row.base_url as string, apiKey: row.api_key as string, enabled: bool(row.enabled) };
}

function mapModel(row: Row): ModelEntry {
  const catalog = json<Record<string, unknown>>(row.catalog_json, {});
  return { id: row.id as string, displayName: row.display_name as string, modelId: row.model_id as string,
    providerId: row.provider_id as string, type: row.type as ModelEntry['type'], enabled: bool(row.enabled),
    chatParametersId: (row.chat_parameters_id as string | null) ?? null, ...catalog } as ModelEntry;
}

function mapParameters(row: Row): ChatParameters {
  const thinkingLevel = (row.thinking_level as ChatParameters['thinkingLevel']) ?? null;
  return { id: row.id as string, name: (row.name as string) ?? '', temperature: (row.temperature as number | null) ?? null,
    topK: (row.top_k as number | null) ?? null, topM: (row.top_m as number | null) ?? null, topP: (row.top_p as number | null) ?? row.top_m as number | null,
    stream: row.stream == null ? null : bool(row.stream), thinking: row.thinking == null ? null : bool(row.thinking),
    thinkingLevel, reasoningEffort: thinkingLevel, createdAt: row.created_at as string, updatedAt: row.updated_at as string };
}

export class SqlitePersistence implements PersistencePort {
  readonly kind = 'sqlite' as const;
  private readonly db: Database.Database;

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
  }

  async init(): Promise<void> {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, greeting TEXT DEFAULT '', system_prompt TEXT DEFAULT '', default_model_id TEXT, avatar TEXT DEFAULT '', persona_ids TEXT DEFAULT '[]', main_topic_id TEXT, chat_parameters_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', default_model_id TEXT, chat_parameters_id TEXT, default_system_prompt TEXT DEFAULT '', icon TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topic_projects (topic_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(topic_id, project_id));
      CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, name TEXT NOT NULL, short_name TEXT NOT NULL, description TEXT DEFAULT '', avatar TEXT DEFAULT '', main_topic_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT, chat_parameters_id TEXT, node_number INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_nodes (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, thinking TEXT, model_id TEXT, provider_id TEXT, version INTEGER NOT NULL DEFAULT 1, previous_version_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, attachments TEXT DEFAULT '[]', is_current INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT, chat_parameters_id TEXT);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, enabled INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, model_id TEXT NOT NULL, provider_id TEXT NOT NULL, type TEXT NOT NULL, enabled INTEGER DEFAULT 1, catalog_json TEXT, chat_parameters_id TEXT);
      CREATE TABLE IF NOT EXISTS chat_parameters (id TEXT PRIMARY KEY, name TEXT DEFAULT '', temperature REAL, top_k INTEGER, top_m REAL, top_p REAL, stream INTEGER, thinking INTEGER, thinking_level TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_chat_nodes_chat_id ON chat_nodes(chat_id);
    `);
    this.addColumn('projects', 'main_topic_id', 'TEXT');
    this.addColumn('projects', 'chat_parameters_id', 'TEXT');
    this.addColumn('topics', 'chat_parameters_id', 'TEXT');
    this.addColumn('personas', 'main_topic_id', 'TEXT');
    this.addColumn('chats', 'chat_parameters_id', 'TEXT');
    this.addColumn('chat_nodes', 'thinking', 'TEXT');
    this.addColumn('chat_nodes', 'chat_parameters_id', 'TEXT');
    this.addColumn('models', 'catalog_json', 'TEXT');
    this.addColumn('models', 'chat_parameters_id', 'TEXT');
    this.addColumn('chat_parameters', 'top_p', 'REAL');
  }

  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((row) => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async close(): Promise<void> { this.db.close(); }

  private row(sql: string, ...args: unknown[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  private rows(sql: string, ...args: unknown[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
  private requireRow(entity: string, id: string, table: string): Row { const row = this.row(`SELECT * FROM ${table} WHERE id = ?`, id); if (!row) throw notFound(entity, id); return row; }
  private projectTopicIds(id: string): string[] { return this.rows('SELECT topic_id FROM topic_projects WHERE project_id = ? ORDER BY rowid', id).map((row) => row.topic_id as string); }
  private topicProjectIds(id: string): string[] { return this.rows('SELECT project_id FROM topic_projects WHERE topic_id = ? ORDER BY rowid', id).map((row) => row.project_id as string); }
  private project(row: Row): Project { return mapProject(row, this.projectTopicIds(row.id as string)); }
  private topic(row: Row): Topic { return mapTopic(row, this.topicProjectIds(row.id as string)); }
  private chat(id: string): Chat { return mapChat(this.requireRow('chat', id, 'chats')); }
  private node(chatId: string, nodeId: string): Row { const row = this.row('SELECT * FROM chat_nodes WHERE id = ? AND chat_id = ?', nodeId, chatId); if (!row) throw notFound('node', nodeId); return row; }

  async getProjects(): Promise<Project[]> { return this.rows('SELECT * FROM projects ORDER BY rowid').map((row) => this.project(row)); }
  async createProject(data: CreateProjectRequest): Promise<Project> {
    const id = randomUUID(); const ts = now(); const topicIds = [...new Set([...(data.mainTopicId ? [data.mainTopicId] : []), ...(data.topicId ? [data.topicId] : []), ...(data.topicIds ?? [])])];
    const insert = this.db.prepare('INSERT INTO projects (id,name,greeting,system_prompt,default_model_id,avatar,persona_ids,main_topic_id,chat_parameters_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const tx = this.db.transaction(() => { insert.run(id, data.name, data.greeting, data.systemPrompt ?? '', data.defaultModelId ?? null, data.avatar ?? '', JSON.stringify(data.personaIds ?? []), data.mainTopicId ?? topicIds[0] ?? null, data.chatParametersId ?? null, ts, ts); for (const topicId of topicIds) this.db.prepare('INSERT OR IGNORE INTO topic_projects(topic_id,project_id) VALUES(?,?)').run(topicId, id); }); tx();
    return this.project(this.requireRow('project', id, 'projects'));
  }
  async updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    const old = this.requireRow('project', id, 'projects'); const topicIds = data.topicIds ?? (data.topicId ? [data.topicId] : this.projectTopicIds(id));
    this.db.prepare('UPDATE projects SET name=?,greeting=?,system_prompt=?,default_model_id=?,avatar=?,persona_ids=?,main_topic_id=?,chat_parameters_id=?,updated_at=? WHERE id=?').run(data.name ?? old.name, data.greeting ?? old.greeting, data.systemPrompt ?? old.system_prompt, data.defaultModelId !== undefined ? data.defaultModelId : old.default_model_id, data.avatar ?? old.avatar, data.personaIds ? JSON.stringify(data.personaIds) : old.persona_ids, data.mainTopicId !== undefined ? data.mainTopicId : (topicIds[0] ?? old.main_topic_id), data.chatParametersId !== undefined ? data.chatParametersId : old.chat_parameters_id, now(), id);
    const tx = this.db.transaction(() => { this.db.prepare('DELETE FROM topic_projects WHERE project_id=?').run(id); for (const topicId of topicIds) this.db.prepare('INSERT OR IGNORE INTO topic_projects(topic_id,project_id) VALUES(?,?)').run(topicId, id); }); tx();
    return this.project(this.requireRow('project', id, 'projects'));
  }
  async deleteProject(id: string, deleteChats = false): Promise<void> { this.requireRow('project', id, 'projects'); const tx = this.db.transaction(() => { if (deleteChats) this.db.prepare('DELETE FROM chats WHERE project_id=?').run(id); else this.db.prepare('UPDATE chats SET project_id=NULL,updated_at=? WHERE project_id=?').run(now(), id); this.db.prepare('DELETE FROM topic_projects WHERE project_id=?').run(id); this.db.prepare('DELETE FROM projects WHERE id=?').run(id); }); tx(); }

  async getChats(): Promise<Chat[]> { return this.rows('SELECT * FROM chats ORDER BY rowid').map(mapChat); }
  async searchChatIds(q: string): Promise<string[]> { const needle = `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`; if (needle === '%%') return []; return this.rows("SELECT DISTINCT c.id FROM chats c LEFT JOIN chat_nodes n ON n.chat_id=c.id AND n.is_current=1 WHERE c.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\'", needle, needle).map((row) => row.id as string); }
  async createChat(title: string, projectId: string | null = null): Promise<Chat> { if (projectId) this.requireRow('project', projectId, 'projects'); const id = randomUUID(); const ts = now(); this.db.prepare('INSERT INTO chats(id,title,project_id,node_number,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, title, projectId, 0, ts, ts); return this.chat(id); }
  async cloneChat(chatId: string): Promise<Chat> { const source = this.chat(chatId); const id = randomUUID(); const ts = now(); const sourceNodes = this.rows('SELECT * FROM chat_nodes WHERE chat_id=? ORDER BY rowid', chatId); const ids = new Map(sourceNodes.map((row) => [row.id as string, randomUUID()])); const tx = this.db.transaction(() => { this.db.prepare('INSERT INTO chats SELECT ?, title || ?, project_id, chat_parameters_id, node_number, ?, ? FROM chats WHERE id=?').run(id, ' (copy)', ts, ts, chatId); const insert = this.db.prepare('INSERT INTO chat_nodes(id,chat_id,parent_id,role,content,thinking,model_id,provider_id,version,previous_version_id,prompt_tokens,completion_tokens,attachments,is_current,created_at,updated_at,chat_parameters_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'); for (const row of sourceNodes) insert.run(ids.get(row.id as string), id, row.parent_id ? ids.get(row.parent_id as string) ?? null : null, row.role, row.content, row.thinking, row.model_id, row.provider_id, row.version, row.previous_version_id ? ids.get(row.previous_version_id as string) ?? null : null, row.prompt_tokens, row.completion_tokens, row.attachments, row.is_current, ts, ts, row.chat_parameters_id); }); tx(); return this.chat(id); }
  async deleteChat(id: string): Promise<void> { this.chat(id); this.db.prepare('DELETE FROM chats WHERE id=?').run(id); }
  async patchChat(id: string, data: PatchChatRequest): Promise<Chat> { const old = this.chat(id); if (data.projectId) this.requireRow('project', data.projectId, 'projects'); this.db.prepare('UPDATE chats SET title=?,project_id=?,chat_parameters_id=?,updated_at=? WHERE id=?').run(data.title ?? old.title, data.projectId !== undefined ? data.projectId : old.projectId, data.chatParametersId !== undefined ? data.chatParametersId : old.chatParametersId, now(), id); return this.chat(id); }

  async getNodes(chatId: string): Promise<ChatNode[]> { this.chat(chatId); return this.rows('SELECT * FROM chat_nodes WHERE chat_id=? ORDER BY rowid', chatId).map(mapNode); }
  async createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> { this.chat(chatId); const id = randomUUID(); const ts = now(); this.db.prepare('INSERT INTO chat_nodes(id,chat_id,parent_id,role,content,thinking,model_id,provider_id,version,previous_version_id,is_current,created_at,updated_at,attachments,chat_parameters_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, chatId, data.parentId ?? null, data.role, data.content, data.thinking ?? null, data.modelId ?? null, data.providerId ?? null, 1, null, 1, ts, ts, JSON.stringify(data.attachments ?? []), data.chatParametersId ?? null); this.db.prepare('UPDATE chats SET node_number=node_number+1,updated_at=? WHERE id=?').run(ts, chatId); return mapNode(this.row('SELECT * FROM chat_nodes WHERE id=?', id) as Row); }
  async editAssistant(chatId: string, nodeId: string, content: string, attachments?: NodeAttachment[], thinking?: string): Promise<ChatNode> { return this.versionNode(chatId, nodeId, 'assistant', content, attachments, thinking); }
  async editUser(chatId: string, nodeId: string, content: string, attachments?: NodeAttachment[]): Promise<ChatNode> { return this.versionNode(chatId, nodeId, 'user', content, attachments); }
  async branchUser(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode> { const parent = this.node(chatId, nodeId); return this.createNode(chatId, { parentId: parent.parent_id as string | null, role: 'user', content: data.content, modelId: data.modelId, providerId: data.providerId, attachments: data.attachments }); }
  private versionNode(chatId: string, nodeId: string, expected: ChatNode['role'], content: string, attachments?: NodeAttachment[], thinking?: string): ChatNode { const old = this.node(chatId, nodeId); if (old.role !== 'system' && old.role !== expected) throw badRequest(`Only ${expected}s can be versioned this way`); const ts = now(); const oldAttachments = json<NodeAttachment[]>(old.attachments, []); const isEmpty = !String(old.content ?? '').trim() && !this.rows('SELECT 1 FROM chat_nodes WHERE parent_id=? LIMIT 1', nodeId).length;
    if (isEmpty) {
      this.db.prepare('UPDATE chat_nodes SET content=?,thinking=?,attachments=?,updated_at=? WHERE id=?').run(content, thinking !== undefined ? thinking : old.thinking, JSON.stringify(attachments ?? oldAttachments), ts, nodeId);
      this.db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(ts, chatId);
      return mapNode(this.row('SELECT * FROM chat_nodes WHERE id=?', nodeId) as Row);
    }
    const id = randomUUID(); const tx = this.db.transaction(() => { this.db.prepare('UPDATE chat_nodes SET is_current=0,updated_at=? WHERE id=?').run(ts, nodeId); this.db.prepare("INSERT INTO chat_nodes(id,chat_id,parent_id,role,content,thinking,model_id,provider_id,version,previous_version_id,prompt_tokens,completion_tokens,attachments,is_current,created_at,updated_at,chat_parameters_id) SELECT ?,chat_id,parent_id,role,?,?,?,?,version+1,?,prompt_tokens,completion_tokens,?,?,?, ?,chat_parameters_id FROM chat_nodes WHERE id=?").run(id, content, thinking !== undefined ? thinking : old.thinking, old.model_id, old.provider_id, nodeId, JSON.stringify(attachments ?? oldAttachments), 1, ts, ts, nodeId); this.db.prepare('UPDATE chat_nodes SET parent_id=? WHERE parent_id=? AND id<>?').run(id, nodeId, id); this.db.prepare('UPDATE chats SET node_number=node_number+1,updated_at=? WHERE id=?').run(ts, chatId); }); tx(); return mapNode(this.row('SELECT * FROM chat_nodes WHERE id=?', id) as Row); }
  async patchNode(chatId: string, nodeId: string, data: PatchNodeRequest): Promise<ChatNode> { this.node(chatId, nodeId); const old = this.row('SELECT * FROM chat_nodes WHERE id=?', nodeId) as Row; this.db.prepare('UPDATE chat_nodes SET content=?,thinking=?,attachments=?,model_id=?,provider_id=?,parent_id=?,updated_at=? WHERE id=?').run(data.content ?? old.content, data.thinking !== undefined ? data.thinking : old.thinking, data.attachments ? JSON.stringify(data.attachments) : old.attachments, data.modelId !== undefined ? data.modelId : old.model_id, data.providerId !== undefined ? data.providerId : old.provider_id, data.parentId !== undefined ? data.parentId : old.parent_id, now(), nodeId); return mapNode(this.row('SELECT * FROM chat_nodes WHERE id=?', nodeId) as Row); }
  async deleteNode(chatId: string, nodeId: string, options?: { keepChildren?: boolean }): Promise<void> { const node = this.node(chatId, nodeId); const tx = this.db.transaction(() => { if (options?.keepChildren) { this.db.prepare('UPDATE chat_nodes SET parent_id=? WHERE parent_id=?').run(node.parent_id, nodeId); this.db.prepare('DELETE FROM chat_nodes WHERE id=?').run(nodeId); return; } const ids = [nodeId]; for (let i = 0; i < ids.length; i++) ids.push(...this.rows('SELECT id FROM chat_nodes WHERE parent_id=?', ids[i]).map((row) => row.id as string)); this.db.prepare(`DELETE FROM chat_nodes WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids); }); tx(); }

  async getPersonas(): Promise<Persona[]> { return this.rows('SELECT * FROM personas ORDER BY rowid').map(mapPersona); }
  async createPersona(data: CreatePersonaRequest): Promise<Persona> { const id = randomUUID(); const ts = now(); this.db.prepare('INSERT INTO personas(id,name,short_name,description,avatar,main_topic_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, data.name, data.shortName, data.description ?? '', data.avatar ?? '', data.mainTopicId ?? null, ts, ts); return mapPersona(this.requireRow('persona', id, 'personas')); }
  async updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> { const old = this.requireRow('persona', id, 'personas'); this.db.prepare('UPDATE personas SET name=?,short_name=?,description=?,avatar=?,main_topic_id=?,updated_at=? WHERE id=?').run(data.name ?? old.name, data.shortName ?? old.short_name, data.description ?? old.description, data.avatar ?? old.avatar, data.mainTopicId !== undefined ? data.mainTopicId : old.main_topic_id, now(), id); return mapPersona(this.requireRow('persona', id, 'personas')); }
  async deletePersona(id: string): Promise<void> { this.requireRow('persona', id, 'personas'); this.db.prepare('DELETE FROM personas WHERE id=?').run(id); }

  async getTopics(): Promise<Topic[]> { return this.rows('SELECT * FROM topics ORDER BY rowid').map((row) => this.topic(row)); }
  async createTopic(data: CreateTopicRequest): Promise<Topic> { const id = randomUUID(); const ts = now(); this.db.prepare('INSERT INTO topics(id,name,description,default_model_id,chat_parameters_id,default_system_prompt,icon,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, data.name, data.description ?? '', data.defaultModelId ?? null, data.chatParametersId ?? null, data.defaultSystemPrompt ?? '', data.icon ?? '', ts, ts); for (const projectId of data.projectIds ?? []) this.db.prepare('INSERT OR IGNORE INTO topic_projects(topic_id,project_id) VALUES(?,?)').run(id, projectId); return this.topic(this.requireRow('topic', id, 'topics')); }
  async updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> { const old = this.requireRow('topic', id, 'topics'); this.db.prepare('UPDATE topics SET name=?,description=?,default_model_id=?,chat_parameters_id=?,default_system_prompt=?,icon=?,updated_at=? WHERE id=?').run(data.name ?? old.name, data.description ?? old.description, data.defaultModelId !== undefined ? data.defaultModelId : old.default_model_id, data.chatParametersId !== undefined ? data.chatParametersId : old.chat_parameters_id, data.defaultSystemPrompt ?? old.default_system_prompt, data.icon ?? old.icon, now(), id); return this.topic(this.requireRow('topic', id, 'topics')); }
  async deleteTopic(id: string): Promise<void> { this.requireRow('topic', id, 'topics'); const tx = this.db.transaction(() => { this.db.prepare('DELETE FROM topic_projects WHERE topic_id=?').run(id); this.db.prepare('UPDATE projects SET main_topic_id=NULL WHERE main_topic_id=?').run(id); this.db.prepare('DELETE FROM topics WHERE id=?').run(id); }); tx(); }
  async addProjectToTopic(topicId: string, projectId: string): Promise<Topic> { this.requireRow('topic', topicId, 'topics'); this.requireRow('project', projectId, 'projects'); this.db.prepare('INSERT OR IGNORE INTO topic_projects(topic_id,project_id) VALUES(?,?)').run(topicId, projectId); return this.topic(this.requireRow('topic', topicId, 'topics')); }
  async removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> { this.requireRow('topic', topicId, 'topics'); this.db.prepare('DELETE FROM topic_projects WHERE topic_id=? AND project_id=?').run(topicId, projectId); return this.topic(this.requireRow('topic', topicId, 'topics')); }

  async getProviders(): Promise<ProviderConfig[]> { return this.rows('SELECT * FROM providers ORDER BY rowid').map(mapProvider); }
  async createProvider(data: CreateProviderRequest): Promise<ProviderConfig> { const id = randomUUID(); const enabled = data.enabled === undefined ? true : data.enabled; this.db.prepare('INSERT INTO providers(id,name,type,base_url,api_key,enabled) VALUES(?,?,?,?,?,?)').run(id, data.name, data.type, data.baseUrl, data.apiKey, enabled ? 1 : 0); return mapProvider(this.requireRow('provider', id, 'providers')); }
  async updateProvider(id: string, data: UpdateProviderRequest): Promise<ProviderConfig> { const old = this.requireRow('provider', id, 'providers'); this.db.prepare('UPDATE providers SET name=?,type=?,base_url=?,api_key=?,enabled=? WHERE id=?').run(data.name ?? old.name, data.type ?? old.type, data.baseUrl ?? old.base_url, data.apiKey ?? old.api_key, data.enabled !== undefined ? (data.enabled ? 1 : 0) : old.enabled, id); return mapProvider(this.requireRow('provider', id, 'providers')); }
  async deleteProvider(id: string): Promise<void> { this.requireRow('provider', id, 'providers'); this.db.prepare('DELETE FROM providers WHERE id=?').run(id); }
  async getModels(): Promise<ModelEntry[]> { return this.rows('SELECT * FROM models ORDER BY rowid').map(mapModel); }
  async createModel(data: CreateModelRequest): Promise<ModelEntry> { const id = randomUUID(); const catalog = { architecture: data.architecture, contextLength: data.contextLength, description: data.description }; const enabled = data.enabled === undefined ? true : data.enabled; this.db.prepare('INSERT INTO models(id,display_name,model_id,provider_id,type,enabled,catalog_json) VALUES(?,?,?,?,?,?,?)').run(id, data.displayName, data.modelId, data.providerId, data.type, enabled ? 1 : 0, JSON.stringify(catalog)); return mapModel(this.requireRow('model', id, 'models')); }
  async updateModel(id: string, data: UpdateModelRequest): Promise<ModelEntry> { const old = this.requireRow('model', id, 'models'); const catalog = { ...json<Record<string, unknown>>(old.catalog_json, {}), architecture: data.architecture ?? json<Record<string, unknown>>(old.catalog_json, {}).architecture, contextLength: data.contextLength ?? json<Record<string, unknown>>(old.catalog_json, {}).contextLength, description: data.description ?? json<Record<string, unknown>>(old.catalog_json, {}).description }; this.db.prepare('UPDATE models SET display_name=?,model_id=?,provider_id=?,type=?,enabled=?,catalog_json=?,chat_parameters_id=? WHERE id=?').run(data.displayName ?? old.display_name, data.modelId ?? old.model_id, data.providerId ?? old.provider_id, data.type ?? old.type, data.enabled !== undefined ? (data.enabled ? 1 : 0) : old.enabled, JSON.stringify(catalog), data.chatParametersId !== undefined ? data.chatParametersId : old.chat_parameters_id, id); return mapModel(this.requireRow('model', id, 'models')); }
  async deleteModel(id: string): Promise<void> { this.requireRow('model', id, 'models'); this.db.prepare('DELETE FROM models WHERE id=?').run(id); }
  async toggleModelEnabled(id: string): Promise<ToggleModelResponse> { const old = this.requireRow('model', id, 'models'); const enabled = !bool(old.enabled); this.db.prepare('UPDATE models SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id); return { id, enabled }; }

  async getChatParameters(): Promise<ChatParameters[]> { return this.rows('SELECT * FROM chat_parameters ORDER BY rowid').map(mapParameters); }
  async getChatParameter(id: string): Promise<ChatParameters> { return mapParameters(this.requireRow('chat-parameters', id, 'chat_parameters')); }
  async createChatParameters(data: ChatParametersDraft): Promise<ChatParameters> { const id = randomUUID(); const ts = now(); this.db.prepare('INSERT INTO chat_parameters(id,name,temperature,top_k,top_m,top_p,stream,thinking,thinking_level,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, data.name ?? '', data.temperature, data.topK, data.topM, data.topM, data.stream == null ? null : (data.stream ? 1 : 0), data.thinking == null ? null : (data.thinking ? 1 : 0), data.thinkingLevel, ts, ts); return mapParameters(this.requireRow('chat-parameters', id, 'chat_parameters')); }
  async updateChatParameters(id: string, data: ChatParametersDraft): Promise<ChatParameters> { const old = this.requireRow('chat-parameters', id, 'chat_parameters'); this.db.prepare('UPDATE chat_parameters SET name=?,temperature=?,top_k=?,top_m=?,top_p=?,stream=?,thinking=?,thinking_level=?,updated_at=? WHERE id=?').run(data.name ?? old.name, data.temperature, data.topK, data.topM, data.topM, data.stream == null ? null : (data.stream ? 1 : 0), data.thinking == null ? null : (data.thinking ? 1 : 0), data.thinkingLevel, now(), id); return mapParameters(this.requireRow('chat-parameters', id, 'chat_parameters')); }
  async deleteChatParameters(id: string): Promise<void> { this.requireRow('chat-parameters', id, 'chat_parameters'); const tx = this.db.transaction(() => { for (const table of ['projects', 'topics', 'chats', 'chat_nodes', 'models']) this.db.prepare(`UPDATE ${table} SET chat_parameters_id=NULL WHERE chat_parameters_id=?`).run(id); this.db.prepare('DELETE FROM chat_parameters WHERE id=?').run(id); }); tx(); }
}