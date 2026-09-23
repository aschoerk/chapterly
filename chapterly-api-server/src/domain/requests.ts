import type { ModelArchitecture, ModelEntry, NodeAttachment, ProviderConfig } from './models.js';

export interface CreateProjectRequest {
  name: string;
  greeting: string;
  systemPrompt?: string;
  defaultModelId?: string | null;
  chatParametersId?: string | null;
  avatar?: string;
  personaIds?: string[];
  mainTopicId?: string | null;
  topicId?: string | null;
  topicIds?: string[];
}

export type UpdateProjectRequest = Partial<{
  name: string;
  greeting: string;
  systemPrompt: string;
  defaultModelId: string | null;
  chatParametersId: string | null;
  avatar: string;
  personaIds: string[];
  mainTopicId: string | null;
  topicId: string | null;
  topicIds: string[];
  attachments: NodeAttachment[];
}>;

export interface PatchChatRequest {
  title?: string;
  projectId?: string | null;
  chatParametersId?: string | null;
}

export interface BranchQuestionRequest {
  content: string;
  modelId?: string;
  providerId?: string;
  attachments?: NodeAttachment[];
}

export interface CreatePersonaRequest {
  name: string;
  shortName: string;
  description?: string;
  avatar?: string;
  mainTopicId?: string | null;
}

export type UpdatePersonaRequest = Partial<{
  name: string;
  shortName: string;
  description: string;
  avatar: string;
  mainTopicId: string | null;
}>;

export interface CreateTopicRequest {
  name: string;
  description?: string;
  defaultModelId?: string | null;
  chatParametersId?: string | null;
  defaultSystemPrompt?: string;
  icon?: string;
  projectIds?: string[];
}

export type UpdateTopicRequest = Partial<{
  name: string;
  description: string;
  defaultModelId: string | null;
  chatParametersId: string | null;
  defaultSystemPrompt: string;
  icon: string;
}>;

export type CreateProviderRequest = Omit<ProviderConfig, 'id'>;
export type UpdateProviderRequest = Partial<Omit<ProviderConfig, 'id'>>;

export interface CreateModelRequest {
  displayName: string;
  modelId: string;
  providerId: string;
  type: 'fetched' | 'preset' | 'discontinued';
  enabled: boolean;
  architecture?: ModelArchitecture;
  contextLength?: number;
  description?: string;
}

export type UpdateModelRequest = Partial<Omit<ModelEntry, 'id'>>;

export interface ToggleModelResponse {
  id: string;
  enabled: boolean;
}

export interface PatchNodeRequest {
  content?: string;
  thinking?: string;
  attachments?: NodeAttachment[];
  modelId?: string;
  providerId?: string;
  parentId?: string | null;
}
