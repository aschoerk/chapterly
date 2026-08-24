const express = require('express');
const cors = require('cors');
const proxyRoutes = require('./routes/proxy');
const apiRoutes = require('./routes/api');
const chatsRoutes = require('./routes/chats');
const projectsRoutes = require('./routes/projects');
const personasRoutes = require('./routes/personas');
// ...
require('./db');          // ← this initializes the database

const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');

function createApp() {
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

  // API routes
  app.use('/api', apiRoutes);
  app.use('/api/chats', chatsRoutes);
  app.use('/api/projects', projectsRoutes);
  app.use('/api/personas', personasRoutes);

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Chat server is running' });
  });

  return app;
}

module.exports = { createApp };
