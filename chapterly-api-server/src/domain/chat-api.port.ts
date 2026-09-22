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
} from './models.js';
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
} from './requests.js';

/**
 * Same contract as src/app/api/chat-api.port.ts in the Angular app.
 */
export interface ChatApiPort {
  getProjects(): Promise<Project[]>;
  createProject(data: CreateProjectRequest): Promise<Project>;
  updateProject(id: string, data: UpdateProjectRequest): Promise<Project>;
  deleteProject(id: string, deleteChats?: boolean): Promise<void>;

  getChats(): Promise<Chat[]>;
  searchChatIds(q: string): Promise<string[]>;
  createChat(title: string, projectId?: string | null): Promise<Chat>;
  cloneChat(chatId: string): Promise<Chat>;
  deleteChat(id: string): Promise<void>;
  patchChat(id: string, data: PatchChatRequest): Promise<Chat>;

  getNodes(chatId: string): Promise<ChatNode[]>;
  createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode>;
  editAssistant(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[],
    thinking?: string
  ): Promise<ChatNode>;
  editUser(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode>;
  branchUser(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode>;
  patchNode(chatId: string, nodeId: string, data: PatchNodeRequest): Promise<ChatNode>;
  deleteNode(chatId: string, nodeId: string, options?: { keepChildren?: boolean }): Promise<void>;

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

export type PersistenceKind = 'memory' | 'sqlite' | 'firebase';

export interface PersistencePort extends ChatApiPort {
  readonly kind: PersistenceKind;
  init(): Promise<void>;
  close(): Promise<void>;
}
