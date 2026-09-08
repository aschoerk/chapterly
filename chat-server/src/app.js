const express = require('express');
const cors = require('cors');
const proxyRoutes = require('./routes/proxy');
const apiRoutes = require('./routes/api');
const chatsRoutes = require('./routes/chats');
const registerCloneChat = require('./routes/clone-chat');
registerCloneChat(chatsRoutes);
const projectsRoutes = require('./routes/projects');
const personasRoutes = require('./routes/personas');
const topicsRoutes = require('./routes/topics');
const chatParametersRoutes = require('./routes/chat_parameters');
const usersRoutes = require('./routes/users');
const workspacesRoutes = require('./routes/workspaces');
const walletsRoutes = require('./routes/wallets');
const oauthRoutes = require('./routes/oauth');
const { parseBearer } = require('./oauth');
const { seedAdmin } = require('./bootstrap');
// ...
require('./db');          // ← this initializes the database

const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');

function createApp() {
  seedAdmin().catch((err) => {
    console.error('Admin seed failed:', err.message);
  });
  const app = express();

  app.use(cors({
    origin: [
      'http://localhost:4200'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-target-base',
      'HTTP-Referer',
      'X-Title'
    ]
  }));

  // Important: proxy routes before express.json()
  app.use('/proxy', proxyRoutes);

  app.use(express.json({ limit: '10mb' }));
  app.use(parseBearer);

  // API routes
  app.use('/api', apiRoutes);
  app.use('/api/chats', chatsRoutes);
  app.use('/api/projects', projectsRoutes);
  app.use('/api/personas', personasRoutes);
  app.use('/api/topics', topicsRoutes);
  app.use('/api/chat-parameters', chatParametersRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/workspaces', workspacesRoutes);
  app.use('/api/wallets', walletsRoutes);
  app.use('/api/oauth', oauthRoutes);

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    explorer: true,
    swaggerOptions: {
      tryItOutEnabled: true,
      persistAuthorization: true,
      displayRequestDuration: true
    }
  }));

  app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Chat server is running' });
  });

  return app;
}

module.exports = { createApp };
