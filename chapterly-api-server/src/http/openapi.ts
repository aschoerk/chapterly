import type { Express, Request, Response } from 'express';

type Schema = {
  type?: string;
  format?: string;
  nullable?: boolean;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  $ref?: string;
  enum?: Array<string | number | boolean>;
  additionalProperties?: boolean | Schema;
  example?: unknown;
};

type Parameter = {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema: Schema;
  description?: string;
};

type Operation = {
  tags: string[];
  summary: string;
  operationId: string;
  parameters?: Parameter[];
  requestBody?: {
    required?: boolean;
    content: { 'application/json': { schema: Schema } };
  };
  responses: Record<string, {
    description: string;
    content?: { 'application/json': { schema: Schema } };
  }>;
};

type PathItem = {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
};

export type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, Schema> };
};

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const idParam = (name = 'id'): Parameter => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
});

function json(schema: Schema): { 'application/json': { schema: Schema } } {
  return { 'application/json': { schema } };
}

function ok(schema: Schema, description = 'OK'): Operation['responses'] {
  return { '200': { description, content: json(schema) } };
}

function created(schema: Schema): Operation['responses'] {
  return { '201': { description: 'Created', content: json(schema) } };
}

const noContent: Operation['responses'] = {
  '204': { description: 'No content' },
  '404': { description: 'Not found', content: json(ref('Error')) },
};

const thinkingLevel: Schema = {
  type: 'string',
  nullable: true,
  enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};

export const openApiSpec: OpenApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Chapterly API',
    version: '0.1.0',
    description:
      'HTTP surface of ChatApiPort. Persistence is partitioned by topic and provider; conflicting snapshot revisions return 409.',
  },
  servers: [
    { url: 'http://127.0.0.1:3847', description: 'Local / Electron' },
    { url: '/', description: 'Current origin' },
  ],
  tags: [
    { name: 'Meta', description: 'Health, environment, OpenAPI' },
    { name: 'Projects', description: 'Environments belonging to topics' },
    { name: 'Chats', description: 'Conversations and clone/search' },
    { name: 'Nodes', description: 'Chat tree, versions, branches' },
    { name: 'Personas', description: 'Characters' },
    { name: 'Topics', description: 'Content partitions' },
    { name: 'Providers', description: 'LLM credentials' },
    { name: 'Models', description: 'Catalog entries' },
    { name: 'ChatParameters', description: 'Sampling / thinking settings' },
    { name: 'Proxy', description: 'Streaming LLM forwarder (not on ChatApiPort)' }
  ],
  paths: {
    '/proxy/chat/completions': {
      post: {
        tags: ['Proxy'],
        summary: 'Stream chat completions to the provider (SSE)',
        operationId: 'proxyChatCompletions',
        parameters: [
          {
            name: 'x-target-base',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: 'Provider base URL (BYOK). Required if x-provider-id is omitted.'
          },
          {
            name: 'x-provider-id',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: 'Stored provider id; uses its baseUrl and apiKey'
          },
          {
            name: 'Authorization',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: 'Bearer provider API key when using x-target-base'
          }
        ],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['model', 'messages'],
            properties: {
              model: { type: 'string' },
              messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
              temperature: { type: 'number' },
              stream: { type: 'boolean', example: true }
            }
          })
        },
        responses: {
          '200': {
            description: 'Upstream SSE or JSON',
            content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } }
          },
          '400': { description: 'Missing x-target-base or x-provider-id', content: json(ref('Error')) }
        }
      }
    },
    '/api/health': {
      get: {
        tags: ['Meta'],
        summary: 'Health check',
        operationId: 'getHealth',
        responses: ok({
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            persistence: { type: 'string', enum: ['memory', 'sqlite', 'firebase'] },
          },
        }),
      },
    },
    '/api/environment': {
      get: {
        tags: ['Meta'],
        summary: 'Storage split for the SPA composite API',
        operationId: 'getEnvironment',
        responses: ok({
          type: 'object',
          properties: {
            runtime: { type: 'string' },
            persistence: { type: 'string' },
            storage: {
              type: 'object',
              properties: {
                profile: { type: 'string' },
                sqlite: { type: 'array', items: { type: 'string' } },
                idb: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        }),
      },
    },
    '/api/openapi.json': {
      get: {
        tags: ['Meta'],
        summary: 'OpenAPI 3 document',
        operationId: 'getOpenApi',
        responses: {
          '200': {
            description: 'OpenAPI document',
            content: {
              'application/json': { schema: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
    '/api/projects': {
      get: {
        tags: ['Projects'],
        summary: 'List projects',
        operationId: 'getProjects',
        responses: ok({ type: 'array', items: ref('Project') }),
      },
      post: {
        tags: ['Projects'],
        summary: 'Create project',
        operationId: 'createProject',
        requestBody: { required: true, content: json(ref('CreateProjectRequest')) },
        responses: created(ref('Project')),
      },
    },
    '/api/projects/{id}': {
      put: {
        tags: ['Projects'],
        summary: 'Update project',
        operationId: 'updateProject',
        parameters: [idParam()],
        requestBody: { required: true, content: json(ref('UpdateProjectRequest')) },
        responses: {
          ...ok(ref('Project')),
          '404': { description: 'Not found', content: json(ref('Error')) },
        },
      },
      delete: {
        tags: ['Projects'],
        summary: 'Delete project',
        operationId: 'deleteProject',
        parameters: [
          idParam(),
          {
            name: 'deleteChats',
            in: 'query',
            schema: { type: 'boolean' },
            description: 'Also delete chats of this project',
          },
        ],
        responses: noContent,
      },
    },
    '/api/chats': {
      get: {
        tags: ['Chats'],
        summary: 'List chats',
        operationId: 'getChats',
        responses: ok({ type: 'array', items: ref('Chat') }),
      },
      post: {
        tags: ['Chats'],
        summary: 'Create chat',
        operationId: 'createChat',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              projectId: { type: 'string', nullable: true },
            },
          }),
        },
        responses: created(ref('Chat')),
      },
    },
    '/api/chats/search-ids': {
      get: {
        tags: ['Chats'],
        summary: 'Search chat ids by title or current-node content',
        operationId: 'searchChatIds',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: ok({ type: 'array', items: { type: 'string' } }),
      },
    },
    '/api/chats/{id}': {
      patch: {
        tags: ['Chats'],
        summary: 'Patch chat',
        operationId: 'patchChat',
        parameters: [idParam()],
        requestBody: { required: true, content: json(ref('PatchChatRequest')) },
        responses: {
          ...ok(ref('Chat')),
          '404': { description: 'Not found', content: json(ref('Error')) },
        },
      },
      delete: {
        tags: ['Chats'],
        summary: 'Delete chat and its nodes',
        operationId: 'deleteChat',
        parameters: [idParam()],
        responses: noContent,
      },
    },
    '/api/chats/{id}/clone': {
      post: {
        tags: ['Chats'],
        summary: 'Deep-copy a chat and remap node ids',
        operationId: 'cloneChat',
        parameters: [idParam()],
        responses: created(ref('Chat')),
      },
    },
    '/api/chats/{id}/nodes': {
      get: {
        tags: ['Nodes'],
        summary: 'List nodes of a chat',
        operationId: 'getNodes',
        parameters: [idParam()],
        responses: ok({ type: 'array', items: ref('ChatNode') }),
      },
      post: {
        tags: ['Nodes'],
        summary: 'Create node',
        operationId: 'createNode',
        parameters: [idParam()],
        requestBody: { required: true, content: json(ref('CreateNodeRequest')) },
        responses: created(ref('ChatNode')),
      },
    },
    '/api/chats/{id}/nodes/{nodeId}/edit-assistant': {
      post: {
        tags: ['Nodes'],
        summary: 'New assistant version of a node',
        operationId: 'editAssistant',
        parameters: [idParam(), idParam('nodeId')],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['content'],
            properties: {
              content: { type: 'string' },
              thinking: { type: 'string' },
              attachments: { type: 'array', items: ref('NodeAttachment') },
            },
          }),
        },
        responses: ok(ref('ChatNode')),
      },
    },
    '/api/chats/{id}/nodes/{nodeId}/edit-user': {
      post: {
        tags: ['Nodes'],
        summary: 'New user version of a node',
        operationId: 'editUser',
        parameters: [idParam(), idParam('nodeId')],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['content'],
            properties: {
              content: { type: 'string' },
              attachments: { type: 'array', items: ref('NodeAttachment') },
            },
          }),
        },
        responses: ok(ref('ChatNode')),
      },
    },
    '/api/chats/{id}/nodes/{nodeId}/branch-user': {
      post: {
        tags: ['Nodes'],
        summary: 'Branch a new user node from the same parent',
        operationId: 'branchUser',
        parameters: [idParam(), idParam('nodeId')],
        requestBody: { required: true, content: json(ref('BranchQuestionRequest')) },
        responses: ok(ref('ChatNode')),
      },
    },
    '/api/chats/{id}/nodes/{nodeId}': {
      patch: {
        tags: ['Nodes'],
        summary: 'Patch node fields in place',
        operationId: 'patchNode',
        parameters: [idParam(), idParam('nodeId')],
        requestBody: { required: true, content: json(ref('PatchNodeRequest')) },
        responses: ok(ref('ChatNode')),
      },
      delete: {
        tags: ['Nodes'],
        summary: 'Delete node',
        operationId: 'deleteNode',
        parameters: [
          idParam(),
          idParam('nodeId'),
          {
            name: 'keepChildren',
            in: 'query',
            schema: { type: 'boolean' },
            description: 'Reparent children instead of deleting the subtree',
          },
        ],
        responses: noContent,
      },
    },
    '/api/personas': {
      get: {
        tags: ['Personas'],
        summary: 'List personas',
        operationId: 'getPersonas',
        responses: ok({ type: 'array', items: ref('Persona') }),
      },
      post: {
        tags: ['Personas'],
        summary: 'Create persona',
        operationId: 'createPersona',
        requestBody: { required: true, content: json(ref('CreatePersonaRequest')) },
        responses: created(ref('Persona')),
      },
    },
    '/api/personas/{id}': {
      put: {
        tags: ['Personas'],
        summary: 'Update persona',
        operationId: 'updatePersona',
        parameters: [idParam()],
        requestBody: { required: true, content: json(ref('UpdatePersonaRequest')) },
        responses: ok(ref('Persona')),
      },
      delete: {
        tags: ['Personas'],
        summary: 'Delete persona',
        operationId: 'deletePersona',
        parameters: [idParam()],
        responses: noContent,
      },
    },
    '/api/topics': {
      get: {
        tags: ['Topics'],
        summary: 'List topics',
        operationId: 'getTopics',
        responses: ok({ type: 'array', items: ref('Topic') }),
      },
      post: {
        tags: ['Topics'],
        summary: 'Create topic',
        operationId: 'createTopic',
        requestBody: { required: true, content: json(ref('CreateTopicRequest')) },
        responses: created(ref('Topic')),
      },
    },
    '/api/topics/{id}': {
      put: {
        tags: ['Topics'],
        summary: 'Update topic',
        operationId: 'updateTopic',
        parameters: [idParam()],
        requestBody: { required: true, content: json(ref('UpdateTopicRequest')) },
        responses: ok(ref('Topic')),
      },
      delete: {
        tags: ['Topics'],
        summary: 'Delete topic',
        operationId: 'deleteTopic',
        parameters: [idParam()],
        responses: noContent,
      },
    },
    '/api/topics/{id}/projects': {
      post: {
        tags: ['Topics'],
        summary: 'Attach a project to a topic',
        operationId: 'addProjectToTopic',
        parameters: [idParam()],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['projectId'],
            properties: { projectId: { type: 'string' } },
          }),
        },
        responses: ok(ref('Topic')),
      },
    },
    '/api/topics/{id}/projects/{projectId}': {
      delete: {
        tags: ['Topics'],
        summary: 'Detach a project from a topic',
        operationId: 'removeProjectFromTopic',
        parameters: [idParam(), idParam('projectId')],
        responses: ok(ref('Topic')),
      },
    },
    '/api/providers': {
      get: {
        tags: ['Providers'],
        summary: 'List providers',
        operationId: 'getProviders',
        responses: ok({ type: 'array', items: ref('ProviderConfig') }),
      },
      post: {
        tags: ['Providers'],
        summary: 'Create provider',
        operationId: 'createProvider',
        requestBody: { required: true, content: json(ref('CreateProviderRequest')) },
        responses: created(ref('ProviderConfig')),
      },
    },
    '/api/providers/{id}': {
      put: {
        tags: ['Providers'],
        summary: 'Update provider',
        operationId: 'updateProvider',
        parameters: [idParam()],
        requestBody: { required: true, content: json(ref('UpdateProviderRequest')) },
        responses: ok(ref('ProviderConfig')),
      },
      delete: {
        tags: ['Providers'],
        summary: 'Delete provider',
        operationId: 'deleteProvider',
        parameters: [idParam()],
        responses: noContent,
      },
    },
    '/api/models': {
      get: {
        tags: ['Models'],
        summary: 'List models',
        operationId: 'getModels',
        responses: ok({ type: 'array', items: ref('ModelEntry') }),
      },
      post: {
        tags: ['Models'],
        summary: 'Create model',
        operationId: 'createModel',
        requestBody: { required: true, content: json(ref('CreateModelRequest')) },
        responses: created(ref('ModelEntry')),
      },
    },
    '/api/models/{id}': {
      put: {
        tags: ['Models'],
        summary: 'Update model',
        operationId: 'updateModel',
        parameters: [idParam()],
        requestBody: { required: true, content: json(ref('UpdateModelRequest')) },
        responses: ok(ref('ModelEntry')),
      },
      delete: {
        tags: ['Models'],
        summary: 'Delete model',
        operationId: 'deleteModel',
        parameters: [idParam()],
        responses: noContent,
      },
    },
    '/api/models/{id}/toggle': {
      patch: {
        tags: ['Models'],
        summary: 'Toggle model enabled',
        operationId: 'toggleModelEnabled',
        parameters: [idParam()],
        responses: ok(ref('ToggleModelResponse')),
      },
    },
    '/api/chat-parameters': {
      get: {
        tags: ['ChatParameters'],
        summary: 'List chat parameters',
        operationId: 'getChatParameters',
        responses: ok({ type: 'array', items: ref('ChatParameters') }),
      },
      post: {
        tags: ['ChatParameters'],
        summary: 'Create chat parameters',
        operationId: 'createChatParameters',
        requestBody: { required: true, content: json(ref('ChatParametersDraft')) },
        responses: created(ref('ChatParameters')),
      },
    },
    '/api/chat-parameters/{id}': {
      get: {
        tags: ['ChatParameters'],
        summary: 'Get chat parameters',
        operationId: 'getChatParameter',
        parameters: [idParam()],
        responses: ok(ref('ChatParameters')),
      },
      patch: {
        tags: ['ChatParameters'],
        summary: 'Update chat parameters',
        operationId: 'updateChatParameters',
        parameters: [idParam()],
        requestBody: { required: true, content: json(ref('ChatParametersDraft')) },
        responses: ok(ref('ChatParameters')),
      },
      delete: {
        tags: ['ChatParameters'],
        summary: 'Delete chat parameters',
        operationId: 'deleteChatParameters',
        parameters: [idParam()],
        responses: noContent,
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
      NodeAttachment: {
        type: 'object',
        required: ['id', 'name', 'mimeType', 'size', 'dataUrl'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          mimeType: { type: 'string' },
          size: { type: 'number' },
          dataUrl: { type: 'string' },
        },
      },
      Project: {
        type: 'object',
        required: [
          'id',
          'name',
          'greeting',
          'systemPrompt',
          'defaultModelId',
          'avatar',
          'personaIds',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          greeting: { type: 'string' },
          systemPrompt: { type: 'string' },
          defaultModelId: { type: 'string', nullable: true },
          chatParametersId: { type: 'string', nullable: true },
          avatar: { type: 'string' },
          personaIds: { type: 'array', items: { type: 'string' } },
          mainTopicId: { type: 'string', nullable: true },
          topicIds: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CreateProjectRequest: {
        type: 'object',
        required: ['name', 'greeting'],
        properties: {
          name: { type: 'string' },
          greeting: { type: 'string' },
          systemPrompt: { type: 'string' },
          defaultModelId: { type: 'string', nullable: true },
          chatParametersId: { type: 'string', nullable: true },
          avatar: { type: 'string' },
          personaIds: { type: 'array', items: { type: 'string' } },
          mainTopicId: { type: 'string', nullable: true },
          topicId: { type: 'string', nullable: true },
          topicIds: { type: 'array', items: { type: 'string' } },
        },
      },
      UpdateProjectRequest: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          greeting: { type: 'string' },
          systemPrompt: { type: 'string' },
          defaultModelId: { type: 'string', nullable: true },
          chatParametersId: { type: 'string', nullable: true },
          avatar: { type: 'string' },
          personaIds: { type: 'array', items: { type: 'string' } },
          mainTopicId: { type: 'string', nullable: true },
          topicId: { type: 'string', nullable: true },
          topicIds: { type: 'array', items: { type: 'string' } },
        },
      },
      Topic: {
        type: 'object',
        required: [
          'id',
          'name',
          'description',
          'defaultModelId',
          'defaultSystemPrompt',
          'icon',
          'projectIds',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          defaultModelId: { type: 'string', nullable: true },
          chatParametersId: { type: 'string', nullable: true },
          defaultSystemPrompt: { type: 'string' },
          icon: { type: 'string' },
          projectIds: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CreateTopicRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          defaultModelId: { type: 'string', nullable: true },
          chatParametersId: { type: 'string', nullable: true },
          defaultSystemPrompt: { type: 'string' },
          icon: { type: 'string' },
          projectIds: { type: 'array', items: { type: 'string' } },
        },
      },
      UpdateTopicRequest: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          defaultModelId: { type: 'string', nullable: true },
          chatParametersId: { type: 'string', nullable: true },
          defaultSystemPrompt: { type: 'string' },
          icon: { type: 'string' },
        },
      },
      Chat: {
        type: 'object',
        required: ['id', 'title', 'node_number', 'created_at', 'updated_at'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          projectId: { type: 'string', nullable: true },
          chatParametersId: { type: 'string', nullable: true },
          node_number: { type: 'number' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      PatchChatRequest: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          projectId: { type: 'string', nullable: true },
          chatParametersId: { type: 'string', nullable: true },
        },
      },
      ChatNode: {
        type: 'object',
        required: [
          'id',
          'chatId',
          'parentId',
          'role',
          'content',
          'version',
          'isCurrent',
          'createdAt',
        ],
        properties: {
          id: { type: 'string' },
          chatId: { type: 'string' },
          parentId: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['system', 'user', 'assistant'] },
          content: { type: 'string' },
          thinking: { type: 'string', nullable: true },
          modelId: { type: 'string', nullable: true },
          providerId: { type: 'string', nullable: true },
          version: { type: 'number' },
          previousVersionId: { type: 'string', nullable: true },
          isCurrent: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time', nullable: true },
          promptTokens: { type: 'number', nullable: true },
          completionTokens: { type: 'number', nullable: true },
          attachments: { type: 'array', items: ref('NodeAttachment') },
          chatParametersId: { type: 'string', nullable: true },
        },
      },
      CreateNodeRequest: {
        type: 'object',
        required: ['role', 'content'],
        properties: {
          parentId: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['system', 'user', 'assistant'] },
          content: { type: 'string' },
          thinking: { type: 'string' },
          modelId: { type: 'string' },
          providerId: { type: 'string' },
          attachments: { type: 'array', items: ref('NodeAttachment') },
          chatParametersId: { type: 'string', nullable: true },
        },
      },
      PatchNodeRequest: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          thinking: { type: 'string' },
          attachments: { type: 'array', items: ref('NodeAttachment') },
          modelId: { type: 'string' },
          providerId: { type: 'string' },
          parentId: { type: 'string', nullable: true },
        },
      },
      BranchQuestionRequest: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string' },
          modelId: { type: 'string' },
          providerId: { type: 'string' },
          attachments: { type: 'array', items: ref('NodeAttachment') },
        },
      },
      Persona: {
        type: 'object',
        required: ['id', 'name', 'shortName', 'description', 'avatar', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          shortName: { type: 'string' },
          description: { type: 'string' },
          avatar: { type: 'string' },
          mainTopicId: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CreatePersonaRequest: {
        type: 'object',
        required: ['name', 'shortName'],
        properties: {
          name: { type: 'string' },
          shortName: { type: 'string' },
          description: { type: 'string' },
          avatar: { type: 'string' },
          mainTopicId: { type: 'string', nullable: true },
        },
      },
      UpdatePersonaRequest: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          shortName: { type: 'string' },
          description: { type: 'string' },
          avatar: { type: 'string' },
          mainTopicId: { type: 'string', nullable: true },
        },
      },
      ProviderConfig: {
        type: 'object',
        required: ['id', 'name', 'type', 'baseUrl', 'apiKey', 'enabled'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['openrouter', 'openai', 'custom'] },
          baseUrl: { type: 'string' },
          apiKey: { type: 'string' },
          enabled: { type: 'boolean' },
        },
      },
      CreateProviderRequest: {
        type: 'object',
        required: ['name', 'type', 'baseUrl', 'apiKey', 'enabled'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['openrouter', 'openai', 'custom'] },
          baseUrl: { type: 'string' },
          apiKey: { type: 'string' },
          enabled: { type: 'boolean' },
        },
      },
      UpdateProviderRequest: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['openrouter', 'openai', 'custom'] },
          baseUrl: { type: 'string' },
          apiKey: { type: 'string' },
          enabled: { type: 'boolean' },
        },
      },
      ModelArchitecture: {
        type: 'object',
        required: ['input_modalities', 'output_modalities'],
        properties: {
          modality: { type: 'string' },
          input_modalities: { type: 'array', items: { type: 'string' } },
          output_modalities: { type: 'array', items: { type: 'string' } },
          tokenizer: { type: 'string' },
          instruct_type: { type: 'string', nullable: true },
        },
      },
      ModelEntry: {
        type: 'object',
        required: ['id', 'displayName', 'modelId', 'providerId', 'type', 'enabled'],
        properties: {
          id: { type: 'string' },
          displayName: { type: 'string' },
          modelId: { type: 'string' },
          providerId: { type: 'string' },
          type: { type: 'string', enum: ['fetched', 'preset', 'discontinued'] },
          enabled: { type: 'boolean' },
          chatParametersId: { type: 'string', nullable: true },
          description: { type: 'string' },
          contextLength: { type: 'number' },
          architecture: ref('ModelArchitecture'),
        },
      },
      CreateModelRequest: {
        type: 'object',
        required: ['displayName', 'modelId', 'providerId', 'type', 'enabled'],
        properties: {
          displayName: { type: 'string' },
          modelId: { type: 'string' },
          providerId: { type: 'string' },
          type: { type: 'string', enum: ['fetched', 'preset', 'discontinued'] },
          enabled: { type: 'boolean' },
          architecture: ref('ModelArchitecture'),
          contextLength: { type: 'number' },
          description: { type: 'string' },
        },
      },
      UpdateModelRequest: {
        type: 'object',
        additionalProperties: true,
      },
      ToggleModelResponse: {
        type: 'object',
        required: ['id', 'enabled'],
        properties: {
          id: { type: 'string' },
          enabled: { type: 'boolean' },
        },
      },
      ChatParameters: {
        type: 'object',
        required: [
          'id',
          'name',
          'temperature',
          'topK',
          'topM',
          'stream',
          'thinking',
          'thinkingLevel',
        ],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          temperature: { type: 'number', nullable: true },
          topK: { type: 'number', nullable: true },
          topM: { type: 'number', nullable: true },
          topP: { type: 'number', nullable: true },
          stream: { type: 'boolean', nullable: true },
          thinking: { type: 'boolean', nullable: true },
          thinkingLevel,
          reasoningEffort: thinkingLevel,
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ChatParametersDraft: {
        type: 'object',
        required: ['temperature', 'topK', 'topM', 'stream', 'thinking', 'thinkingLevel'],
        properties: {
          name: { type: 'string' },
          temperature: { type: 'number', nullable: true },
          topK: { type: 'number', nullable: true },
          topM: { type: 'number', nullable: true },
          stream: { type: 'boolean', nullable: true },
          thinking: { type: 'boolean', nullable: true },
          thinkingLevel,
        },
      },
    },
  },
};

const swaggerUiHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Chapterly API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis],
      tryItOutEnabled: false,
      supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch', 'options']
    });
  </script>
</body>
</html>
`;

export function registerOpenApiRoutes(app: Express): void {
  const sendSpec = (_req: Request, res: Response) => {
    res.json(openApiSpec);
  };
  const sendUi = (_req: Request, res: Response) => {
    res.type('html').send(swaggerUiHtml);
  };

  app.get('/api/openapi.json', sendSpec);
  app.get(['/api/docs', '/api/docs/', '/api/api-docs', '/api/api-docs/'], sendUi);
}
