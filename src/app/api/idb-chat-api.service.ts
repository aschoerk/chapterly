import { Injectable } from '@angular/core';
import {
  Chat, ChatNode, CreateNodeRequest, Project, Persona, Topic, NodeAttachment
} from '../models/chat';
import {
  BranchQuestionRequest,
  CreatePersonaRequest,
  CreateProjectRequest,
  CreateTopicRequest,
  PatchChatRequest,
  UpdatePersonaRequest,
  UpdateProjectRequest,
  UpdateTopicRequest,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateModelRequest,
  UpdateModelRequest,
  ToggleModelResponse
} from './chat-api.types';
import { ChatApiPort } from './chat-api.port';
import { ProviderConfig, ModelEntry } from '../models/chat-config';
import { ChatParameters, ChatParametersDraft } from '../models/chat-parameters';

const DB_NAME = 'chat-client';
const DB_VERSION = 3;

type StoreName = 'projects' | 'topics' | 'personas' | 'chats' | 'nodes' | 'providers' | 'models' | 'chatParameters';

@Injectable({ providedIn: 'root' })
export class IdbChatApiService implements ChatApiPort {
  private dbPromise = this.open();

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('topics')) db.createObjectStore('topics', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('personas')) db.createObjectStore('personas', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chats')) {
          const s = db.createObjectStore('chats', { keyPath: 'id' });
          s.createIndex('by-project', 'projectId');
        }
        if (!db.objectStoreNames.contains('nodes')) {
          const s = db.createObjectStore('nodes', { keyPath: 'id' });
          s.createIndex('by-chat', 'chatId');
          s.createIndex('by-parent', 'parentId');
        }
        if (!db.objectStoreNames.contains('providers')) db.createObjectStore('providers', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('models')) db.createObjectStore('models', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chatParameters')) {
          const store = db.createObjectStore('chatParameters', { keyPath: 'id' });
          try {
            const raw = localStorage.getItem('chat.parameters.cache');
            const rows = raw ? JSON.parse(raw) : [];
            if (Array.isArray(rows)) {
              for (const row of rows) {
                if (row?.id) store.put(row);
              }
            }
          } catch { /* ignore broken cache */ }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async tx<T>(
    stores: StoreName[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T>
  ): Promise<T> {
    const db = await this.dbPromise;
    const tx = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const result = await work(tx);
    await done;
    return result;
  }

  private req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  private all<T>(store: IDBObjectStore | IDBIndex): Promise<T[]> {
    return this.req(store.getAll()) as Promise<T[]>;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private id(): string {
    return crypto.randomUUID();
  }

  // ---------- Projects ----------
  async getProjects(): Promise<Project[]> {
    return this.tx(['projects'], 'readonly', tx =>
      this.all<Project>(tx.objectStore('projects'))
    );
  }

  async createProject(data: CreateProjectRequest): Promise<Project> {
    const row: Project = {
      id: this.id(),
      name: data.name,
      greeting: data.greeting ?? '',
      systemPrompt: data.systemPrompt ?? '',
      defaultModelId: data.defaultModelId ?? null,
      chatParametersId: data.chatParametersId ?? null,
      avatar: data.avatar ?? '',
      personaIds: data.personaIds ?? [],
      createdAt: this.now(),
      updatedAt: this.now()
    };
    await this.tx(['projects'], 'readwrite', tx =>
      this.req(tx.objectStore('projects').put(row))
    );
    return row;
  }

  async updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    return this.tx(['projects'], 'readwrite', async tx => {
      const store = tx.objectStore('projects');
      const row = await this.req<Project>(store.get(id));
      if (!row) throw Object.assign(new Error('Project not found'), { status: 404 });
      const next = { ...row, ...data, id, updatedAt: this.now() };
      await this.req(store.put(next));
      return next;
    });
  }

  async deleteProject(id: string, deleteChats = false): Promise<void> {
    await this.tx(['projects', 'chats', 'nodes'], 'readwrite', async tx => {
      await this.req(tx.objectStore('projects').delete(id));
      const chats = await this.all<Chat>(tx.objectStore('chats').index('by-project'));
      // by-project index matches projectId; filter in case of nulls
      const mine = (await this.all<Chat>(tx.objectStore('chats')))
        .filter(c => c.projectId === id);
      for (const chat of mine) {
        if (deleteChats) {
          await this.deleteChatTree(tx, chat.id);
          await this.req(tx.objectStore('chats').delete(chat.id));
        } else {
          await this.req(tx.objectStore('chats').put({ ...chat, projectId: null, updated_at: this.now() }));
        }
      }
    });
  }

  // ---------- Chats ----------
  async getChats(): Promise<Chat[]> {
    const list = await this.tx(['chats'], 'readonly', tx =>
      this.all<Chat>(tx.objectStore('chats'))
    );
    return list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async createChat(title = 'New Chat', projectId: string | null = null): Promise<Chat> {
    const row: Chat = {
      id: this.id(),
      title,
      projectId,
      chatParametersId: null,
      node_number: 0,
      created_at: this.now(),
      updated_at: this.now()
    };
    await this.tx(['chats'], 'readwrite', tx =>
      this.req(tx.objectStore('chats').put(row))
    );
    return row;
  }

  async deleteChat(id: string): Promise<void> {
    await this.tx(['chats', 'nodes'], 'readwrite', async tx => {
      await this.deleteChatTree(tx, id);
      await this.req(tx.objectStore('chats').delete(id));
    });
  }

  async patchChat(id: string, data: PatchChatRequest): Promise<Chat> {
    return this.tx(['chats'], 'readwrite', async tx => {
      const store = tx.objectStore('chats');
      const row = await this.req<Chat>(store.get(id));
      if (!row) throw Object.assign(new Error('Chat not found'), { status: 404 });
      const next: Chat = {
        ...row,
        title: data.title?.trim() ? data.title.trim() : row.title,
        projectId: data.projectId !== undefined ? data.projectId : row.projectId,
        chatParametersId: data.chatParametersId !== undefined ? data.chatParametersId : row.chatParametersId,
        updated_at: this.now()
      };
      await this.req(store.put(next));
      return next;
    });
  }

  // ---------- Nodes ----------
  async getNodes(chatId: string): Promise<ChatNode[]> {
    const list = await this.tx(['nodes'], 'readonly', tx =>
      this.req<ChatNode[]>(tx.objectStore('nodes').index('by-chat').getAll(chatId))
    );
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    const row: ChatNode = {
      id: this.id(),
      chatId,
      parentId: data.parentId ?? null,
      role: data.role,
      content: data.content ?? '',
      thinking: data.thinking ?? null,
      modelId: data.modelId ?? null,
      providerId: data.providerId ?? null,
      version: 1,
      previousVersionId: null,
      isCurrent: true,
      createdAt: this.now(),
      updatedAt: this.now(),
      attachments: data.attachments ?? [],
      chatParametersId: (data as any).chatParametersId ?? null
    };
    await this.tx(['nodes', 'chats'], 'readwrite', async tx => {
      await this.req(tx.objectStore('nodes').put(row));
      await this.touchChat(tx, chatId,1);
    });
    return row;
  }

  async editAssistant(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[], thinking?: string
  ): Promise<ChatNode> {
    return this.editNodeVersion(nodeId, 'assistant', { content, attachments, thinking });
  }

  async editUser(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    return this.editNodeVersion(nodeId, 'user', { content, attachments });
  }

  async branchUser(
    chatId: string, nodeId: string, data: BranchQuestionRequest
  ): Promise<ChatNode> {
    return this.tx(['nodes', 'chats'], 'readwrite', async tx => {
      const nodes = tx.objectStore('nodes');
      const old = await this.req<ChatNode>(nodes.get(nodeId));
      if (!old) throw Object.assign(new Error('Node not found'), { status: 404 });
      if (old.role !== 'user') throw Object.assign(new Error('Only user nodes can be branched'), { status: 400 });
      const row: ChatNode = {
        id: this.id(),
        chatId: old.chatId,
        parentId: old.parentId,
        role: 'user',
        content: data.content,
        thinking: null,
        modelId: data.modelId ?? old.modelId,
        providerId: data.providerId ?? old.providerId,
        version: 1,
        previousVersionId: null,
        isCurrent: true,
        createdAt: this.now(),
        updatedAt: this.now(),
        attachments: data.attachments ?? old.attachments ?? []
      };
      await this.req(nodes.put(row));
      await this.touchChat(tx, old.chatId,0);
      return row;
    });
  }

  async patchNode(
    chatId: string, nodeId: string,
    data: { content?: string; thinking?: string; attachments?: NodeAttachment[]; modelId?: string; providerId?: string }
  ): Promise<ChatNode> {
    return this.tx(['nodes', 'chats'], 'readwrite', async tx => {
      const store = tx.objectStore('nodes');
      const old = await this.req<ChatNode>(store.get(nodeId));
      if (!old) throw Object.assign(new Error('Node not found'), { status: 404 });
      const next: ChatNode = {
        ...old,
        content: data.content !== undefined ? data.content : old.content,
        thinking: data.thinking !== undefined ? data.thinking : old.thinking,
        attachments: data.attachments !== undefined ? data.attachments : old.attachments,
        modelId: data.modelId !== undefined ? data.modelId : old.modelId,
        providerId: data.providerId !== undefined ? data.providerId : old.providerId,
        updatedAt: this.now()
      };
      await this.req(store.put(next));
      await this.touchChat(tx, old.chatId,0);
      return next;
    });
  }

  async deleteNode(chatId: string, nodeId: string): Promise<void> {
    await this.tx(['nodes', 'chats'], 'readwrite', async tx => {
      const all = await this.req<ChatNode[]>(tx.objectStore('nodes').index('by-chat').getAll(chatId));
      const drop = new Set<string>();
      const walk = (id: string) => {
        drop.add(id);
        all.filter(n => n.parentId === id).forEach(c => walk(c.id));
      };
      walk(nodeId);
      for (const id of drop) await this.req(tx.objectStore('nodes').delete(id));
      await this.touchChat(tx, chatId, drop.size);
    });
  }

  // ---------- Personas / Topics (same pattern) ----------
  async getPersonas(): Promise<Persona[]> {
    return this.tx(['personas'], 'readonly', tx => this.all(tx.objectStore('personas')));
  }
  async createPersona(data: CreatePersonaRequest): Promise<Persona> {
    const row: Persona = {
      id: this.id(),
      name: data.name,
      shortName: data.shortName ?? data.name,
      description: data.description ?? '',
      avatar: data.avatar ?? '',
      createdAt: this.now(),
      updatedAt: this.now()
    };
    await this.tx(['personas'], 'readwrite', tx => this.req(tx.objectStore('personas').put(row)));
    return row;
  }
  async updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> {
    return this.tx(['personas'], 'readwrite', async tx => {
      const s = tx.objectStore('personas');
      const row = await this.req<Persona>(s.get(id));
      if (!row) throw Object.assign(new Error('Persona not found'), { status: 404 });
      const next = { ...row, ...data, id, updatedAt: this.now() };
      await this.req(s.put(next));
      return next;
    });
  }
  async deletePersona(id: string): Promise<void> {
    await this.tx(['personas'], 'readwrite', tx => this.req(tx.objectStore('personas').delete(id)));
  }

  async getTopics(): Promise<Topic[]> {
    return this.tx(['topics'], 'readonly', tx => this.all(tx.objectStore('topics')));
  }
  async createTopic(data: CreateTopicRequest): Promise<Topic> {
    const row: Topic = {
      id: this.id(),
      name: data.name,
      description: data.description ?? '',
      defaultModelId: data.defaultModelId ?? null,
      defaultSystemPrompt: data.defaultSystemPrompt ?? '',
      chatParametersId: data.chatParametersId ?? null,
      icon: data.icon ?? '',
      projectIds: data.projectIds ?? [],
      createdAt: this.now(),
      updatedAt: this.now()
    };
    await this.tx(['topics'], 'readwrite', tx => this.req(tx.objectStore('topics').put(row)));
    return row;
  }
  async updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> {
    return this.tx(['topics'], 'readwrite', async tx => {
      const s = tx.objectStore('topics');
      const row = await this.req<Topic>(s.get(id));
      if (!row) throw Object.assign(new Error('Topic not found'), { status: 404 });
      const next = { ...row, ...data, id, updatedAt: this.now() };
      await this.req(s.put(next));
      return next;
    });
  }
  async deleteTopic(id: string): Promise<void> {
    await this.tx(['topics'], 'readwrite', tx => this.req(tx.objectStore('topics').delete(id)));
  }
  async addProjectToTopic(topicId: string, projectId: string): Promise<Topic> {
    return this.updateTopic(topicId, {
      projectIds: [...new Set([...(await this.mustTopic(topicId)).projectIds, projectId])]
    } as UpdateTopicRequest);
  }
  async removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> {
    const t = await this.mustTopic(topicId);
    return this.updateTopic(topicId, {
      projectIds: t.projectIds.filter(id => id !== projectId)
    } as UpdateTopicRequest);
  }

  // ---------- Providers ----------
  async getProviders(): Promise<ProviderConfig[]> {
    return this.tx(['providers'], 'readonly', tx =>
      this.all<ProviderConfig>(tx.objectStore('providers'))
    );
  }

  async createProvider(data: CreateProviderRequest): Promise<ProviderConfig> {
    const row: ProviderConfig = {
      id: this.id(),
      name: data.name,
      type: data.type,
      baseUrl: data.baseUrl,
      apiKey: data.apiKey,
      enabled: data.enabled ?? true
    };
    await this.tx(['providers'], 'readwrite', tx =>
      this.req(tx.objectStore('providers').put(row))
    );
    return row;
  }

  async updateProvider(id: string, data: UpdateProviderRequest): Promise<ProviderConfig> {
    return this.tx(['providers'], 'readwrite', async tx => {
      const store = tx.objectStore('providers');
      const row = await this.req<ProviderConfig>(store.get(id));
      if (!row) throw Object.assign(new Error('Provider not found'), { status: 404 });
      const next = { ...row, ...data, id };
      await this.req(store.put(next));
      return next;
    });
  }

  async deleteProvider(id: string): Promise<void> {
    await this.tx(['providers', 'models'], 'readwrite', async tx => {
      await this.req(tx.objectStore('providers').delete(id));
      const models = await this.all<ModelEntry>(tx.objectStore('models'));
      for (const m of models) {
        if (m.providerId === id) await this.req(tx.objectStore('models').delete(m.id));
      }
    });
  }

  // ---------- Models ----------
  async getModels(): Promise<ModelEntry[]> {
    return this.tx(['models'], 'readonly', tx =>
      this.all<ModelEntry>(tx.objectStore('models'))
    );
  }

  async createModel(data: CreateModelRequest): Promise<ModelEntry> {
    const row: ModelEntry = {
      id: this.id(),
      displayName: data.displayName,
      modelId: data.modelId,
      providerId: data.providerId,
      type: data.type,
      enabled: data.enabled ?? true,
      architecture: data.architecture,
      contextLength: (data as any).contextLength,
      description: (data as any).description,
      // spread other possible catalog fields
      ...(data as any)
    } as ModelEntry;
    await this.tx(['models'], 'readwrite', tx =>
      this.req(tx.objectStore('models').put(row))
    );
    return row;
  }

  async updateModel(id: string, data: UpdateModelRequest): Promise<ModelEntry> {
    return this.tx(['models'], 'readwrite', async tx => {
      const store = tx.objectStore('models');
      const row = await this.req<ModelEntry>(store.get(id));
      if (!row) throw Object.assign(new Error('Model not found'), { status: 404 });
      const next = { ...row, ...data, id };
      await this.req(store.put(next));
      return next;
    });
  }

  async deleteModel(id: string): Promise<void> {
    await this.tx(['models'], 'readwrite', tx =>
      this.req(tx.objectStore('models').delete(id))
    );
  }

  // ---------- Chat parameters ----------
  async getChatParameters(): Promise<ChatParameters[]> {
    return this.tx(['chatParameters'], 'readonly', tx =>
      this.all<ChatParameters>(tx.objectStore('chatParameters'))
    );
  }

  async getChatParameter(id: string): Promise<ChatParameters> {
    const row = await this.tx(['chatParameters'], 'readonly', tx =>
      this.req<ChatParameters>(tx.objectStore('chatParameters').get(id))
    );
    if (!row) throw Object.assign(new Error('Chat parameters not found'), { status: 404 });
    return row;
  }

  async createChatParameters(data: ChatParametersDraft): Promise<ChatParameters> {
    const now = this.now();
    const row: ChatParameters = {
      id: this.id(),
      name: data.name || '',
      temperature: data.temperature ?? null,
      topK: data.topK ?? null,
      topM: data.topM ?? null,
      topP: data.topM ?? null,
      stream: data.stream ?? null,
      thinking: data.thinking ?? null,
      thinkingLevel: data.thinkingLevel ?? null,
      reasoningEffort: data.thinkingLevel ?? null,
      createdAt: now,
      updatedAt: now
    };
    await this.tx(['chatParameters'], 'readwrite', tx =>
      this.req(tx.objectStore('chatParameters').put(row))
    );
    return row;
  }

  async updateChatParameters(id: string, data: ChatParametersDraft): Promise<ChatParameters> {
    return this.tx(['chatParameters'], 'readwrite', async tx => {
      const store = tx.objectStore('chatParameters');
      const row = await this.req<ChatParameters>(store.get(id));
      if (!row) throw Object.assign(new Error('Chat parameters not found'), { status: 404 });
      const next: ChatParameters = {
        ...row,
        name: data.name ?? row.name,
        temperature: data.temperature,
        topK: data.topK,
        topM: data.topM,
        topP: data.topM,
        stream: data.stream,
        thinking: data.thinking,
        thinkingLevel: data.thinkingLevel,
        reasoningEffort: data.thinkingLevel,
        updatedAt: this.now()
      };
      await this.req(store.put(next));
      return next;
    });
  }

  async deleteChatParameters(id: string): Promise<void> {
    await this.tx(
      ['chatParameters', 'projects', 'topics', 'chats', 'nodes', 'models'],
      'readwrite',
      async tx => {
        await this.req(tx.objectStore('chatParameters').delete(id));
        await this.clearOwnerParam(tx, 'projects', id);
        await this.clearOwnerParam(tx, 'topics', id);
        await this.clearOwnerParam(tx, 'chats', id);
        await this.clearOwnerParam(tx, 'nodes', id);
        await this.clearOwnerParam(tx, 'models', id);
      }
    );
  }

  private async clearOwnerParam(tx: IDBTransaction, storeName: StoreName, paramId: string): Promise<void> {
    const store = tx.objectStore(storeName);
    const rows = await this.all<any>(store);
    for (const row of rows) {
      if (row.chatParametersId === paramId) {
        await this.req(store.put({ ...row, chatParametersId: null }));
      }
    }
  }

  async toggleModelEnabled(id: string): Promise<ToggleModelResponse> {
    return this.tx(['models'], 'readwrite', async tx => {
      const store = tx.objectStore('models');
      const row = await this.req<ModelEntry>(store.get(id));
      if (!row) throw Object.assign(new Error('Model not found'), { status: 404 });
      const next: ModelEntry = { ...row, enabled: !row.enabled };
      await this.req(store.put(next));
      return { id, enabled: next.enabled };
    });
  }

  // ---------- internals ----------
  private async mustTopic(id: string): Promise<Topic> {
    const list = await this.getTopics();
    const t = list.find(x => x.id === id);
    if (!t) throw Object.assign(new Error('Topic not found'), { status: 404 });
    return t;
  }

  private async editNodeVersion(
    nodeId: string,
    expectedRole: 'system' | 'user' | 'assistant',
    data: { content: string; attachments?: NodeAttachment[]; thinking?: string }
  ): Promise<ChatNode> {
    return this.tx(['nodes', 'chats'], 'readwrite', async tx => {
      const store = tx.objectStore('nodes');
      const old = await this.req<ChatNode>(store.get(nodeId));
      if (!old) throw Object.assign(new Error('Node not found'), { status: 404 });
      if (old.role !== expectedRole) {
        throw Object.assign(new Error(`Only ${expectedRole}s can be versioned this way`), { status: 400 });
      }

      const children = await this.req<ChatNode[]>(store.index('by-parent').getAll(old.id));
      const isEmptyNode = !String(old.content || '').trim();
      const nextThinking = data.thinking !== undefined ? data.thinking : old.thinking;
      const nextAttachments = data.attachments !== undefined
        ? data.attachments
        : (old.attachments ?? []);

      // Empty leaf: keep the same row. Otherwise insert a successor version.
      if (isEmptyNode && children.length === 0) {
        const updated: ChatNode = {
          ...old,
          content: data.content,
          thinking: nextThinking,
          attachments: nextAttachments,
          updatedAt: this.now()
        };
        await this.req(store.put(updated));
        await this.touchChat(tx, old.chatId, 0);
        return updated;
      }

      const next: ChatNode = {
        ...old,
        id: this.id(),
        content: data.content,
        thinking: nextThinking,
        attachments: nextAttachments,
        version: (old.version || 1) + 1,
        previousVersionId: old.id,
        isCurrent: true,
        createdAt: this.now(),
        updatedAt: this.now()
      };
      await this.req(store.put({ ...old, isCurrent: false }));
      await this.req(store.put(next));
      for (const child of children) {
        await this.req(store.put({ ...child, parentId: next.id, updatedAt: this.now() }));
      }
      await this.touchChat(tx, old.chatId, 1);
      return next;
    });
  }

  private async touchChat(tx: IDBTransaction, chatId: string, node_number_diff: number): Promise<void> {
    const store = tx.objectStore('chats');
    const chat = await this.req<Chat>(store.get(chatId));
    if (chat) await this.req(store.put({ ...chat, node_number: chat.node_number + node_number_diff, updated_at: this.now() }));
  }

  private async deleteChatTree(tx: IDBTransaction, chatId: string): Promise<void> {
    const idx = tx.objectStore('nodes').index('by-chat');
    const nodes = await this.req<ChatNode[]>(idx.getAll(chatId));
    for (const n of nodes) await this.req(tx.objectStore('nodes').delete(n.id));
  }
}
