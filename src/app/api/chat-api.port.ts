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
  UpdateTopicRequest
} from './chat-api.types';

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
  editAnswer(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[], thinking?: string
  ): Promise<ChatNode>;
  editQuestion(
    chatId: string, nodeId: string, content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode>;
  branchQuestion(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode>;
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
}
