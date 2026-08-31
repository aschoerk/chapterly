import {NodeAttachment} from '../models/chat';
import { ProviderConfig, ModelEntry, ModelArchitecture } from '../models/chat-config';

export interface CreateProjectRequest {
  name: string;
  greeting: string;
  systemPrompt?: string;
  defaultModelId?: string | null;
  chatParametersId?: string | null;
  avatar?: string;
  personaIds?: string[];
}

export type UpdateProjectRequest = Partial<{
  name: string;
  greeting: string;
  systemPrompt: string;
  defaultModelId: string | null;
  chatParametersId: string | null;
  avatar: string;
  personaIds: string[];
  attachments?: NodeAttachment[];
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
}

export type UpdatePersonaRequest = Partial<{
  name: string;
  shortName: string;
  description: string;
  avatar: string;
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

export interface LlmChatMessage {
  role: string;
  content: string;
}

export interface LlmNodeAttachment {
  id: string;           // local uuid
  name: string;         // original filename
  mimeType: string;     // e.g. "image/png", "application/pdf"
  size: number;         // bytes
  dataUrl: string;      // data:…;base64,…  (kept for images & small files)
}


export interface AskLlmOptions {
  providerBaseUrl: string;
  apiKey: string;
  modelId: string;
  messages: LlmChatMessage[];
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  temperature?: number;
}

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
  // allow extra catalog fields
  [key: string]: any;
}
export type UpdateModelRequest = Partial<Omit<ModelEntry, 'id'>>;

export interface ToggleModelResponse {
  id: string;
  enabled: boolean;
}
