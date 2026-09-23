import {
  Chat,
  ChatNode,
  NodeAttachment,
  Persona,
  Project,
  Topic
} from '../src/app/models/chat';
import { ModelEntry, ProviderConfig } from '../src/app/models/chat-config';
import { InMemoryChatApi } from './in-memory-chat-api';

const now = (): string => new Date().toISOString();

/**
 * Shared seed factories for specs.
 *
 * Every factory takes a `Partial<T>` override object and fills in sensible
 * defaults, so specs can write `makeChat({ title: 'Dragon hunt' })` instead of
 * repeating the full object shape. Use these instead of defining per-spec
 * `project()/chat()/node()/...` helpers (they are thin aliases to these).
 *
 * Timestamps: `updatedAt`/`updated_at` derive from the creation timestamp when
 * not explicitly provided, so date-sort determinism holds out of the box.
 */

export function makeProject(o: Partial<Project> = {}): Project {
  const createdAt = o.createdAt ?? now();
  return {
    id: 'p-1',
    name: 'Env A',
    greeting: '',
    systemPrompt: '',
    defaultModelId: null,
    avatar: '',
    personaIds: [],
    createdAt,
    updatedAt: o.updatedAt ?? createdAt,
    ...o
  };
}

export function makeTopic(o: Partial<Topic> = {}): Topic {
  const createdAt = o.createdAt ?? now();
  return {
    id: 't-1',
    name: 'Topic A',
    description: '',
    defaultModelId: null,
    defaultSystemPrompt: '',
    icon: '',
    projectIds: [],
    createdAt,
    updatedAt: o.updatedAt ?? createdAt,
    ...o
  };
}

export function makeChat(o: Partial<Chat> = {}): Chat {
  const createdAt = o.created_at ?? now();
  return {
    id: 'chat-1',
    title: 'Story 1',
    projectId: null,
    node_number: 0,
    created_at: createdAt,
    updated_at: o.updated_at ?? createdAt,
    ...o
  };
}

export function makePersona(o: Partial<Persona> = {}): Persona {
  const createdAt = o.createdAt ?? now();
  return {
    id: 'pers-1',
    name: 'Author',
    shortName: 'Au',
    description: '',
    avatar: '',
    createdAt,
    updatedAt: o.updatedAt ?? createdAt,
    ...o
  };
}

export function makeNode(o: Partial<ChatNode> = {}): ChatNode {
  const createdAt = o.createdAt ?? now();
  return {
    id: 'n1',
    chatId: 'chat-1',
    parentId: null,
    role: 'user',
    content: '',
    version: 1,
    isCurrent: true,
    createdAt,
    updatedAt: o.updatedAt ?? createdAt,
    ...o
  };
}

export function makeAttachment(o: Partial<NodeAttachment> = {}): NodeAttachment {
  return {
    id: 'att-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 12,
    dataUrl: 'data:text/plain;base64,aGk="',
    ...o
  };
}

export function makeProvider(o: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'prov-1',
    name: 'OpenRouter',
    type: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-test-1234567890',
    enabled: true,
    ...o
  };
}

export function makeModel(o: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'm-1',
    displayName: 'Alpha',
    modelId: 'alpha/model',
    providerId: 'prov-1',
    type: 'preset',
    enabled: true,
    ...o
  };
}

/** Push batches of partial seeds into an in-memory API through the factories. */
export function seedApi(
  api: InMemoryChatApi,
  items: {
    projects?: Partial<Project>[];
    chats?: Partial<Chat>[];
    topics?: Partial<Topic>[];
    personas?: Partial<Persona>[];
    nodes?: Partial<ChatNode>[];
    providers?: Partial<ProviderConfig>[];
    models?: Partial<ModelEntry>[];
  }
): void {
  api.projects.push(...(items.projects?.map(makeProject) ?? []));
  api.chats.push(...(items.chats?.map(makeChat) ?? []));
  api.topics.push(...(items.topics?.map(makeTopic) ?? []));
  api.personas.push(...(items.personas?.map(makePersona) ?? []));
  api.nodes.push(...(items.nodes?.map(makeNode) ?? []));
  api.providers.push(...(items.providers?.map(makeProvider) ?? []));
  api.models.push(...(items.models?.map(makeModel) ?? []));
}