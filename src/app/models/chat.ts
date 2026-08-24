export type NodeType = 'question' | 'answer';

export interface Project {
  id: string;
  name: string;
  greeting: string;
  systemPrompt: string;
  defaultModelId: string | null;
  avatar: string;
  personaIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Chat {
  id: string;
  title: string;
  projectId?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatNode {
  id: string;
  chatId: string;
  parentId: string | null;
  type: NodeType;
  content: string;
  modelId?: string | null;
  providerId?: string | null;
  version: number;
  previousVersionId?: string | null;
  isCurrent: boolean;
  createdAt: string;
  updatedAt?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

export interface CreateNodeRequest {
  parentId?: string | null;
  type: NodeType;
  content: string;
  modelId?: string;
  providerId?: string;
}

export interface Persona {
  id: string;
  name: string;
  shortName: string;
  description: string;
  avatar: string;
  createdAt: string;
  updatedAt: string;
}
