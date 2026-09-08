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
 * Google login (access token, not Electron):
 *   content → IndexedDB
 *   providers/models → HTTP wallet
 * Otherwise (Electron, skip, password-only local):
 *   everything → chat-server HTTP/SQLite
 */
@Injectable({ providedIn: 'root' })
export class CompositeChatApiService implements ChatApiPort {
  private readonly idb = inject(IdbChatApiService);
  private readonly http = inject(ChatApiService);
  private readonly auth = inject(AuthService);

  /** True only after a Chapterly access token exists in the browser. */
  private googleCloud(): boolean {
    return !this.auth.electron && !!this.auth.accessToken();
  }

  private content(): ChatApiPort {
    return this.googleCloud() ? this.idb : this.http;
  }

  private catalog(): ChatApiPort {
    return this.http;
  }

  getProjects(): Promise<Project[]> {
    return this.content().getProjects();
  }
  createProject(data: CreateProjectRequest): Promise<Project> {
    return this.content().createProject(data);
  }
  updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    return this.content().updateProject(id, data);
  }
  deleteProject(id: string, deleteChats?: boolean): Promise<void> {
    return this.content().deleteProject(id, deleteChats);
  }

  getChats(): Promise<Chat[]> {
    return this.content().getChats();
  }
  searchChatIds(q: string): Promise<string[]> {
    return this.content().searchChatIds(q);
  }
  createChat(title: string, projectId?: string | null): Promise<Chat> {
    return this.content().createChat(title, projectId);
  }
  cloneChat(chatId: string): Promise<Chat> {
    return this.content().cloneChat(chatId);
  }
  deleteChat(id: string): Promise<void> {
    return this.content().deleteChat(id);
  }
  patchChat(id: string, data: PatchChatRequest): Promise<Chat> {
    return this.content().patchChat(id, data);
  }

  getNodes(chatId: string): Promise<ChatNode[]> {
    return this.content().getNodes(chatId);
  }
  createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    return this.content().createNode(chatId, data);
  }
  editAssistant(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[], thinking?: string
  ): Promise<ChatNode> {
    return this.content().editAssistant(chatId, nodeId, content, attachments, thinking);
  }
  editUser(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    return this.content().editUser(chatId, nodeId, content, attachments);
  }
  branchUser(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode> {
    return this.content().branchUser(chatId, nodeId, data);
  }
  patchNode(chatId: string, nodeId: string, data: {
    content?: string; thinking?: string; attachments?: NodeAttachment[];
    modelId?: string; providerId?: string; parentId?: string | null;
  }): Promise<ChatNode> {
    return this.content().patchNode(chatId, nodeId, data);
  }
  deleteNode(chatId: string, nodeId: string, options?: { keepChildren?: boolean }): Promise<void> {
    return this.content().deleteNode(chatId, nodeId, options);
  }

  getPersonas(): Promise<Persona[]> {
    return this.content().getPersonas();
  }
  createPersona(data: CreatePersonaRequest): Promise<Persona> {
    return this.content().createPersona(data);
  }
  updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> {
    return this.content().updatePersona(id, data);
  }
  deletePersona(id: string): Promise<void> {
    return this.content().deletePersona(id);
  }

  getTopics(): Promise<Topic[]> {
    return this.content().getTopics();
  }
  createTopic(data: CreateTopicRequest): Promise<Topic> {
    return this.content().createTopic(data);
  }
  updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> {
    return this.content().updateTopic(id, data);
  }
  deleteTopic(id: string): Promise<Topic | void> {
    return this.content().deleteTopic(id);
  }
  addProjectToTopic(topicId: string, projectId: string): Promise<Topic> {
    return this.content().addProjectToTopic(topicId, projectId);
  }
  removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> {
    return this.content().removeProjectFromTopic(topicId, projectId);
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
    return this.content().getChatParameters();
  }
  getChatParameter(id: string): Promise<ChatParameters> {
    return this.content().getChatParameter(id);
  }
  createChatParameters(data: ChatParametersDraft): Promise<ChatParameters> {
    return this.content().createChatParameters(data);
  }
  updateChatParameters(id: string, data: ChatParametersDraft): Promise<ChatParameters> {
    return this.content().updateChatParameters(id, data);
  }
  deleteChatParameters(id: string): Promise<void> {
    return this.content().deleteChatParameters(id);
  }
}
