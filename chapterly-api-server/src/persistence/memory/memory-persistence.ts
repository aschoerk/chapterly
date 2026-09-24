import { randomUUID } from 'node:crypto';
import type { PersistencePort } from '../../domain/chat-api.port.js';
import type {
  Chat,
  ChatNode,
  ChatParameters,
  ChatParametersDraft,
  CreateNodeRequest,
  ModelEntry,
  NodeAttachment,
  Persona,
  Project,
  ProviderConfig,
  Topic,
} from '../../domain/models.js';
import type {
  BranchQuestionRequest,
  CreateModelRequest,
  CreatePersonaRequest,
  CreateProjectRequest,
  CreateProviderRequest,
  CreateTopicRequest,
  PatchChatRequest,
  PatchNodeRequest,
  ToggleModelResponse,
  UpdateModelRequest,
  UpdatePersonaRequest,
  UpdateProjectRequest,
  UpdateProviderRequest,
  UpdateTopicRequest,
} from '../../domain/requests.js';
import { badRequest, notFound } from '../../http/http-error.js';

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export const UNSCOPED_TOPIC_ID = '_unscoped';

export type SnapshotMeta = {
  revision: number;
  updateId: string;
};

export type TopicSnapshot = {
  topicId: string;
  topic: Topic | null;
  projects: Project[];
  personas: Persona[];
  chats: Chat[];
  nodes: ChatNode[];
  parameters: ChatParameters[];
} & SnapshotMeta;

export type ProviderSnapshot = {
  providerId: string;
  provider: ProviderConfig;
  models: ModelEntry[];
  parameters: ChatParameters[];
} & SnapshotMeta;

export type PersistenceSnapshot = {
  topics: TopicSnapshot[];
  providers: ProviderSnapshot[];
};

export class MemoryPersistence implements PersistencePort {
  readonly kind = 'memory' as const;

  private projects = new Map<string, Project>();
  private topics = new Map<string, Topic>();
  private personas = new Map<string, Persona>();
  private chats = new Map<string, Chat>();
  private nodes = new Map<string, ChatNode>();
  private providers = new Map<string, ProviderConfig>();
  private models = new Map<string, ModelEntry>();
  private parameters = new Map<string, ChatParameters>();
  private topicRevisions = new Map<string, SnapshotMeta>();
  private providerRevisions = new Map<string, SnapshotMeta>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  projectTopicId(project: Project): string {
    return project.mainTopicId ?? project.topicIds?.[0] ?? UNSCOPED_TOPIC_ID;
  }

  chatTopicId(chat: Chat): string {
    if (!chat.projectId) return UNSCOPED_TOPIC_ID;
    const project = this.projects.get(chat.projectId);
    return project ? this.projectTopicId(project) : UNSCOPED_TOPIC_ID;
  }

  listTopicIds(): string[] {
    const ids = new Set<string>([...this.topics.keys()]);
    for (const project of this.projects.values()) ids.add(this.projectTopicId(project));
    for (const persona of this.personas.values()) ids.add(persona.mainTopicId ?? UNSCOPED_TOPIC_ID);
    for (const chat of this.chats.values()) ids.add(this.chatTopicId(chat));
    return [...ids];
  }

  listProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  exportTopicSnapshot(topicId: string): TopicSnapshot {
    const topic = this.topics.get(topicId) ?? null;
    const projects = [...this.projects.values()].filter((p) => this.projectTopicId(p) === topicId);
    const projectIds = new Set(projects.map((p) => p.id));
    const personas = [...this.personas.values()].filter(
      (p) => (p.mainTopicId ?? UNSCOPED_TOPIC_ID) === topicId,
    );
    const chats = [...this.chats.values()].filter((c) => this.chatTopicId(c) === topicId);
    const chatIds = new Set(chats.map((c) => c.id));
    const nodes = [...this.nodes.values()].filter((n) => chatIds.has(n.chatId));
    const paramIds = new Set<string>();
    if (topic?.chatParametersId) paramIds.add(topic.chatParametersId);
    for (const project of projects) {
      if (project.chatParametersId) paramIds.add(project.chatParametersId);
    }
    for (const chat of chats) {
      if (chat.chatParametersId) paramIds.add(chat.chatParametersId);
    }
    for (const node of nodes) {
      if (node.chatParametersId) paramIds.add(node.chatParametersId);
    }
    const parameters = [...paramIds]
      .map((id) => this.parameters.get(id))
      .filter((row): row is ChatParameters => row !== undefined)
      .map(clone);
    const meta = this.topicMeta(topicId);
    return {
      topicId,
      topic: topic ? clone(topic) : null,
      projects: projects.map(clone),
      personas: personas.map(clone),
      chats: chats.map(clone),
      nodes: nodes.map(clone),
      parameters,
      revision: meta.revision,
      updateId: meta.updateId,
    };
  }

  exportProviderSnapshot(providerId: string): ProviderSnapshot | null {
    const provider = this.providers.get(providerId);
    if (!provider) return null;
    const models = [...this.models.values()].filter((m) => m.providerId === providerId);
    const paramIds = new Set(
      models.map((m) => m.chatParametersId).filter((id): id is string => !!id),
    );
    const parameters = [...paramIds]
      .map((id) => this.parameters.get(id))
      .filter((row): row is ChatParameters => row !== undefined)
      .map(clone);
    const meta = this.providerMeta(providerId);
    return {
      providerId,
      provider: clone(provider),
      models: models.map(clone),
      parameters,
      revision: meta.revision,
      updateId: meta.updateId,
    };
  }

  exportSnapshot(): PersistenceSnapshot {
    return {
      topics: this.listTopicIds().map((id) => this.exportTopicSnapshot(id)),
      providers: this.listProviderIds()
        .map((id) => this.exportProviderSnapshot(id))
        .filter((row): row is ProviderSnapshot => row !== null),
    };
  }

  replaceTopicSnapshot(snapshot: TopicSnapshot): void {
    const topicId = snapshot.topicId;
    if (topicId !== UNSCOPED_TOPIC_ID) {
      if (snapshot.topic) this.topics.set(topicId, clone(snapshot.topic));
      else this.topics.delete(topicId);
    }
    for (const project of [...this.projects.values()]) {
      if (this.projectTopicId(project) === topicId) this.projects.delete(project.id);
    }
    for (const persona of [...this.personas.values()]) {
      if ((persona.mainTopicId ?? UNSCOPED_TOPIC_ID) === topicId) this.personas.delete(persona.id);
    }
    for (const chat of [...this.chats.values()]) {
      if (this.chatTopicId(chat) === topicId) {
        for (const node of [...this.nodes.values()]) {
          if (node.chatId === chat.id) this.nodes.delete(node.id);
        }
        this.chats.delete(chat.id);
      }
    }
    for (const project of snapshot.projects) this.projects.set(project.id, clone(project));
    for (const persona of snapshot.personas) this.personas.set(persona.id, clone(persona));
    for (const chat of snapshot.chats) this.chats.set(chat.id, clone(chat));
    for (const node of snapshot.nodes) this.nodes.set(node.id, clone(node));
    for (const row of snapshot.parameters) this.parameters.set(row.id, clone(row));
    this.topicRevisions.set(topicId, {
      revision: snapshot.revision,
      updateId: snapshot.updateId,
    });
  }

  replaceProviderSnapshot(snapshot: ProviderSnapshot): void {
    this.providers.set(snapshot.providerId, clone(snapshot.provider));
    for (const model of [...this.models.values()]) {
      if (model.providerId === snapshot.providerId) this.models.delete(model.id);
    }
    for (const model of snapshot.models) this.models.set(model.id, clone(model));
    for (const row of snapshot.parameters) this.parameters.set(row.id, clone(row));
    this.providerRevisions.set(snapshot.providerId, {
      revision: snapshot.revision,
      updateId: snapshot.updateId,
    });
  }

  importSnapshot(snapshot: PersistenceSnapshot): void {
    this.projects.clear();
    this.topics.clear();
    this.personas.clear();
    this.chats.clear();
    this.nodes.clear();
    this.providers.clear();
    this.models.clear();
    this.parameters.clear();
    this.topicRevisions.clear();
    this.providerRevisions.clear();
    for (const topic of snapshot.topics) this.replaceTopicSnapshot(topic);
    for (const provider of snapshot.providers) this.replaceProviderSnapshot(provider);
  }

  topicMeta(topicId: string): SnapshotMeta {
    return this.topicRevisions.get(topicId) ?? { revision: 0, updateId: '' };
  }

  providerMeta(providerId: string): SnapshotMeta {
    return this.providerRevisions.get(providerId) ?? { revision: 0, updateId: '' };
  }

  acceptTopicWrite(topicId: string, revision: number, updateId: string): void {
    this.topicRevisions.set(topicId, { revision, updateId });
  }

  acceptProviderWrite(providerId: string, revision: number, updateId: string): void {
    this.providerRevisions.set(providerId, { revision, updateId });
  }

  affectedTopicIds(hint?: {
    topicId?: string | null;
    projectId?: string | null;
    chatId?: string | null;
    personaId?: string | null;
  }): string[] {
    if (hint?.topicId) return [hint.topicId];
    if (hint?.projectId) {
      const project = this.projects.get(hint.projectId);
      return [project ? this.projectTopicId(project) : UNSCOPED_TOPIC_ID];
    }
    if (hint?.chatId) {
      const chat = this.chats.get(hint.chatId);
      return [chat ? this.chatTopicId(chat) : UNSCOPED_TOPIC_ID];
    }
    if (hint?.personaId) {
      const persona = this.personas.get(hint.personaId);
      return [persona?.mainTopicId ?? UNSCOPED_TOPIC_ID];
    }
    return this.listTopicIds();
  }

  async getProjects(): Promise<Project[]> {
    return [...this.projects.values()].map(clone);
  }

  async createProject(data: CreateProjectRequest): Promise<Project> {
    const id = randomUUID();
    const ts = now();
    const topicIds = data.topicIds ?? (data.topicId ? [data.topicId] : []);
    const project: Project = {
      id,
      name: data.name,
      greeting: data.greeting,
      systemPrompt: data.systemPrompt ?? '',
      defaultModelId: data.defaultModelId ?? null,
      chatParametersId: data.chatParametersId ?? null,
      avatar: data.avatar ?? '',
      personaIds: data.personaIds ?? [],
      mainTopicId: data.mainTopicId ?? topicIds[0] ?? null,
      topicIds,
      createdAt: ts,
      updatedAt: ts,
    };
    this.projects.set(id, project);
    for (const topicId of topicIds) {
      const topic = this.topics.get(topicId);
      if (topic && !topic.projectIds.includes(id)) {
        topic.projectIds = [...topic.projectIds, id];
        topic.updatedAt = ts;
      }
    }
    return clone(project);
  }

  async updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    const existing = this.projects.get(id);
    if (!existing) throw notFound('project', id);
    const topicIds = data.topicIds ?? (data.topicId ? [data.topicId] : existing.topicIds);
    const next: Project = {
      ...existing,
      name: data.name ?? existing.name,
      greeting: data.greeting ?? existing.greeting,
      systemPrompt: data.systemPrompt ?? existing.systemPrompt,
      defaultModelId:
        data.defaultModelId !== undefined ? data.defaultModelId : existing.defaultModelId,
      chatParametersId:
        data.chatParametersId !== undefined ? data.chatParametersId : existing.chatParametersId,
      avatar: data.avatar ?? existing.avatar,
      personaIds: data.personaIds ?? existing.personaIds,
      mainTopicId: data.mainTopicId !== undefined ? data.mainTopicId : existing.mainTopicId,
      topicIds,
      updatedAt: now(),
    };
    this.projects.set(id, next);
    return clone(next);
  }

  async deleteProject(id: string, deleteChats = false): Promise<void> {
    if (!this.projects.has(id)) throw notFound('project', id);
    this.projects.delete(id);
    for (const topic of this.topics.values()) {
      topic.projectIds = topic.projectIds.filter((pid) => pid !== id);
    }
    if (deleteChats) {
      for (const chat of [...this.chats.values()]) {
        if (chat.projectId === id) {
          await this.deleteChat(chat.id);
        }
      }
    } else {
      for (const chat of this.chats.values()) {
        if (chat.projectId === id) {
          chat.projectId = null;
          chat.updated_at = now();
        }
      }
    }
  }

  async getChats(): Promise<Chat[]> {
    return [...this.chats.values()].map(clone);
  }

  async searchChatIds(q: string): Promise<string[]> {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const ids = new Set<string>();
    for (const chat of this.chats.values()) {
      if (chat.title.toLowerCase().includes(needle)) ids.add(chat.id);
    }
    for (const node of this.nodes.values()) {
      if (node.isCurrent && node.content.toLowerCase().includes(needle)) {
        ids.add(node.chatId);
      }
    }
    return [...ids];
  }

  async createChat(title: string, projectId: string | null = null): Promise<Chat> {
    if (projectId && !this.projects.has(projectId)) throw notFound('project', projectId);
    const ts = now();
    const chat: Chat = {
      id: randomUUID(),
      title,
      projectId,
      chatParametersId: null,
      node_number: 0,
      created_at: ts,
      updated_at: ts,
    };
    this.chats.set(chat.id, chat);
    return clone(chat);
  }

  async cloneChat(chatId: string): Promise<Chat> {
    const src = this.requireChat(chatId);
    const ts = now();
    const copy: Chat = {
      ...clone(src),
      id: randomUUID(),
      title: `${src.title} (copy)`,
      created_at: ts,
      updated_at: ts,
    };
    this.chats.set(copy.id, copy);
    const idMap = new Map<string, string>();
    const srcNodes = [...this.nodes.values()].filter((n) => n.chatId === chatId);
    for (const node of srcNodes) idMap.set(node.id, randomUUID());
    for (const node of srcNodes) {
      const mapped: ChatNode = {
        ...clone(node),
        id: idMap.get(node.id) as string,
        chatId: copy.id,
        parentId: node.parentId ? (idMap.get(node.parentId) ?? null) : null,
        previousVersionId: node.previousVersionId
          ? (idMap.get(node.previousVersionId) ?? null)
          : null,
      };
      this.nodes.set(mapped.id, mapped);
    }
    return clone(copy);
  }

  async deleteChat(id: string): Promise<void> {
    if (!this.chats.has(id)) throw notFound('chat', id);
    this.chats.delete(id);
    for (const node of [...this.nodes.values()]) {
      if (node.chatId === id) this.nodes.delete(node.id);
    }
  }

  async patchChat(id: string, data: PatchChatRequest): Promise<Chat> {
    const chat = this.requireChat(id);
    if (data.title !== undefined) chat.title = data.title;
    if (data.projectId !== undefined) {
      if (data.projectId && !this.projects.has(data.projectId)) {
        throw notFound('project', data.projectId);
      }
      chat.projectId = data.projectId;
    }
    if (data.chatParametersId !== undefined) chat.chatParametersId = data.chatParametersId;
    chat.updated_at = now();
    return clone(chat);
  }

  async getNodes(chatId: string): Promise<ChatNode[]> {
    this.requireChat(chatId);
    return [...this.nodes.values()].filter((n) => n.chatId === chatId).map(clone);
  }

  async createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    const chat = this.requireChat(chatId);
    const ts = now();
    const node: ChatNode = {
      id: randomUUID(),
      chatId,
      parentId: data.parentId ?? null,
      role: data.role,
      content: data.content,
      thinking: data.thinking ?? null,
      modelId: data.modelId ?? null,
      providerId: data.providerId ?? null,
      version: 1,
      previousVersionId: null,
      isCurrent: true,
      createdAt: ts,
      updatedAt: ts,
      attachments: data.attachments ?? [],
      chatParametersId: data.chatParametersId ?? null,
    };
    this.nodes.set(node.id, node);
    chat.node_number += 1;
    chat.updated_at = ts;
    return clone(node);
  }

  async editAssistant(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[],
    thinking?: string,
  ): Promise<ChatNode> {
    return this.versionNode(chatId, nodeId, 'assistant', { content, attachments, thinking });
  }

  async editUser(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[],
  ): Promise<ChatNode> {
    return this.versionNode(chatId, nodeId, 'user', { content, attachments });
  }

  async branchUser(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode> {
    const parent = this.requireNode(chatId, nodeId);
    return this.createNode(chatId, {
      parentId: parent.parentId,
      role: 'user',
      content: data.content,
      modelId: data.modelId,
      providerId: data.providerId,
      attachments: data.attachments,
    });
  }

  async patchNode(chatId: string, nodeId: string, data: PatchNodeRequest): Promise<ChatNode> {
    const node = this.requireNode(chatId, nodeId);
    if (data.content !== undefined) node.content = data.content;
    if (data.thinking !== undefined) node.thinking = data.thinking;
    if (data.attachments !== undefined) node.attachments = data.attachments;
    if (data.modelId !== undefined) node.modelId = data.modelId;
    if (data.providerId !== undefined) node.providerId = data.providerId;
    if (data.parentId !== undefined) node.parentId = data.parentId;
    node.updatedAt = now();
    return clone(node);
  }

  async deleteNode(
    chatId: string,
    nodeId: string,
    options?: { keepChildren?: boolean },
  ): Promise<void> {
    const node = this.requireNode(chatId, nodeId);
    const children = [...this.nodes.values()].filter((n) => n.parentId === nodeId);
    if (options?.keepChildren) {
      for (const child of children) child.parentId = node.parentId;
    } else {
      const stack = [nodeId];
      while (stack.length) {
        const id = stack.pop() as string;
        for (const child of this.nodes.values()) {
          if (child.parentId === id) stack.push(child.id);
        }
        this.nodes.delete(id);
      }
      return;
    }
    this.nodes.delete(node.id);
  }

  async getPersonas(): Promise<Persona[]> {
    return [...this.personas.values()].map(clone);
  }

  async createPersona(data: CreatePersonaRequest): Promise<Persona> {
    const ts = now();
    const persona: Persona = {
      id: randomUUID(),
      name: data.name,
      shortName: data.shortName,
      description: data.description ?? '',
      avatar: data.avatar ?? '',
      mainTopicId: data.mainTopicId ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.personas.set(persona.id, persona);
    return clone(persona);
  }

  async updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> {
    const existing = this.personas.get(id);
    if (!existing) throw notFound('persona', id);
    const next: Persona = {
      ...existing,
      ...data,
      updatedAt: now(),
    };
    this.personas.set(id, next);
    return clone(next);
  }

  async deletePersona(id: string): Promise<void> {
    if (!this.personas.has(id)) throw notFound('persona', id);
    this.personas.delete(id);
  }

  async getTopics(): Promise<Topic[]> {
    return [...this.topics.values()].map(clone);
  }

  async createTopic(data: CreateTopicRequest): Promise<Topic> {
    const ts = now();
    const topic: Topic = {
      id: randomUUID(),
      name: data.name,
      description: data.description ?? '',
      defaultModelId: data.defaultModelId ?? null,
      chatParametersId: data.chatParametersId ?? null,
      defaultSystemPrompt: data.defaultSystemPrompt ?? '',
      icon: data.icon ?? '',
      projectIds: data.projectIds ?? [],
      createdAt: ts,
      updatedAt: ts,
    };
    this.topics.set(topic.id, topic);
    return clone(topic);
  }

  async updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> {
    const existing = this.topics.get(id);
    if (!existing) throw notFound('topic', id);
    const next: Topic = { ...existing, ...data, updatedAt: now() };
    this.topics.set(id, next);
    return clone(next);
  }

  async deleteTopic(id: string): Promise<void> {
    if (!this.topics.has(id)) throw notFound('topic', id);
    this.topics.delete(id);
    for (const project of this.projects.values()) {
      project.topicIds = (project.topicIds ?? []).filter((tid) => tid !== id);
      if (project.mainTopicId === id) project.mainTopicId = null;
    }
  }

  async addProjectToTopic(topicId: string, projectId: string): Promise<Topic> {
    const topic = this.topics.get(topicId);
    if (!topic) throw notFound('topic', topicId);
    if (!this.projects.has(projectId)) throw notFound('project', projectId);
    if (!topic.projectIds.includes(projectId)) topic.projectIds = [...topic.projectIds, projectId];
    const project = this.projects.get(projectId) as Project;
    const ids = new Set(project.topicIds ?? []);
    ids.add(topicId);
    project.topicIds = [...ids];
    topic.updatedAt = now();
    return clone(topic);
  }

  async removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> {
    const topic = this.topics.get(topicId);
    if (!topic) throw notFound('topic', topicId);
    topic.projectIds = topic.projectIds.filter((id) => id !== projectId);
    const project = this.projects.get(projectId);
    if (project) {
      project.topicIds = (project.topicIds ?? []).filter((id) => id !== topicId);
    }
    topic.updatedAt = now();
    return clone(topic);
  }

  async getProviders(): Promise<ProviderConfig[]> {
    return [...this.providers.values()].map(clone);
  }

  async createProvider(data: CreateProviderRequest): Promise<ProviderConfig> {
    const provider: ProviderConfig = { ...data, id: randomUUID(), enabled: data.enabled ?? true };
    this.providers.set(provider.id, provider);
    return clone(provider);
  }

  async updateProvider(id: string, data: UpdateProviderRequest): Promise<ProviderConfig> {
    const existing = this.providers.get(id);
    if (!existing) throw notFound('provider', id);
    const next = { ...existing, ...data };
    this.providers.set(id, next);
    return clone(next);
  }

  async deleteProvider(id: string): Promise<void> {
    if (!this.providers.has(id)) throw notFound('provider', id);
    this.providers.delete(id);
  }

  async getModels(): Promise<ModelEntry[]> {
    return [...this.models.values()].map(clone);
  }

  async createModel(data: CreateModelRequest): Promise<ModelEntry> {
    const model: ModelEntry = { ...data, id: randomUUID(), enabled: data.enabled ?? true };
    this.models.set(model.id, model);
    return clone(model);
  }

  async updateModel(id: string, data: UpdateModelRequest): Promise<ModelEntry> {
    const existing = this.models.get(id);
    if (!existing) throw notFound('model', id);
    const next = { ...existing, ...data };
    this.models.set(id, next);
    return clone(next);
  }

  async deleteModel(id: string): Promise<void> {
    if (!this.models.has(id)) throw notFound('model', id);
    this.models.delete(id);
  }

  async toggleModelEnabled(id: string): Promise<ToggleModelResponse> {
    const model = this.models.get(id);
    if (!model) throw notFound('model', id);
    model.enabled = !model.enabled;
    return { id, enabled: model.enabled };
  }

  async getChatParameters(): Promise<ChatParameters[]> {
    return [...this.parameters.values()].map(clone);
  }

  async getChatParameter(id: string): Promise<ChatParameters> {
    const row = this.parameters.get(id);
    if (!row) throw notFound('chat-parameters', id);
    return clone(row);
  }

  async createChatParameters(data: ChatParametersDraft): Promise<ChatParameters> {
    const ts = now();
    const row: ChatParameters = {
      id: randomUUID(),
      name: data.name ?? '',
      temperature: data.temperature,
      topK: data.topK,
      topM: data.topM,
      topP: data.topM,
      stream: data.stream,
      thinking: data.thinking,
      thinkingLevel: data.thinkingLevel,
      reasoningEffort: data.thinkingLevel,
      createdAt: ts,
      updatedAt: ts,
    };
    this.parameters.set(row.id, row);
    return clone(row);
  }

  async updateChatParameters(id: string, data: ChatParametersDraft): Promise<ChatParameters> {
    const existing = this.parameters.get(id);
    if (!existing) throw notFound('chat-parameters', id);
    const next: ChatParameters = {
      ...existing,
      name: data.name ?? existing.name,
      temperature: data.temperature,
      topK: data.topK,
      topM: data.topM,
      topP: data.topM,
      stream: data.stream,
      thinking: data.thinking,
      thinkingLevel: data.thinkingLevel,
      reasoningEffort: data.thinkingLevel,
      updatedAt: now(),
    };
    this.parameters.set(id, next);
    return clone(next);
  }

  async deleteChatParameters(id: string): Promise<void> {
    if (!this.parameters.has(id)) throw notFound('chat-parameters', id);
    for (const project of this.projects.values()) {
      if (project.chatParametersId === id) project.chatParametersId = null;
    }
    for (const topic of this.topics.values()) {
      if (topic.chatParametersId === id) topic.chatParametersId = null;
    }
    for (const chat of this.chats.values()) {
      if (chat.chatParametersId === id) chat.chatParametersId = null;
    }
    for (const model of this.models.values()) {
      if (model.chatParametersId === id) model.chatParametersId = null;
    }
    for (const node of this.nodes.values()) {
      if (node.chatParametersId === id) node.chatParametersId = null;
    }
    this.parameters.delete(id);
  }

  private requireChat(id: string): Chat {
    const chat = this.chats.get(id);
    if (!chat) throw notFound('chat', id);
    return chat;
  }

  private requireNode(chatId: string, nodeId: string): ChatNode {
    this.requireChat(chatId);
    const node = this.nodes.get(nodeId);
    if (!node || node.chatId !== chatId) throw notFound('node', nodeId);
    return node;
  }

  private versionNode(
    chatId: string,
    nodeId: string,
    expected: ChatNode['role'],
    patch: { content: string; attachments?: NodeAttachment[]; thinking?: string },
  ): ChatNode {
    const old = this.requireNode(chatId, nodeId);
    if (old.role !== 'system' && old.role !== 'structural' && old.role !== expected) {
      throw badRequest(`Only ${expected}s can be versioned this way`);
    }
    const ts = now();
    const isEmpty =
      !String(old.content ?? '').trim() &&
      ![...this.nodes.values()].some((entry) => entry.parentId === old.id);
    // Empty placeholder (no content, no attachments, no children): fill it in place
    // instead of retiring it as a previous version.
    if (isEmpty) {
      old.content = patch.content;
      if (patch.thinking !== undefined) old.thinking = patch.thinking;
      if (patch.attachments !== undefined) old.attachments = patch.attachments;
      old.updatedAt = ts;
      const chat = this.requireChat(chatId);
      chat.updated_at = ts;
      return clone(old);
    }
    old.isCurrent = false;
    const next: ChatNode = {
      ...clone(old),
      id: randomUUID(),
      content: patch.content,
      attachments: patch.attachments ?? old.attachments,
      thinking: patch.thinking !== undefined ? patch.thinking : old.thinking,
      version: old.version + 1,
      previousVersionId: old.id,
      isCurrent: true,
      createdAt: ts,
      updatedAt: ts,
    };
    this.nodes.set(next.id, next);
    for (const child of this.nodes.values()) {
      if (child.parentId === old.id) child.parentId = next.id;
    }
    const chat = this.requireChat(chatId);
    chat.node_number += 1;
    chat.updated_at = ts;
    return clone(next);
  }
}
