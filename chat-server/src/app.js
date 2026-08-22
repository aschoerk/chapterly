const express = require('express');
const cors = require('cors');
const proxyRoutes = require('./routes/proxy');
const apiRoutes = require('./routes/api');
require('./db');          // ← this initializes the database

function createApp() {
  const app = express();

  app.use(cors({
    origin: [
      'http://localhost:4200',
      'tauri://localhost',
      'https://tauri.localhost',
      'http://tauri.localhost'
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

  app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Chat server is running' });
  });

  return app;
}

module.exports = { createApp };
