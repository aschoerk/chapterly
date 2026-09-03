const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Chat Server API',
      version: '1.0.0',
      description: 'API for the Chat Client (providers, models, chats, nodes, projects, personas, chat parameters)'
    },
    servers: [
      {
        url: 'http://localhost:3847',
        description: 'Local development server'
      }
    ],
    tags: [
      { name: 'Providers', description: 'AI provider configuration' },
      { name: 'Models', description: 'Available models and presets' },
      { name: 'Chats', description: 'Chat management' },
      { name: 'Topics', description: 'Topic / grouping management for projects' },
      { name: 'Nodes', description: 'Chat nodes (questions & answers)' },
      { name: 'Projects', description: 'Project / workspace management' },
      { name: 'Personas', description: 'Reusable personas / characters for chats' },
      { name: 'ChatParameters', description: 'Reusable LLM generation parameters (OpenAI-compatible extensions)' }
    ],
    components: {
      schemas: {
        Provider: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000'
            },
            name: {
              type: 'string',
              example: 'OpenRouter'
            },
            type: {
              type: 'string',
              example: 'openrouter'
            },
            baseUrl: {
              type: 'string',
              example: 'https://openrouter.ai/api/v1'
            },
            apiKey: {
              type: 'string',
              example: 'sk-or-v1-...'
            },
            enabled: {
              type: 'boolean',
              example: true
            }
          }
        },
        Model: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid'
            },
            displayName: {
              type: 'string',
              example: 'Claude 3.5 Sonnet'
            },
            modelId: {
              type: 'string',
              example: 'anthropic/claude-3.5-sonnet'
            },
            providerId: {
              type: 'string',
              format: 'uuid'
            },
            type: {
              type: 'string',
              enum: ['fetched', 'preset', 'discontinued'],
              example: 'preset'
            },
            enabled: {
              type: 'boolean',
              example: true
            },
            contextLength: {
              type: 'integer',
              nullable: true,
              example: 200000
            },
            chatParametersId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Optional owned chat_parameters set'
            }
          }
        },
        Chat: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000'
            },
            title: {
              type: 'string',
              example: 'My first chat'
            },
            created_at: {
              type: 'string',
              format: 'date-time'
            },
            updated_at: {
              type: 'string',
              format: 'date-time'
            },
            chatParametersId: {
              type: 'string',
              format: 'uuid',
              nullable: true
            }
          }
        },
        NodeAttachment: {
          type: 'object',
          required: ['id', 'name', 'mimeType', 'size', 'dataUrl'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'Local unique id of the attachment'
            },
            name: {
              type: 'string',
              description: 'Original filename',
              example: 'screenshot.png'
            },
            mimeType: {
              type: 'string',
              description: 'MIME type of the file',
              example: 'image/png'
            },
            size: {
              type: 'integer',
              description: 'File size in bytes',
              example: 245760
            },
            dataUrl: {
              type: 'string',
              description: 'Full data-URL (data:…;base64,…)',
              example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...'
            }
          }
        },

        ChatNode: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid'
            },
            chatId: {
              type: 'string',
              format: 'uuid'
            },
            parentId: {
              type: 'string',
              format: 'uuid',
              nullable: true
            },
            role: {
              type: 'string',
              enum: ['system', 'user', 'assistant']
            },
            content: {
              type: 'string'
            },
            thinking: {
              type: 'string'
            },
            modelId: {
              type: 'string',
              nullable: true
            },
            providerId: {
              type: 'string',
              nullable: true
            },
            version: {
              type: 'integer',
              minimum: 1
            },
            previousVersionId: {
              type: 'string',
              format: 'uuid',
              nullable: true
            },
            isCurrent: {
              type: 'boolean'
            },
            createdAt: {
              type: 'string',
              format: 'date-time'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true
            },
            promptTokens: {
              type: 'integer',
              nullable: true
            },
            completionTokens: {
              type: 'integer',
              nullable: true
            },
            attachments: {
              type: 'array',
              description: 'Optional file attachments belonging to this node',
              items: {
                $ref: '#/components/schemas/NodeAttachment'
              },
              default: []
            },
            chatParametersId: {
              type: 'string',
              format: 'uuid',
              nullable: true
            }
          }
        },

        ChatParameters: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Creative streaming' },
            temperature: { type: 'number', nullable: true, example: 0.7, description: 'OpenAI temperature (0-2)' },
            topK: { type: 'integer', nullable: true, example: 40, description: 'OpenAI-compatible top_k extension' },
            topM: { type: 'number', nullable: true, example: 0.95, description: 'Nucleus-style cap stored as top_m' },
            topP: { type: 'number', nullable: true, example: 0.95, description: 'OpenAI top_p alias of topM' },
            stream: { type: 'boolean', nullable: true, example: true },
            thinking: { type: 'boolean', nullable: true, example: false, description: 'Enable model reasoning / thinking output' },
            thinkingLevel: {
              type: 'string',
              nullable: true,
              enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
              description: 'Maps to OpenAI reasoning_effort'
            },
            reasoningEffort: {
              type: 'string',
              nullable: true,
              enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        ChatParametersInput: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            temperature: { type: 'number', nullable: true },
            topK: { type: 'integer', nullable: true },
            top_k: { type: 'integer', nullable: true },
            topM: { type: 'number', nullable: true },
            top_m: { type: 'number', nullable: true },
            topP: { type: 'number', nullable: true },
            top_p: { type: 'number', nullable: true },
            stream: { type: 'boolean', nullable: true },
            thinking: { type: 'boolean', nullable: true },
            thinkingLevel: { type: 'string', nullable: true, enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
            reasoningEffort: { type: 'string', nullable: true, enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }
          }
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              example: 'Chat not found'
            }
          }
        },
        Project: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000'
            },
            name: {
              type: 'string',
              example: 'Roleplay Research'
            },
            greeting: {
              type: 'string',
              example: 'Hi'
            },
            systemPrompt: {
              type: 'string',
              example: 'You are a helpful research assistant focused on narrative structure.'
            },
            defaultModelId: {
              type: 'string',
              nullable: true,
              description: 'Optional default model id for chats in this project'
            },
            chatParametersId: {
              type: 'string',
              format: 'uuid',
              nullable: true
            },
            avatar: {
              type: 'string',
              description: 'URL or data URL for the project avatar',
              example: 'https://example.com/avatars/project.png'
            },
            personaIds: {
              type: 'array',
              description: 'IDs of personas linked to this project',
              items: {
                type: 'string',
                format: 'uuid'
              },
              example: ['550e8400-e29b-41d4-a716-446655440001']
            },
            createdAt: {
              type: 'string',
              format: 'date-time'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time'
            }
          }
        },
        Topic: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid'
            },
            name: {
              type: 'string'
            },
            description: {
              type: 'string'
            },
            defaultModelId: {
              type: 'string',
              nullable: true
            },
            chatParametersId: {
              type: 'string',
              format: 'uuid',
              nullable: true
            },
            defaultSystemPrompt: {
              type: 'string'
            },
            icon: {
              type: 'string'
            },
            projectIds: {
              type: 'array',
              items: {
                type: 'string',
                format: 'uuid'
              }
            },
            createdAt: {
              type: 'string',
              format: 'date-time'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time'
            }
          }
        },
        Persona: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '550e8400-e29b-41d4-a716-446655440000'
            },
            name: {
              type: 'string',
              example: 'Dr. Elena Voss'
            },
            shortName: {
              type: 'string',
              example: 'Elena'
            },
            description: {
              type: 'string',
              example: 'A brilliant but emotionally distant quantum physicist who slowly opens up...'
            },
            avatar: {
              type: 'string',
              description: 'URL or data URL for the persona avatar',
              example: 'https://example.com/avatars/elena.png'
            },
            createdAt: {
              type: 'string',
              format: 'date-time'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time'
            }
          }
        }
      }
    }
  },
  apis: ['./src/routes/*.js']
};

const swaggerSpec = swaggerJsdoc(options);
module.exports = swaggerSpec;
