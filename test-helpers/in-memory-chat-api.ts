import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { ChatComponent } from '../src/app/pages/chat/chat.component';
import { CHAT_API } from '../src/app/api/chat-api.token';
import { ChatApiPort } from '../src/app/api/chat-api.port';
import {
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateTopicRequest,
  UpdateTopicRequest,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateModelRequest,
  UpdateModelRequest
} from '../src/app/api/chat-api.types';
import {
  Chat, ChatNode, CreateNodeRequest, Project, Persona, Topic, NodeAttachment
} from '../src/app/models/chat';
import { ProviderConfig, ModelEntry } from '../src/app/models/chat-config';
import { ChatParameters, ChatParametersDraft } from '../src/app/models/chat-parameters';
/**
 * In-memory ChatApiPort.
 * Covers the operations used by the chat page (chats, nodes, projects, topics,
 * providers/models loaded by SettingsService, chat-parameters).
 * Everything else throws so a test cannot silently talk to the real server.
 */
class InMemoryChatApi implements Pick<
  ChatApiPort,
  | 'getChats' | 'createChat' | 'deleteChat' | 'patchChat'
  | 'getNodes' | 'createNode' | 'editAssistant' | 'editUser' | 'branchUser'
  | 'patchNode' | 'deleteNode'
  | 'getPersonas'
  | 'getProjects' | 'createProject' | 'updateProject' | 'deleteProject'
  | 'getTopics' | 'createTopic' | 'updateTopic' | 'deleteTopic'
  | 'addProjectToTopic' | 'removeProjectFromTopic'
  | 'getProviders' | 'createProvider' | 'updateProvider' | 'deleteProvider'
  | 'getModels' | 'createModel' | 'updateModel' | 'deleteModel' | 'toggleModelEnabled'
  | 'getChatParameters' | 'getChatParameter' | 'createChatParameters'
  | 'updateChatParameters' | 'deleteChatParameters'
> {
  chats: Chat[] = [];
  nodes: ChatNode[] = [];
  personas: Persona[] = [];
  projects: Project[] = [];
  topics: Topic[] = [];
  providers: ProviderConfig[] = [];
  models: ModelEntry[] = [];
  parameters: ChatParameters[] = [];

  private n = 0;
  private id(prefix: string) {
    this.n += 1;
    return `${prefix}-${this.n}`;
  }

  // ---------- Chats ----------

  async getChats() {
    return [...this.chats];
  }
  async createChat(title: string, projectId?: string | null) {
    const row: Chat = {
      id: this.id('chat'),
      title,
      projectId: projectId ?? null,
      node_number: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.chats.push(row);
    return row;
  }
  async deleteChat(id: string) {
    this.chats = this.chats.filter(c => c.id !== id);
    this.nodes = this.nodes.filter(n => n.chatId !== id);
  }
  async patchChat(id: string, data: { title?: string; projectId?: string | null; chatParametersId?: string | null }) {
    const row = this.must(this.chats, id, 'Chat');
    Object.assign(row, data, { updated_at: new Date().toISOString() });
    return { ...row };
  }

  // ---------- Nodes ----------

  async getNodes(chatId: string) {
    return this.nodes.filter(n => n.chatId === chatId);
  }
  async createNode(chatId: string, data: CreateNodeRequest) {
    const now = new Date().toISOString();
    const row: ChatNode = {
      id: this.id('node'),
      chatId,
      parentId: data.parentId ?? null,
      role: data.role,
      content: data.content,
      thinking: data.thinking ?? null,
      modelId: data.modelId ?? null,
      providerId: data.providerId ?? null,
      version: 1,
      isCurrent: true,
      createdAt: now,
      updatedAt: now,
      attachments: data.attachments ?? []
    };
    this.nodes.push(row);
    return row;
  }
  async patchNode(chatId: string, nodeId: string, data: {
    content?: string; thinking?: string; attachments?: NodeAttachment[];
    modelId?: string; providerId?: string;
  }) {
    const row = this.must(this.nodes, nodeId, 'Node');
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    return { ...row };
  }
  async deleteNode(chatId: string, nodeId: string) {
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
  }
  async editAssistant(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[], thinking?: string
  ) {
    const parentId = this.must(this.nodes, nodeId, 'Node').parentId;
    return this.createNode(chatId, {
      parentId,
      role: 'assistant',
      content,
      thinking,
      attachments
    });
  }
  async editUser(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[]
  ) {
    const parentId = this.must(this.nodes, nodeId, 'Node').parentId;
    return this.createNode(chatId, {
      parentId,
      role: 'user',
      content,
      attachments
    });
  }
  async branchUser(chatId: string, nodeId: string, data: {
    content: string; modelId?: string; providerId?: string; attachments?: NodeAttachment[];
  }) {
    this.must(this.nodes, nodeId, 'Node');
    return this.createNode(chatId, {
      parentId: nodeId,
      role: 'user',
      content: data.content,
      modelId: data.modelId,
      providerId: data.providerId,
      attachments: data.attachments
    });
  }

  // ---------- Personas ----------

  async getPersonas() {
    return [...this.personas];
  }

  // ---------- Projects ----------

  async getProjects() {
    return [...this.projects];
  }
  async createProject(data: CreateProjectRequest) {
    const now = new Date().toISOString();
    const row: Project = {
      id: this.id('project'),
      name: data.name,
      greeting: data.greeting ?? '',
      systemPrompt: data.systemPrompt ?? '',
      defaultModelId: null,
      avatar: '',
      personaIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.projects.push(row);
    return row;
  }
  async updateProject(id: string, data: UpdateProjectRequest) {
    const row = this.must(this.projects, id, 'Project');
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    return { ...row };
  }
  async deleteProject(id: string, deleteChats = false) {
    this.projects = this.projects.filter(p => p.id !== id);
    if (deleteChats) {
      this.chats = this.chats.filter(c => c.projectId !== id);
    }
  }

  // ---------- Topics ----------

  async getTopics() {
    return [...this.topics];
  }
  async createTopic(data: CreateTopicRequest) {
    const now = new Date().toISOString();
    const row: Topic = {
      id: this.id('topic'),
      name: data.name,
      description: data.description ?? '',
      defaultModelId: null,
      defaultSystemPrompt: data.defaultSystemPrompt ?? '',
      icon: data.icon ?? '',
      projectIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.topics.push(row);
    return row;
  }
  async updateTopic(id: string, data: UpdateTopicRequest) {
    const row = this.must(this.topics, id, 'Topic');
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    return { ...row };
  }
  async deleteTopic(id: string) {
    this.topics = this.topics.filter(t => t.id !== id);
  }
  async addProjectToTopic(topicId: string, projectId: string) {
    const row = this.must(this.topics, topicId, 'Topic');
    if (!row.projectIds.includes(projectId)) row.projectIds.push(projectId);
    return { ...row };
  }
  async removeProjectFromTopic(topicId: string, projectId: string) {
    const row = this.must(this.topics, topicId, 'Topic');
    row.projectIds = row.projectIds.filter(p => p !== projectId);
    return { ...row };
  }

  // ---------- Providers & Models ----------

  async getProviders() {
    return [...this.providers];
  }
  async createProvider(data: CreateProviderRequest) {
    const row: ProviderConfig = { id: this.id('provider'), ...data };
    this.providers.push(row);
    return row;
  }
  async updateProvider(id: string, data: UpdateProviderRequest) {
    const row = this.must(this.providers, id, 'Provider');
    Object.assign(row, data);
    return { ...row };
  }
  async deleteProvider(id: string) {
    this.providers = this.providers.filter(p => p.id !== id);
  }

  async getModels() {
    return [...this.models];
  }
  async createModel(data: CreateModelRequest) {
    const row: ModelEntry = {
      id: this.id('model'),
      displayName: data.displayName,
      modelId: data.modelId,
      providerId: data.providerId,
      type: data.type,
      enabled: data.enabled ?? true,
      architecture: undefined,
      chatParametersId: data['chatParametersId'] ?? null
    };
    this.models.push(row);
    return row;
  }
  async updateModel(id: string, data: UpdateModelRequest) {
    const row = this.must(this.models, id, 'Model');
    Object.assign(row, data);
    return { ...row };
  }
  async deleteModel(id: string) {
    this.models = this.models.filter(m => m.id !== id);
  }
  async toggleModelEnabled(id: string) {
    const row = this.must(this.models, id, 'Model');
    row.enabled = !row.enabled;
    return { id, enabled: row.enabled };
  }

  // ---------- Chat parameters ----------

  async getChatParameters() {
    return [...this.parameters];
  }
  async getChatParameter(id: string) {
    return this.must(this.parameters, id, 'Chat parameters');
  }
  async createChatParameters(data: ChatParametersDraft) {
    const now = new Date().toISOString();
    const row = {
      id: this.id('params'),
      name: data.name || '',
      temperature: data.temperature ?? null,
      topK: data.topK ?? null,
      topM: data.topM ?? null,
      topP: data.topK ?? null,
      stream: data.stream ?? null,
      thinking: data.thinking ?? null,
      thinkingLevel: data.thinkingLevel ?? null,
      reasoningEffort: data.thinkingLevel ?? null,
      createdAt: now,
      updatedAt: now
    } as ChatParameters;
    this.parameters.push(row);
    return row;
  }
  async updateChatParameters(id: string, data: ChatParametersDraft) {
    const row = this.must(this.parameters, id, 'Chat parameters');
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    return { ...row };
  }
  async deleteChatParameters(id: string) {
    this.parameters = this.parameters.filter(p => p.id !== id);
  }

  private must<T extends { id: string }>(rows: T[], id: string, label: string): T {
    const row = rows.find(r => r.id === id);
    if (!row) throw new Error(`${label} not found`);
    return row;
  }
}

export { InMemoryChatApi }
