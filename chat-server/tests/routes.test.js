
/**
 *
 * Tests for the API routes using an in-memory SQLite database.
 * The `../src/db` module is mocked to return a fresh in-memory database
 * with the same schema as the real one.
 */

jest.mock('../src/routes/proxy', () => {
  const express = require('express');
  const router = express.Router();
  router.use((req, res) => {
    res.status(200).json({ message: 'Proxy mocked' });
  });
  return router;
});

const mockdb = require('../src/db');


const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createApp } = require('../src/app');
let app;

// Helper function to clear all tables
function clearDatabase() {
  const tables = [
    'topic_projects',
    'topics',
    'chat_nodes',
    'chats',
    'personas',
    'projects',
    'models',
    'providers'
  ];

  // Disable foreign key constraints temporarily
  mockdb.exec('PRAGMA foreign_keys = OFF');

  // Clear all tables
  for (const table of tables) {
    mockdb.exec(`DELETE FROM ${table}`);
  }

  // Re-enable foreign key constraints
  mockdb.exec('PRAGMA foreign_keys = ON');
}

beforeAll(() => {
  app = createApp();
  const originalPrepare = mockdb.prepare.bind(mockdb);

  mockdb.prepare = function (sql) {
    const stmt = originalPrepare(sql);
    ['run', 'get', 'all'].forEach((method) => {
      const originalMethod = stmt[method].bind(stmt);
      stmt[method] = function (...params) {
        try {
          return originalMethod(...params);
        } catch (err) {
          console.error(`\n❌ [DB ERROR IN TEST] SQL: "${sql}"\nError: ${err.message}\n`);
          throw err; // Re-throw so Jest still reports test failure
        }
      };
    });
    return stmt;
  };
});


describe('API Routes (in-memory DB)', () => {
  // ------------------------------------------------------------------------
  // Providers
  // ------------------------------------------------------------------------
  describe('Providers', () => {

    test('GET /api/providers returns empty list initially', async () => {
      const res = await request(app).get('/api/providers');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    test('POST /api/providers creates a provider', async () => {
      const newProvider = {
        name: 'OpenRouter',
        type: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-v1-test'
      };
      const res = await request(app).post('/api/providers').send(newProvider);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'OpenRouter',
        type: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-v1-test',
        enabled: true
      });
      expect(res.body.id).toBeDefined();
    });

    test('GET /api/providers returns the created provider', async () => {
      const res = await request(app).get('/api/providers');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('OpenRouter');
    });

    test('PUT /api/providers/:id updates a provider', async () => {
      const created = await request(app).post('/api/providers').send({
        name: 'Temp',
        baseUrl: 'http://temp',
        apiKey: 'temp-key'
      });
      const id = created.body.id;

      const res = await request(app)
        .put(`/api/providers/${id}`)
        .send({name: 'Updated', enabled: false});
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
      expect(res.body.enabled).toBe(false);
    });

    test('DELETE /api/providers/:id removes a provider', async () => {
      mockdb.exec("delete from providers");
      const created = await request(app).post('/api/providers').send({
        name: 'DeleteMe',
        baseUrl: 'http://delete',
        apiKey: 'delete-key'
      });
      const id = created.body.id;

      const res = await request(app).delete(`/api/providers/${id}`);
      expect(res.status).toBe(204);
      const getRes = await request(app).get('/api/providers');
      expect(getRes.body).toHaveLength(0);
      });

    test('DELETE /api/providers/:id returns 404 for unknown id', async () => {
      const res = await request(app).delete(`/api/providers/${uuidv4()}`);
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------
  // Models
  // ------------------------------------------------------------------------
  describe('Models', () => {

    let providerId;

    beforeAll(async () => {
      const provider = await request(app).post('/api/providers').send({
        name: 'Provider for Models',
        baseUrl: 'http://provider',
        apiKey: 'key'
      });
      providerId = provider.body.id;
    });

    test('POST /api/models creates a model', async () => {
      const res = await request(app).post('/api/models').send({
        displayName: 'Claude 3.5 Sonnet',
        modelId: 'anthropic/claude-3.5-sonnet',
        providerId,
        type: 'preset',
        contextLength: 200000
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        displayName: 'Claude 3.5 Sonnet',
        modelId: 'anthropic/claude-3.5-sonnet',
        providerId,
        type: 'preset',
        enabled: true,
        contextLength: 200000
      });
    });

    test('GET /api/models lists models', async () => {
      const res = await request(app).get('/api/models');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('PATCH /api/models/:id/toggle toggles enabled state', async () => {
      const model = await request(app).post('/api/models').send({
        displayName: 'Toggle Model',
        modelId: 'toggle/model',
        providerId
      });
      const id = model.body.id;

      const res = await request(app).patch(`/api/models/${id}/toggle`);
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
    });

    test('DELETE /api/models/:id removes a model', async () => {
      const model = await request(app).post('/api/models').send({
        displayName: 'Delete Model',
        modelId: 'delete/model',
        providerId
      });
      const id = model.body.id;

      const res = await request(app).delete(`/api/models/${id}`);
      expect(res.status).toBe(204);
    });
  });

// ------------------------------------------------------------------------
// Chats and Nodes
// ------------------------------------------------------------------------
  describe('Chats and Nodes', () => {
    let chatId;

    test('POST /api/chats creates a chat', async () => {
      const res = await request(app).post('/api/chats').send({title: 'Test Chat'});
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Test Chat');
      chatId = res.body.id;
    });

    test('GET /api/chats returns the chat', async () => {
      const res = await request(app).get('/api/chats');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(chatId);
    });

    test('GET /api/chats/:id returns a single chat', async () => {
      const res = await request(app).get(`/api/chats/${chatId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(chatId);
    });

    test('PATCH /api/chats/:id updates title', async () => {
      const res = await request(app)
        .patch(`/api/chats/${chatId}`)
        .send({title: 'Renamed Chat'});
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Renamed Chat');
    });

    test('POST /api/chats/:chatId/nodes adds a question', async () => {
      const res = await request(app)
        .post(`/api/chats/${chatId}/nodes`)
        .send({content: 'Hello?', type: "question"});
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('question');
      expect(res.body.content).toBe('Hello?');
    });

    test('POST /api/chats/:chatId/nodes adds an answer', async () => {
      // First get the question node id
      const nodes = await request(app).get(`/api/chats/${chatId}/nodes`);
      const questionId = nodes.body[0].id;

      const res = await request(app)
        .post(`/api/chats/${chatId}/nodes`)
        .send({
          content: 'Hi there!',
          type: 'answer',
          parentId: questionId
        });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('answer');
      expect(res.body.parentId).toBe(questionId);
    });

    test('POST /api/chats/:chatId/nodes/:nodeId/branch-question branches from a question', async () => {
      const nodes = await request(app).get(`/api/chats/${chatId}/nodes`);
      node = nodes.body.find(n => n.type === 'question');
      const questionId = node.id;

      const res = await request(app)
        .post(`/api/chats/${chatId}/nodes/${questionId}/branch-question`)
        .send({content: 'Branch question?'});
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('question');
      expect(res.body.parentId).toBe(node.parentId);
      expect(res.body.version).toBe(1);
      expect(res.body.chatId).toBe(node.chatId);
      expect(res.body.content).toBe('Branch question?');
    });

    test('PATCH /api/chats/:chatId/nodes/:nodeId updates content', async () => {
      const nodes = await request(app).get(`/api/chats/${chatId}/nodes`);
      const nodeId = nodes.body[0].id;

      const res = await request(app)
        .patch(`/api/chats/${chatId}/nodes/${nodeId}`)
        .send({content: 'Updated content'});
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('Updated content');
    });

    test('DELETE /api/chats/:chatId/nodes/:nodeId deletes a node', async () => {
      const nodes = await request(app).get(`/api/chats/${chatId}/nodes`);
      const nodeId = nodes.body[0].id;

      const res = await request(app).delete(`/api/chats/${chatId}/nodes/${nodeId}`);
      expect(res.status).toBe(204);
    });

    test('DELETE /api/chats/:id deletes the chat', async () => {
      const res = await request(app).delete(`/api/chats/${chatId}`);
      expect(res.status).toBe(204);
      const getRes = await request(app).get(`/api/chats/${chatId}`);
      expect(getRes.status).toBe(404);
    });
  });
  // ------------------------------------------------------------------------
  // Projects
  // ------------------------------------------------------------------------
  describe('Projects', () => {

    let projectId;

    test('POST /api/projects creates a project', async () => {
      const res = await request(app).post('/api/projects').send({
        name: 'My Project',
        greeting: 'Hi',
        systemPrompt: 'You are helpful.'
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Project');
      projectId = res.body.id;
    });

    test('GET /api/projects lists projects', async () => {
      const res = await request(app).get('/api/projects');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    test('GET /api/projects/:id returns a project', async () => {
      const res = await request(app).get(`/api/projects/${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(projectId);
    });

    test('PUT /api/projects/:id updates a project', async () => {
      const res = await request(app)
        .put(`/api/projects/${projectId}`)
        .send({ name: 'Updated Project' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Project');
    });

    test('DELETE /api/projects/:id deletes a project', async () => {
      const res = await request(app).delete(`/api/projects/${projectId}`);
      expect(res.status).toBe(204);
      const getRes = await request(app).get(`/api/projects/${projectId}`);
      expect(getRes.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------
  // Personas
  // ------------------------------------------------------------------------
  describe('Personas', () => {
    let personaId;

    test('POST /api/personas creates a persona', async () => {
      const res = await request(app).post('/api/personas').send({
        name: 'Dr. Elena Voss',
        shortName: 'Elena',
        description: 'A brilliant physicist.'
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Dr. Elena Voss');
      personaId = res.body.id;
    });

    test('GET /api/personas lists personas', async () => {
      const res = await request(app).get('/api/personas');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    test('GET /api/personas/:id returns a persona', async () => {
      const res = await request(app).get(`/api/personas/${personaId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(personaId);
    });

    test('PUT /api/personas/:id updates a persona', async () => {
      const res = await request(app)
        .put(`/api/personas/${personaId}`)
        .send({ description: 'Updated description.' });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe('Updated description.');
    });

    test('DELETE /api/personas/:id deletes a persona', async () => {
      const res = await request(app).delete(`/api/personas/${personaId}`);
      expect(res.status).toBe(204);
      const getRes = await request(app).get(`/api/personas/${personaId}`);
      expect(getRes.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------
  // Topics
  // ------------------------------------------------------------------------
  describe('Topics', () => {
    let topicId;
    let projectId;

    beforeAll(async () => {
      // Create a project to attach to topics
      const project = await request(app).post('/api/projects').send({
        name: 'Topic Project'
      });
      projectId = project.body.id;
    });

    test('POST /api/topics creates a topic', async () => {
      const res = await request(app).post('/api/topics').send({
        name: 'Cyberpunk',
        description: 'Neon-lit scenarios',
        projectIds: [projectId]
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Cyberpunk');
      expect(res.body.projectIds).toContain(projectId);
      topicId = res.body.id;
    });

    test('GET /api/topics lists topics', async () => {
      const res = await request(app).get('/api/topics');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    test('GET /api/topics/:id returns a topic', async () => {
      const res = await request(app).get(`/api/topics/${topicId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(topicId);
    });

    test('PUT /api/topics/:id updates a topic', async () => {
      const res = await request(app)
        .put(`/api/topics/${topicId}`)
        .send({ description: 'Updated description.' });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe('Updated description.');
    });

    test('POST /api/topics/:id/projects adds a project', async () => {
      // Create another project
      const project = await request(app).post('/api/projects').send({
        name: 'Second Project'
      });
      const secondProjectId = project.body.id;

      const res = await request(app)
        .post(`/api/topics/${topicId}/projects`)
        .send({ projectId: secondProjectId });
      expect(res.status).toBe(200);
      expect(res.body.projectIds).toContain(secondProjectId);
    });

    test('DELETE /api/topics/:id/projects/:projectId removes a project', async () => {
      const res = await request(app)
        .delete(`/api/topics/${topicId}/projects/${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body.projectIds).not.toContain(projectId);
    });

    test('DELETE /api/topics/:id deletes a topic', async () => {
      const res = await request(app).delete(`/api/topics/${topicId}`);
      expect(res.status).toBe(204);
      const getRes = await request(app).get(`/api/topics/${topicId}`);
      expect(getRes.status).toBe(404);
    });
  });
});
