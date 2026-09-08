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
import { AuthService } from '../core/auth.service';

/**
 * Cloud + Google login: stories live in IndexedDB, wallet catalog on the server.
 *
 * Content (topics, environments, personas, chats, nodes, chat parameters)
 *   → IdbChatApiService
 * Providers & models
 *   → ChatApiService when an access token is present
 *   → IndexedDB when the user skipped login (no shared wallet)
 */
@Injectable({ providedIn: 'root' })
export class CompositeChatApiService implements ChatApiPort {
  private readonly idb = inject(IdbChatApiService);
  private readonly http = inject(ChatApiService);
  private readonly auth = inject(AuthService);

  /** Server catalog only while a Chapterly access token can authorize the wallet. */
  private catalog(): ChatApiPort {
    return this.auth.accessToken() ? this.http : this.idb;
  }

  getProjects(): Promise<Project[]> {
    return this.idb.getProjects();
  }
  createProject(data: CreateProjectRequest): Promise<Project> {
    return this.idb.createProject(data);
  }
  updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    return this.idb.updateProject(id, data);
  }
  deleteProject(id: string, deleteChats?: boolean): Promise<void> {
    return this.idb.deleteProject(id, deleteChats);
  }

  getChats(): Promise<Chat[]> {
    return this.idb.getChats();
  }
  searchChatIds(q: string): Promise<string[]> {
    return this.idb.searchChatIds(q);
  }
  createChat(title: string, projectId?: string | null): Promise<Chat> {
    return this.idb.createChat(title, projectId);
  }
  cloneChat(chatId: string): Promise<Chat> {
    return this.idb.cloneChat(chatId);
  }
  deleteChat(id: string): Promise<void> {
    return this.idb.deleteChat(id);
  }
  patchChat(id: string, data: PatchChatRequest): Promise<Chat> {
    return this.idb.patchChat(id, data);
  }

  getNodes(chatId: string): Promise<ChatNode[]> {
    return this.idb.getNodes(chatId);
  }
  createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    return this.idb.createNode(chatId, data);
  }
  editAssistant(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[], thinking?: string
  ): Promise<ChatNode> {
    return this.idb.editAssistant(chatId, nodeId, content, attachments, thinking);
  }
  editUser(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    return this.idb.editUser(chatId, nodeId, content, attachments);
  }
  branchUser(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode> {
    return this.idb.branchUser(chatId, nodeId, data);
  }
  patchNode(chatId: string, nodeId: string, data: {
    content?: string; thinking?: string; attachments?: NodeAttachment[];
    modelId?: string; providerId?: string; parentId?: string | null;
  }): Promise<ChatNode> {
    return this.idb.patchNode(chatId, nodeId, data);
  }
  deleteNode(chatId: string, nodeId: string, options?: { keepChildren?: boolean }): Promise<void> {
    return this.idb.deleteNode(chatId, nodeId, options);
  }

  getPersonas(): Promise<Persona[]> {
    return this.idb.getPersonas();
  }
  createPersona(data: CreatePersonaRequest): Promise<Persona> {
    return this.idb.createPersona(data);
  }
  updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> {
    return this.idb.updatePersona(id, data);
  }
  deletePersona(id: string): Promise<void> {
    return this.idb.deletePersona(id);
  }

  getTopics(): Promise<Topic[]> {
    return this.idb.getTopics();
  }
  createTopic(data: CreateTopicRequest): Promise<Topic> {
    return this.idb.createTopic(data);
  }
  updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> {
    return this.idb.updateTopic(id, data);
  }
  deleteTopic(id: string): Promise<Topic | void> {
    return this.idb.deleteTopic(id);
  }
  addProjectToTopic(topicId: string, projectId: string): Promise<Topic> {
    return this.idb.addProjectToTopic(topicId, projectId);
  }
  removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> {
    return this.idb.removeProjectFromTopic(topicId, projectId);
  }

  getProviders(): Promise<ProviderConfig[]> {
    return this.catalog().getProviders();
  }
  createProvider(data: CreateProviderRequest): Promise<ProviderConfig> {
    return this.catalog().createProvider(data);
  }
  updateProvider(id: string, data: UpdateProviderRequest): Promise<ProviderConfig> {
    return this.catalog().updateProvider(id, data);
  }
  deleteProvider(id: string): Promise<void> {
    return this.catalog().deleteProvider(id);
  }

  getModels(): Promise<ModelEntry[]> {
    return this.catalog().getModels();
  }
  createModel(data: CreateModelRequest): Promise<ModelEntry> {
    return this.catalog().createModel(data);
  }
  updateModel(id: string, data: UpdateModelRequest): Promise<ModelEntry> {
    return this.catalog().updateModel(id, data);
  }
  deleteModel(id: string): Promise<void> {
    return this.catalog().deleteModel(id);
  }
  toggleModelEnabled(id: string): Promise<ToggleModelResponse> {
    return this.catalog().toggleModelEnabled(id);
  }

  getChatParameters(): Promise<ChatParameters[]> {
    return this.idb.getChatParameters();
  }
  getChatParameter(id: string): Promise<ChatParameters> {
    return this.idb.getChatParameter(id);
  }
  createChatParameters(data: ChatParametersDraft): Promise<ChatParameters> {
    return this.idb.createChatParameters(data);
  }
  updateChatParameters(id: string, data: ChatParametersDraft): Promise<ChatParameters> {
    return this.idb.updateChatParameters(id, data);
  }
  deleteChatParameters(id: string): Promise<void> {
    return this.idb.deleteChatParameters(id);
  }
}
