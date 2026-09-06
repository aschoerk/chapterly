const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Chat Server API',
      version: '1.1.0',
      description: `API for the chat client (users, workspaces, wallets, providers, models, chats, nodes, projects, personas, chat parameters).

**Auth model (no OIDC yet)**
- The OAuth2 client is the Chapterly app, not a workspace or wallet.
- workspaces are workspaces (topic tenants). wallets are wallets (API-key sets).
- Access tokens are opaque. Claims are stored on oauth_tokens.grants_json and returned by introspect/tokeninfo.
- A token may list N topic claims (read or write per workspace) and at most one provider claim (run or manage, optional contingent).
- Send Authorization: Bearer <access_token> to enforce those claims. If the header is omitted, claim checks are skipped (legacy public access).
- A malformed or expired Bearer is 401. A valid token without the required claim is 403.`
    },
    servers: [
      {
        url: 'http://localhost:3847',
        description: 'Local development server'
      }
    ],
    security: [
      {},
      { BearerAuth: [] }
    ],
    tags: [
      { name: 'Users', description: 'Identities only. Password is stored as Argon2id. No OIDC yet.' },
      { name: 'Workspaces', description: 'Topic tenants. Not OAuth2 clients. Users gain a grant ceiling through authorizations.' },
      { name: 'Wallets', description: 'Credential sets that own provider API keys. Not OAuth2 clients.' },
      { name: 'OAuth', description: 'Opaque access tokens with server-side ABAC claims. No OIDC.' },
      { name: 'Providers', description: 'AI provider configuration and API keys belonging to one wallet' },
      { name: 'Models', description: 'Available models and presets' },
      { name: 'Chats', description: 'Chat management. Bearer requires a topic claim on the chat workspace; modelId also requires the token wallet claim.' },
      { name: 'Topics', description: 'Topic grouping for projects. Owned by a content client (workspace).' },
      { name: 'Nodes', description: 'Chat nodes (questions & answers)' },
      { name: 'Projects', description: 'Project management. Every project belongs to a topic.' },
      { name: 'Personas', description: 'Workspace-owned characters. Topic claim required when Bearer is set.' },
      { name: 'ChatParameters', description: 'Content documentation (workspace) or run settings (wallet), depending on owner.' }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque',
          description: 'Opaque access token from POST /api/oauth/token. Claims are not in the string; the server loads them by token hash.'
        }
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            username: { type: 'string', example: 'andi' },
            email: { type: 'string', nullable: true, example: 'andi@example.com' },
            phoneNumber: { type: 'string', nullable: true, example: '+15551234567' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        UserCreate: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string' },
            password: { type: 'string', format: 'password' },
            email: { type: 'string', nullable: true },
            phoneNumber: { type: 'string', nullable: true }
          }
        },
        UserUpdate: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            password: { type: 'string', format: 'password', description: 'When set, stored as a new Argon2id hash' },
            email: { type: 'string', nullable: true },
            phoneNumber: { type: 'string', nullable: true }
          }
        },
        UserLogin: {
          type: 'object',
          required: ['password'],
          properties: {
            username: { type: 'string' },
            email: { type: 'string' },
            phoneNumber: { type: 'string' },
            password: { type: 'string', format: 'password' }
          }
        },
        ContentClient: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Studio' },
            redirectUris: { type: 'array', items: { type: 'string' } },
            grantTypes: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        ContentClientInput: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            redirectUris: { type: 'array', items: { type: 'string' } },
            grantTypes: { type: 'array', items: { type: 'string' } }
          }
        },
        ProviderClient: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'OpenRouter account' },
            redirectUris: { type: 'array', items: { type: 'string' } },
            grantTypes: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        ClientAuthorization: {
          type: 'object',
          description: 'Issuance ceiling: the maximum verbs a user may put on a token claim for this workspace or wallet.',
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            clientId: { type: 'string', format: 'uuid' },
            scopes: { type: 'array', items: { type: 'string' }, example: ['topics.read', 'topics.write'] },
            status: { type: 'string', enum: ['granted', 'revoked'] },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        TopicClaim: {
          type: 'object',
          required: ['workspaceId', 'access'],
          properties: {
            workspaceId: { type: 'string', format: 'uuid' },
            access: { type: 'string', enum: ['read', 'write'], description: 'write includes read. May differ per workspace on the same token.' }
          }
        },
        ProviderContingent: {
          type: 'object',
          nullable: true,
          properties: {
            maxCost: { type: 'number', nullable: true },
            maxTokens: { type: 'integer', nullable: true },
            spentCost: { type: 'number', default: 0 },
            spentTokens: { type: 'integer', default: 0 }
          }
        },
        ProviderClaim: {
          type: 'object',
          required: ['walletId', 'access'],
          properties: {
            walletId: { type: 'string', format: 'uuid' },
            access: { type: 'string', enum: ['run', 'manage'], description: 'run = call models. manage = rotate keys (includes run). At most one provider claim per token.' },
            contingent: { $ref: '#/components/schemas/ProviderContingent' }
          }
        },
        TokenClaims: {
          type: 'object',
          properties: {
            topics: { type: 'array', items: { $ref: '#/components/schemas/TopicClaim' } },
            provider: { $ref: '#/components/schemas/ProviderClaim' }
          }
        },
        TokenRequest: {
          type: 'object',
          required: ['password'],
          properties: {
            grant_type: { type: 'string', enum: ['password', 'refresh_token'], default: 'password' },
            username: { type: 'string' },
            email: { type: 'string' },
            phoneNumber: { type: 'string' },
            password: { type: 'string', format: 'password' },
            client_id: { type: 'string', format: 'uuid', description: 'Legacy: one workspace or wallet; becomes a single write/manage claim' },
            additional_client_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Legacy extra workspaces. A second wallet is rejected.' },
            refresh_token: { type: 'string' },
            claims: { $ref: '#/components/schemas/TokenClaims' },
            topicClaims: { type: 'array', items: { $ref: '#/components/schemas/TopicClaim' } },
            providerClaim: { $ref: '#/components/schemas/ProviderClaim' }
          }
        },
        TokenResponse: {
          type: 'object',
          properties: {
            access_token: { type: 'string', description: 'Opaque handle. Do not parse.' },
            token_type: { type: 'string', example: 'Bearer' },
            expires_in: { type: 'integer', example: 3600 },
            refresh_token: { type: 'string' },
            scope: { type: 'string', description: 'Derived summary of claim verbs' },
            audience: { type: 'string', enum: ['content', 'provider'], nullable: true },
            client_id: { type: 'string', format: 'uuid', nullable: true, description: 'Primary partition id, not an OAuth client' },
            user_id: { type: 'string', format: 'uuid' },
            claims: { $ref: '#/components/schemas/TokenClaims' },
            grants: { type: 'array', items: { type: 'object' }, description: 'Legacy view of the same claims' }
          }
        },
        TokenIntrospection: {
          type: 'object',
          properties: {
            active: { type: 'boolean' },
            tokenId: { type: 'string', format: 'uuid' },
            tokenType: { type: 'string', enum: ['access', 'refresh'] },
            userId: { type: 'string', format: 'uuid' },
            clientId: { type: 'string', format: 'uuid' },
            audience: { type: 'string' },
            scopes: { type: 'array', items: { type: 'string' } },
            claims: { $ref: '#/components/schemas/TokenClaims' },
            grants: { type: 'array', items: { type: 'object' } },
            expiresAt: { type: 'string', format: 'date-time' }
          }
        },
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
            },
            walletId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Owning wallet (wallets.id). The token may name at most one wallet.'
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
            projectId: {
              type: 'string',
              format: 'uuid',
              description: 'Owning project. Always set; unassign moves the chat onto the topic default project.'
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
            kind: { type: 'string', nullable: true, enum: ['content', 'run'], description: 'content = chat documentation; run = topic/project/model generation settings' },
            workspaceId: { type: 'string', format: 'uuid', nullable: true, description: 'Workspace owner when kind=content' },
            walletId: { type: 'string', format: 'uuid', nullable: true, description: 'Wallet owner when kind=run' },
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
            reasoningEffort: { type: 'string', nullable: true, enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
            kind: { type: 'string', enum: ['content', 'run'] },
            workspaceId: { type: 'string', format: 'uuid', nullable: true },
            walletId: { type: 'string', format: 'uuid', nullable: true }
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
            isDefault: {
              type: 'boolean',
              description: 'True when this is the topic inbox used for unassigned chats'
            },
            topicIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' }
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
            workspaceId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Owning workspace (workspaces.id). Token topic claims must name this id.'
            },
            defaultProjectId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Inbox project that receives chats unassigned from other projects in this topic'
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
            workspaceId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Owning workspace'
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
