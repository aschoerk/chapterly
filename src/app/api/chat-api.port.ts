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

export interface ChatApiPort {
  getProjects(): Promise<Project[]>;
  createProject(data: CreateProjectRequest): Promise<Project>;
  updateProject(id: string, data: UpdateProjectRequest): Promise<Project>;
  deleteProject(id: string, deleteChats?: boolean): Promise<void>;

  getChats(): Promise<Chat[]>;
  createChat(title: string, projectId?: string | null): Promise<Chat>;
  deleteChat(id: string): Promise<void>;
  patchChat(id: string, data: PatchChatRequest): Promise<Chat>;

  getNodes(chatId: string): Promise<ChatNode[]>;
  createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode>;
  editAssistant(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[], thinking?: string
  ): Promise<ChatNode>;
  editUser(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode>;
  branchUser(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode>;
  patchNode(chatId: string, nodeId: string, data: {
    content?: string; thinking?: string; attachments?: NodeAttachment[];
    modelId?: string; providerId?: string;
  }): Promise<ChatNode>;
  deleteNode(chatId: string, nodeId: string): Promise<void>;

  getPersonas(): Promise<Persona[]>;
  createPersona(data: CreatePersonaRequest): Promise<Persona>;
  updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona>;
  deletePersona(id: string): Promise<void>;

  getTopics(): Promise<Topic[]>;
  createTopic(data: CreateTopicRequest): Promise<Topic>;
  updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic>;
  deleteTopic(id: string): Promise<Topic | void>;
  addProjectToTopic(topicId: string, projectId: string): Promise<Topic>;
  removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic>;

  // Providers & Models (for local IDB + cloud parity)
  getProviders(): Promise<ProviderConfig[]>;
  createProvider(data: CreateProviderRequest): Promise<ProviderConfig>;
  updateProvider(id: string, data: UpdateProviderRequest): Promise<ProviderConfig>;
  deleteProvider(id: string): Promise<void>;

  getModels(): Promise<ModelEntry[]>;
  createModel(data: CreateModelRequest): Promise<ModelEntry>;
  updateModel(id: string, data: UpdateModelRequest): Promise<ModelEntry>;
  deleteModel(id: string): Promise<void>;
  toggleModelEnabled(id: string): Promise<ToggleModelResponse>;

  getChatParameters(): Promise<ChatParameters[]>;
  getChatParameter(id: string): Promise<ChatParameters>;
  createChatParameters(data: ChatParametersDraft): Promise<ChatParameters>;
  updateChatParameters(id: string, data: ChatParametersDraft): Promise<ChatParameters>;
  deleteChatParameters(id: string): Promise<void>;
}
