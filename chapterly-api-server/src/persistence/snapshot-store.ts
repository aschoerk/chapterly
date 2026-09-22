import type { PersistenceKind, PersistencePort } from '../domain/chat-api.port.js';
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
  Topic
} from '../domain/models.js';
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
  UpdateTopicRequest
} from '../domain/requests.js';
import {
  MemoryPersistence,
  type PersistenceSnapshot,
  type ProviderSnapshot,
  type TopicSnapshot
} from './memory/memory-persistence.js';

export interface SnapshotBackend {
  readonly kind: PersistenceKind;
  listTopicIds(): Promise<string[]>;
  listProviderIds(): Promise<string[]>;
  loadTopic(topicId: string): Promise<TopicSnapshot | null>;
  loadProvider(providerId: string): Promise<ProviderSnapshot | null>;
  saveTopic(snapshot: TopicSnapshot): Promise<{ revision: number; updateId: string }>;
  saveProvider(snapshot: ProviderSnapshot): Promise<{ revision: number; updateId: string }>;
  deleteTopic(topicId: string): Promise<void>;
  deleteProvider(providerId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Domain lives in MemoryPersistence. Disk/cloud only load/save the snapshot.
 */
export class SnapshotPersistence implements PersistencePort {
  readonly kind: PersistenceKind;
  private readonly memory = new MemoryPersistence();

  constructor(private readonly backend: SnapshotBackend) {
    this.kind = backend.kind;
  }

  async init(): Promise<void> {
    const snapshot: PersistenceSnapshot = { topics: [], providers: [] };
    for (const topicId of await this.backend.listTopicIds()) {
      const topic = await this.backend.loadTopic(topicId);
      if (topic) snapshot.topics.push(topic);
    }
    for (const providerId of await this.backend.listProviderIds()) {
      const provider = await this.backend.loadProvider(providerId);
      if (provider) snapshot.providers.push(provider);
    }
    this.memory.importSnapshot(snapshot);
  }

  async close(): Promise<void> {
    await this.flushAll();
    await this.backend.close();
  }

  private async flushTopics(topicIds: string[]): Promise<void> {
    const live = new Set(this.memory.listTopicIds());
    for (const topicId of topicIds) {
      if (live.has(topicId)) {
        const written = await this.backend.saveTopic(this.memory.exportTopicSnapshot(topicId));
        this.memory.acceptTopicWrite(topicId, written.revision, written.updateId);
      } else {
        await this.backend.deleteTopic(topicId);
      }
    }
  }

  private async flushProviders(providerIds: string[]): Promise<void> {
    const live = new Set(this.memory.listProviderIds());
    for (const providerId of providerIds) {
      if (!live.has(providerId)) {
        await this.backend.deleteProvider(providerId);
        continue;
      }
      const snapshot = this.memory.exportProviderSnapshot(providerId);
      if (snapshot) {
        const written = await this.backend.saveProvider(snapshot);
        this.memory.acceptProviderWrite(providerId, written.revision, written.updateId);
      }
    }
  }

  private async flushAll(): Promise<void> {
    await this.flushTopics(this.memory.listTopicIds());
    await this.flushProviders(this.memory.listProviderIds());
  }

  private async flush(): Promise<void> {
    await this.flushAll();
  }

  async getProjects(): Promise<Project[]> {
    return this.memory.getProjects();
  }
  async createProject(data: CreateProjectRequest): Promise<Project> {
    const row = await this.memory.createProject(data);
    await this.flush();
    return row;
  }
  async updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    const row = await this.memory.updateProject(id, data);
    await this.flush();
    return row;
  }
  async deleteProject(id: string, deleteChats?: boolean): Promise<void> {
    await this.memory.deleteProject(id, deleteChats);
    await this.flush();
  }

  async getChats(): Promise<Chat[]> {
    return this.memory.getChats();
  }
  async searchChatIds(q: string): Promise<string[]> {
    return this.memory.searchChatIds(q);
  }
  async createChat(title: string, projectId?: string | null): Promise<Chat> {
    const row = await this.memory.createChat(title, projectId);
    await this.flush();
    return row;
  }
  async cloneChat(chatId: string): Promise<Chat> {
    const row = await this.memory.cloneChat(chatId);
    await this.flush();
    return row;
  }
  async deleteChat(id: string): Promise<void> {
    await this.memory.deleteChat(id);
    await this.flush();
  }
  async patchChat(id: string, data: PatchChatRequest): Promise<Chat> {
    const row = await this.memory.patchChat(id, data);
    await this.flush();
    return row;
  }

  async getNodes(chatId: string): Promise<ChatNode[]> {
    return this.memory.getNodes(chatId);
  }
  async createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    const row = await this.memory.createNode(chatId, data);
    await this.flush();
    return row;
  }
  async editAssistant(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[],
    thinking?: string
  ): Promise<ChatNode> {
    const row = await this.memory.editAssistant(chatId, nodeId, content, attachments, thinking);
    await this.flush();
    return row;
  }
  async editUser(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    const row = await this.memory.editUser(chatId, nodeId, content, attachments);
    await this.flush();
    return row;
  }
  async branchUser(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode> {
    const row = await this.memory.branchUser(chatId, nodeId, data);
    await this.flush();
    return row;
  }
  async patchNode(chatId: string, nodeId: string, data: PatchNodeRequest): Promise<ChatNode> {
    const row = await this.memory.patchNode(chatId, nodeId, data);
    await this.flush();
    return row;
  }
  async deleteNode(chatId: string, nodeId: string, options?: { keepChildren?: boolean }): Promise<void> {
    await this.memory.deleteNode(chatId, nodeId, options);
    await this.flush();
  }

  async getPersonas(): Promise<Persona[]> {
    return this.memory.getPersonas();
  }
  async createPersona(data: CreatePersonaRequest): Promise<Persona> {
    const row = await this.memory.createPersona(data);
    await this.flush();
    return row;
  }
  async updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> {
    const row = await this.memory.updatePersona(id, data);
    await this.flush();
    return row;
  }
  async deletePersona(id: string): Promise<void> {
    await this.memory.deletePersona(id);
    await this.flush();
  }

  async getTopics(): Promise<Topic[]> {
    return this.memory.getTopics();
  }
  async createTopic(data: CreateTopicRequest): Promise<Topic> {
    const row = await this.memory.createTopic(data);
    await this.flush();
    return row;
  }
  async updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> {
    const row = await this.memory.updateTopic(id, data);
    await this.flush();
    return row;
  }
  async deleteTopic(id: string): Promise<Topic | void> {
    const row = await this.memory.deleteTopic(id);
    await this.flush();
    return row;
  }
  async addProjectToTopic(topicId: string, projectId: string): Promise<Topic> {
    const row = await this.memory.addProjectToTopic(topicId, projectId);
    await this.flush();
    return row;
  }
  async removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> {
    const row = await this.memory.removeProjectFromTopic(topicId, projectId);
    await this.flush();
    return row;
  }

  async getProviders(): Promise<ProviderConfig[]> {
    return this.memory.getProviders();
  }
  async createProvider(data: CreateProviderRequest): Promise<ProviderConfig> {
    const row = await this.memory.createProvider(data);
    await this.flush();
    return row;
  }
  async updateProvider(id: string, data: UpdateProviderRequest): Promise<ProviderConfig> {
    const row = await this.memory.updateProvider(id, data);
    await this.flush();
    return row;
  }
  async deleteProvider(id: string): Promise<void> {
    await this.memory.deleteProvider(id);
    await this.flush();
  }

  async getModels(): Promise<ModelEntry[]> {
    return this.memory.getModels();
  }
  async createModel(data: CreateModelRequest): Promise<ModelEntry> {
    const row = await this.memory.createModel(data);
    await this.flush();
    return row;
  }
  async updateModel(id: string, data: UpdateModelRequest): Promise<ModelEntry> {
    const row = await this.memory.updateModel(id, data);
    await this.flush();
    return row;
  }
  async deleteModel(id: string): Promise<void> {
    await this.memory.deleteModel(id);
    await this.flush();
  }
  async toggleModelEnabled(id: string): Promise<ToggleModelResponse> {
    const row = await this.memory.toggleModelEnabled(id);
    await this.flush();
    return row;
  }

  async getChatParameters(): Promise<ChatParameters[]> {
    return this.memory.getChatParameters();
  }
  async getChatParameter(id: string): Promise<ChatParameters> {
    return this.memory.getChatParameter(id);
  }
  async createChatParameters(data: ChatParametersDraft): Promise<ChatParameters> {
    const row = await this.memory.createChatParameters(data);
    await this.flush();
    return row;
  }
  async updateChatParameters(id: string, data: ChatParametersDraft): Promise<ChatParameters> {
    const row = await this.memory.updateChatParameters(id, data);
    await this.flush();
    return row;
  }
  async deleteChatParameters(id: string): Promise<void> {
    await this.memory.deleteChatParameters(id);
    await this.flush();
  }
}

export function emptySnapshot(): PersistenceSnapshot {
  return { topics: [], providers: [] };
}
