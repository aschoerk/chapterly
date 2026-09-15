import { Injectable, inject } from '@angular/core';
import {
  Chat, ChatNode, CreateNodeRequest, Project, Persona, Topic, NodeAttachment
} from '../models/chat';
import { ProviderConfig, ModelEntry } from '../models/chat-config';
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
import { ChatParameters, ChatParametersDraft } from '../models/chat-parameters';
import { ChatApiPort } from './chat-api.port';
import { ChatApiService } from './chat-api.service';
import { IdbChatApiService } from './idb-chat-api.service';
import { EnvironmentService, StorageKind } from '../core/environment.service';

/**
 * Storage split comes from GET /api/environment.
 *   sqlite-all          → HTTP/SQLite
 *   chats-params-idb    → chats + chat-parameters in IDB
 *   content-idb         → all except user/login/auth/providers/models in IDB
 *   theme-local         → personas + environments (projects) in IDB
 */
@Injectable({ providedIn: 'root' })
export class CompositeChatApiService implements ChatApiPort {
  private readonly idb = inject(IdbChatApiService);
  private readonly http = inject(ChatApiService);
  private readonly env = inject(EnvironmentService);

  private api(kind: StorageKind): ChatApiPort {
    return this.env.usesIdb(kind) ? this.idb : this.http;
  }

  getProjects(): Promise<Project[]> {
    return this.api('projects').getProjects();
  }
  createProject(data: CreateProjectRequest): Promise<Project> {
    return this.api('projects').createProject(data);
  }
  updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    return this.api('projects').updateProject(id, data);
  }
  deleteProject(id: string, deleteChats?: boolean): Promise<void> {
    return this.api('projects').deleteProject(id, deleteChats);
  }

  getChats(): Promise<Chat[]> {
    return this.api('chats').getChats();
  }
  searchChatIds(q: string): Promise<string[]> {
    return this.api('chats').searchChatIds(q);
  }
  createChat(title: string, projectId?: string | null): Promise<Chat> {
    return this.api('chats').createChat(title, projectId);
  }
  cloneChat(chatId: string): Promise<Chat> {
    return this.api('chats').cloneChat(chatId);
  }
  deleteChat(id: string): Promise<void> {
    return this.api('chats').deleteChat(id);
  }
  patchChat(id: string, data: PatchChatRequest): Promise<Chat> {
    return this.api('chats').patchChat(id, data);
  }

  getNodes(chatId: string): Promise<ChatNode[]> {
    return this.api('chats').getNodes(chatId);
  }
  createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    return this.api('chats').createNode(chatId, data);
  }
  editAssistant(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[], thinking?: string
  ): Promise<ChatNode> {
    return this.api('chats').editAssistant(chatId, nodeId, content, attachments, thinking);
  }
  editUser(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    return this.api('chats').editUser(chatId, nodeId, content, attachments);
  }
  branchUser(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode> {
    return this.api('chats').branchUser(chatId, nodeId, data);
  }
  patchNode(chatId: string, nodeId: string, data: {
    content?: string; thinking?: string; attachments?: NodeAttachment[];
    modelId?: string; providerId?: string; parentId?: string | null;
  }): Promise<ChatNode> {
    return this.api('chats').patchNode(chatId, nodeId, data);
  }
  deleteNode(chatId: string, nodeId: string, options?: { keepChildren?: boolean }): Promise<void> {
    return this.api('chats').deleteNode(chatId, nodeId, options);
  }

  getPersonas(): Promise<Persona[]> {
    return this.api('personas').getPersonas();
  }
  createPersona(data: CreatePersonaRequest): Promise<Persona> {
    return this.api('personas').createPersona(data);
  }
  updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> {
    return this.api('personas').updatePersona(id, data);
  }
  deletePersona(id: string): Promise<void> {
    return this.api('personas').deletePersona(id);
  }

  getTopics(): Promise<Topic[]> {
    return this.api('topics').getTopics();
  }
  createTopic(data: CreateTopicRequest): Promise<Topic> {
    return this.api('topics').createTopic(data);
  }
  updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> {
    return this.api('topics').updateTopic(id, data);
  }
  deleteTopic(id: string): Promise<Topic | void> {
    return this.api('topics').deleteTopic(id);
  }
  addProjectToTopic(topicId: string, projectId: string): Promise<Topic> {
    return this.api('topics').addProjectToTopic(topicId, projectId);
  }
  removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> {
    return this.api('topics').removeProjectFromTopic(topicId, projectId);
  }

  getProviders(): Promise<ProviderConfig[]> {
    return this.api('providers').getProviders();
  }
  createProvider(data: CreateProviderRequest): Promise<ProviderConfig> {
    return this.api('providers').createProvider(data);
  }
  updateProvider(id: string, data: UpdateProviderRequest): Promise<ProviderConfig> {
    return this.api('providers').updateProvider(id, data);
  }
  deleteProvider(id: string): Promise<void> {
    return this.api('providers').deleteProvider(id);
  }

  getModels(): Promise<ModelEntry[]> {
    return this.api('models').getModels();
  }
  createModel(data: CreateModelRequest): Promise<ModelEntry> {
    return this.api('models').createModel(data);
  }
  updateModel(id: string, data: UpdateModelRequest): Promise<ModelEntry> {
    return this.api('models').updateModel(id, data);
  }
  deleteModel(id: string): Promise<void> {
    return this.api('models').deleteModel(id);
  }
  toggleModelEnabled(id: string): Promise<ToggleModelResponse> {
    return this.api('models').toggleModelEnabled(id);
  }

  getChatParameters(): Promise<ChatParameters[]> {
    return this.api('chat-parameters').getChatParameters();
  }
  getChatParameter(id: string): Promise<ChatParameters> {
    return this.api('chat-parameters').getChatParameter(id);
  }
  createChatParameters(data: ChatParametersDraft): Promise<ChatParameters> {
    return this.api('chat-parameters').createChatParameters(data);
  }
  updateChatParameters(id: string, data: ChatParametersDraft): Promise<ChatParameters> {
    return this.api('chat-parameters').updateChatParameters(id, data);
  }
  deleteChatParameters(id: string): Promise<void> {
    return this.api('chat-parameters').deleteChatParameters(id);
  }
}
