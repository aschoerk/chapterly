const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Chat Server API',
      version: '1.0.0',
      description: 'API for the Chat Client (providers, models, chats, nodes)'
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Local development server'
      }
    ],
    tags: [
      { name: 'Providers', description: 'AI provider configuration' },
      { name: 'Models', description: 'Available models and presets' },
      { name: 'Chats', description: 'Chat management' },
      { name: 'Nodes', description: 'Chat nodes (questions & answers)' }
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
            type: {
              type: 'string',
              enum: ['question', 'answer']
            },
            content: {
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
            }
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
        }
      }
    }
  },
  apis: ['./src/routes/*.js']
};

const swaggerSpec = swaggerJsdoc(options);
module.exports = swaggerSpec;
