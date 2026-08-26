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

export interface Topic {
  id: string;
  name: string;
  description: string;
  defaultModelId: string | null;
  defaultSystemPrompt: string;
  icon: string;
  projectIds: string[];
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

export interface NodeAttachment {
  id: string;           // local uuid
  name: string;         // original filename
  mimeType: string;     // e.g. "image/png", "application/pdf"
  size: number;         // bytes
  dataUrl: string;      // data:…;base64,…  (kept for images & small files)
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
  attachments?: NodeAttachment[];
}

export interface CreateNodeRequest {
  parentId?: string | null;
  type: NodeType;
  content: string;
  modelId?: string;
  providerId?: string;
  attachments?: NodeAttachment[];
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

/** Multimodal content accepted by modern chat APIs */
type MessageContent =
  | string
  | Array<{ type: string; text?: string; image_url?: { url: string } }>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}



