
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
const express = require("express");
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
    'providers',
    'chat_parameters',
    'oauth_tokens',
    'workspace_authorizations',
    'wallet_authorizations',
    'workspaces',
    'wallets',
    'users'
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
        .send({content: 'Hello?', thinking: 'thinking', role: "user"});
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('user');
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
          role: 'assistant',
          parentId: questionId
        });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('assistant');
      expect(res.body.parentId).toBe(questionId);
    });

    test('POST /api/chats/:chatId/nodes/:nodeId/branch-question branches from a question', async () => {
      const nodes = await request(app).get(`/api/chats/${chatId}/nodes`);
      node = nodes.body.find(n => n.role === 'user');
      const questionId = node.id;

      const res = await request(app)
        .post(`/api/chats/${chatId}/nodes/${questionId}/branch-user`)
        .send({content: 'Branch question?'});
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('user');
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
    describe('Edit Question and Answer Versions', () => {
      let chatId;
      let rootQuestionId;
      let rootAnswerId;
      let childQuestionId;

      beforeEach(async () => {
        // Create a chat
        const chatRes = await request(app).post('/api/chats').send({title: 'Versioning Test Chat'});
        chatId = chatRes.body.id;

        // Create root question
        const rootQuestionRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({content: 'Root question?', role: 'user'});
        rootQuestionId = rootQuestionRes.body.id;

        // Create root answer
        const rootAnswerRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Root answer.',
            role: 'assistant',
            parentId: rootQuestionId
          });
        rootAnswerId = rootAnswerRes.body.id;

        // Create child question
        const childQuestionRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Child question?',
            role: 'user',
            parentId: rootAnswerId
          });
        childQuestionId = childQuestionRes.body.id;
      });

      test('POST /api/chats/:chatId/nodes/:nodeId/edit-assistant creates a new version of an answer', async () => {
        const res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootAnswerId}/edit-assistant`)
          .send({content: 'Updated answer content'});

        expect(res.status).toBe(201);
        expect(res.body.content).toBe('Updated answer content');
        expect(res.body.version).toBe(2);
        expect(res.body.previousVersionId).toBe(rootAnswerId);
        expect(res.body.isCurrent).toBe(true);

        // Verify old version is no longer current
        const oldNodeRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const oldNode = oldNodeRes.body.find(node => node.id === rootAnswerId);
        expect(oldNode.isCurrent).toBe(false);
      });

      test('POST /api/chats/:chatId/nodes/:nodeId/edit-user creates a new version of a question', async () => {
        const res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootQuestionId}/edit-user`)
          .send({content: 'Updated question content'});

        expect(res.status).toBe(201);
        expect(res.body.content).toBe('Updated question content');
        expect(res.body.version).toBe(2);
        expect(res.body.previousVersionId).toBe(rootQuestionId);
        expect(res.body.isCurrent).toBe(true);

        // Verify old version is no longer current
        const oldNodeRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const oldNode = oldNodeRes.body.find(node => node.id === rootQuestionId);
        expect(oldNode.isCurrent).toBe(false);
      });

      test('Editing a node reparents child nodes to the new version', async () => {
        // Edit the root answer which has a child
        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootAnswerId}/edit-assistant`)
          .send({content: 'Edited root answer'});

        const newVersionId = editRes.body.id;

        // Check that child question now points to new version as parent
        const nodesRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const childNode = nodesRes.body.find(node => node.id === childQuestionId);

        expect(childNode.parentId).toBe(newVersionId);
      });

      test('Editing maintains attachments from previous version when not specified', async () => {
        const attachments = [{
          id: uuidv4(),
          name: 'test.txt',
          mimeType: 'text/plain',
          size: 100,
          dataUrl: 'data:text/plain;base64,dGVzdA=='
        }];

        // Create a node with attachments
        const nodeWithAttachmentsRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Node with attachments',
            role: 'user',
            attachments
          });

        const nodeId = nodeWithAttachmentsRes.body.id;

        // Edit without specifying attachments
        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${nodeId}/edit-user`)
          .send({content: 'Edited content'});

        expect(editRes.status).toBe(201);
        expect(editRes.body.attachments).toEqual(attachments);
      });

      test('Editing replaces attachments when explicitly provided', async () => {
        const originalAttachments = [{
          id: uuidv4(),
          name: 'original.txt',
          mimeType: 'text/plain',
          size: 100,
          dataUrl: 'data:text/plain;base64,b3JpZ2luYWw='
        }];

        const newAttachments = [{
          id: uuidv4(),
          name: 'replacement.txt',
          mimeType: 'text/plain',
          size: 200,
          dataUrl: 'data:text/plain;base64/cmVwbGFjZW1lbnQ='
        }];

        // Create a node with original attachments
        const nodeWithAttachmentsRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Node with attachments',
            role: 'user',
            attachments: originalAttachments
          });

        const nodeId = nodeWithAttachmentsRes.body.id;

        // Edit with new attachments
        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${nodeId}/edit-user`)
          .send({
            content: 'Edited content',
            attachments: newAttachments
          });

        expect(editRes.status).toBe(201);
        expect(editRes.body.attachments).toEqual(newAttachments);
      });

      test('Editing with empty attachments array clears attachments', async () => {
        const attachments = [{
          id: uuidv4(),
          name: 'test.txt',
          mimeType: 'text/plain',
          size: 100,
          dataUrl: 'data:text/plain;base64,dGVzdA=='
        }];

        // Create a node with attachments
        const nodeWithAttachmentsRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Node with attachments',
            role: 'user',
            attachments
          });

        const nodeId = nodeWithAttachmentsRes.body.id;

        // Edit with empty attachments array
        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${nodeId}/edit-user`)
          .send({
            content: 'Edited content',
            attachments: []
          });

        expect(editRes.status).toBe(201);
        expect(editRes.body.attachments).toEqual([]);
      });

      test('Multiple edits create sequential versions', async () => {
        // First edit
        const edit1Res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootQuestionId}/edit-user`)
          .send({content: 'First edit'});

        const edit1Id = edit1Res.body.id;

        // Second edit
        const edit2Res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${edit1Id}/edit-user`)
          .send({content: 'Second edit'});

        expect(edit2Res.status).toBe(201);
        expect(edit2Res.body.version).toBe(3); // Original was v1, first edit v2, this is v3
        expect(edit2Res.body.previousVersionId).toBe(edit1Id);
      });

      test('Editing preserves model and provider information', async () => {
        const modelId = 'test-model-id';
        const providerId = 'test-provider-id';

        // Create a node with model/provider info
        const nodeWithModelRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Node with model info',
            role: 'user',
            modelId,
            providerId
          });

        const nodeId = nodeWithModelRes.body.id;

        // Edit the node
        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${nodeId}/edit-user`)
          .send({content: 'Edited content'});

        expect(editRes.status).toBe(201);
        expect(editRes.body.modelId).toBe(modelId);
        expect(editRes.body.providerId).toBe(providerId);
      });

      test('Editing a node with no children does not affect other nodes', async () => {
        // Create an isolated question node (no parent, no children)
        const isolatedQuestionRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({content: 'Isolated question?', role: 'user'});

        const isolatedQuestionId = isolatedQuestionRes.body.id;

        // Edit this isolated node
        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${isolatedQuestionId}/edit-user`)
          .send({content: 'Edited isolated question'});

        expect(editRes.status).toBe(201);

        // Verify the root question/answer structure is unchanged
        const nodesRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const rootNode = nodesRes.body.find(node =>
          node.id === rootQuestionId && node.isCurrent);

        expect(rootNode).toBeDefined();
        expect(rootNode.content).toBe('Root question?'); // Should be original content
      });

      test('Editing handles deeply nested node structures', async () => {
        // Create a deeper hierarchy
        const deepAnswerRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Deep answer',
            role: 'assistant',
            parentId: childQuestionId
          });

        const deepAnswerId = deepAnswerRes.body.id;

        // Edit the middle node (childQuestion)
        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${childQuestionId}/edit-user`)
          .send({content: 'Edited child question'});

        const newChildVersionId = editRes.body.id;

        // Verify deep answer now points to the new version
        const nodesRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const deepAnswerNode = nodesRes.body.find(node => node.id === deepAnswerId);

        expect(deepAnswerNode.parentId).toBe(newChildVersionId);
      });

      test('Editing an empty answer with no children updates the current version in place', async () => {
        const emptyAnswerRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: '',
            role: 'assistant',
            parentId: childQuestionId,
            thinking: null
          });
        expect(emptyAnswerRes.status).toBe(201);
        const emptyAnswerId = emptyAnswerRes.body.id;
        expect(emptyAnswerRes.body.version).toBe(1);

        const beforeNodes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const beforeCount = beforeNodes.body.length;
        const beforeChat = await request(app).get(`/api/chats/${chatId}`);
        const beforeNodeNumber = beforeChat.body.node_number ?? beforeChat.body.nodeNumber;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${emptyAnswerId}/edit-assistant`)
          .send({ content: 'Filled empty leaf answer', thinking: 'now thinking' });

        expect(editRes.status).toBe(201);
        expect(editRes.body.id).toBe(emptyAnswerId);
        expect(editRes.body.content).toBe('Filled empty leaf answer');
        expect(editRes.body.thinking).toBe('now thinking');
        expect(editRes.body.version).toBe(1);
        expect(editRes.body.previousVersionId).toBeNull();
        expect(editRes.body.isCurrent).toBe(true);

        const afterNodes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const matches = afterNodes.body.filter(n => n.id === emptyAnswerId);
        expect(matches).toHaveLength(1);
        expect(afterNodes.body.length).toBe(beforeCount);
        expect(afterNodes.body.some(n => n.previousVersionId === emptyAnswerId)).toBe(false);

        const afterChat = await request(app).get(`/api/chats/${chatId}`);
        const afterNodeNumber = afterChat.body.node_number ?? afterChat.body.nodeNumber;
        if (beforeNodeNumber !== undefined && afterNodeNumber !== undefined) {
          expect(afterNodeNumber).toBe(beforeNodeNumber);
        }
      });

      test('Editing an empty question with no children updates the current version in place', async () => {
        const emptyQuestionRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({ content: '   ', role: 'user' });
        expect(emptyQuestionRes.status).toBe(201);
        const emptyQuestionId = emptyQuestionRes.body.id;

        const beforeNodes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const beforeCount = beforeNodes.body.length;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${emptyQuestionId}/edit-user`)
          .send({ content: 'Now a real question' });

        expect(editRes.status).toBe(201);
        expect(editRes.body.id).toBe(emptyQuestionId);
        expect(editRes.body.content).toBe('Now a real question');
        expect(editRes.body.version).toBe(1);
        expect(editRes.body.previousVersionId).toBeNull();
        expect(editRes.body.isCurrent).toBe(true);
        expect(editRes.body.role).toBe('user');

        const afterNodes = await request(app).get(`/api/chats/${chatId}/nodes`);
        expect(afterNodes.body.length).toBe(beforeCount);
        const oldRow = afterNodes.body.find(n => n.id === emptyQuestionId);
        expect(oldRow.isCurrent).toBe(true);
        expect(oldRow.content).toBe('Now a real question');
      });

      test('Editing a non-empty answer with no children still creates a new version', async () => {
        const leafAnswerRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Already filled leaf',
            role: 'assistant',
            parentId: childQuestionId
          });
        const leafAnswerId = leafAnswerRes.body.id;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${leafAnswerId}/edit-assistant`)
          .send({ content: 'Revised leaf answer' });

        expect(editRes.status).toBe(201);
        expect(editRes.body.id).not.toBe(leafAnswerId);
        expect(editRes.body.content).toBe('Revised leaf answer');
        expect(editRes.body.version).toBe(2);
        expect(editRes.body.previousVersionId).toBe(leafAnswerId);
        expect(editRes.body.isCurrent).toBe(true);

        const nodesRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const oldNode = nodesRes.body.find(n => n.id === leafAnswerId);
        expect(oldNode.isCurrent).toBe(false);
        expect(oldNode.content).toBe('Already filled leaf');
      });

      test('Editing an empty answer that already has a child creates a new version', async () => {
        const emptyParentRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: '',
            role: 'assistant',
            parentId: childQuestionId
          });
        const emptyParentId = emptyParentRes.body.id;

        const grandchildRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Follow-up under empty answer',
            role: 'user',
            parentId: emptyParentId
          });
        const grandchildId = grandchildRes.body.id;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${emptyParentId}/edit-assistant`)
          .send({ content: 'Parent now has text' });

        expect(editRes.status).toBe(201);
        expect(editRes.body.id).not.toBe(emptyParentId);
        expect(editRes.body.version).toBe(2);
        expect(editRes.body.previousVersionId).toBe(emptyParentId);
        expect(editRes.body.isCurrent).toBe(true);

        const nodesRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const oldNode = nodesRes.body.find(n => n.id === emptyParentId);
        expect(oldNode.isCurrent).toBe(false);
        const movedChild = nodesRes.body.find(n => n.id === grandchildId);
        expect(movedChild.parentId).toBe(editRes.body.id);
      });

      test('In-place empty-leaf edit keeps attachments when omitted and replaces them when sent', async () => {
        const originalAttachments = [{
          id: uuidv4(),
          name: 'kept.txt',
          mimeType: 'text/plain',
          size: 4,
          dataUrl: 'data:text/plain;base64,a2VwdA=='
        }];
        const replacementAttachments = [{
          id: uuidv4(),
          name: 'new.txt',
          mimeType: 'text/plain',
          size: 3,
          dataUrl: 'data:text/plain;base64,bmV3'
        }];

        const emptyRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: '',
            role: 'user',
            attachments: originalAttachments
          });
        const emptyId = emptyRes.body.id;

        const keepRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${emptyId}/edit-user`)
          .send({ content: 'First fill' });
        expect(keepRes.status).toBe(201);
        expect(keepRes.body.id).toBe(emptyId);
        expect(keepRes.body.attachments).toEqual(originalAttachments);

        const filledLeafRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({ content: '', role: 'user' });
        const filledLeafId = filledLeafRes.body.id;

        const replaceRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${filledLeafId}/edit-user`)
          .send({ content: 'Second fill', attachments: replacementAttachments });
        expect(replaceRes.status).toBe(201);
        expect(replaceRes.body.id).toBe(filledLeafId);
        expect(replaceRes.body.attachments).toEqual(replacementAttachments);
      });

      test('Editing non-existent node returns 404', async () => {
        const fakeNodeId = uuidv4();

        const res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${fakeNodeId}/edit-user`)
          .send({content: 'Edit attempt'});

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Node not found');
      });

      test('Editing with wrong node type returns error', async () => {
        // Try to edit a question as an answer
        const res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootQuestionId}/edit-assistant`)
          .send({content: 'Wrong type edit'});

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Only assistants can be versioned this way');
      });

      test('Editing without content returns validation error', async () => {
        const res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootQuestionId}/edit-user`)
          .send({}); // No content

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('content is required');
      });
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
      expect(res.body.some(p => p.id === projectId)).toBe(true);
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
      expect(res.body.some(t => t.id === topicId)).toBe(true);
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

  // ------------------------------------------------------------------------
  // Chat parameters
  // ------------------------------------------------------------------------
  describe('ChatParameters', () => {
    let parameterId;
    let projectId;

    test('GET /api/chat-parameters starts empty', async () => {
      const res = await request(app).get('/api/chat-parameters');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('POST /api/chat-parameters creates a set with OpenAI-style aliases', async () => {
      const res = await request(app).post('/api/chat-parameters').send({
        name: 'Creative',
        temperature: 0.8,
        top_k: 40,
        top_p: 0.9,
        stream: true,
        thinking: true,
        reasoning_effort: 'high'
      });
      expect(res.status).toBe(201);
      expect(res.body.temperature).toBe(0.8);
      expect(res.body.topK).toBe(40);
      expect(res.body.topM).toBe(0.9);
      expect(res.body.topP).toBe(0.9);
      expect(res.body.stream).toBe(true);
      expect(res.body.thinking).toBe(true);
      expect(res.body.thinkingLevel).toBe('high');
      expect(res.body.reasoningEffort).toBe('high');
      parameterId = res.body.id;
    });

    test('GET /api/chat-parameters/:id returns the set', async () => {
      const res = await request(app).get(`/api/chat-parameters/${parameterId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(parameterId);
    });

    test('PATCH /api/chat-parameters/:id updates thinking flags', async () => {
      const res = await request(app)
        .patch(`/api/chat-parameters/${parameterId}`)
        .send({ stream: false, thinkingLevel: 'low' });
      expect(res.status).toBe(200);
      expect(res.body.stream).toBe(false);
      expect(res.body.thinkingLevel).toBe('low');
      expect(res.body.temperature).toBe(0.8);
    });

    test('projects can own a parameter set', async () => {
      const project = await request(app).post('/api/projects').send({
        name: 'Params Project',
        chatParametersId: parameterId
      });
      expect(project.status).toBe(201);
      expect(project.body.chatParametersId).toBe(parameterId);
      projectId = project.body.id;

      const owners = await request(app).get(`/api/chat-parameters/${parameterId}/owners`);
      expect(owners.status).toBe(200);
      expect(owners.body).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'project', id: projectId })])
      );

      const filtered = await request(app).get(
        `/api/chat-parameters?ownerType=project&ownerId=${projectId}`
      );
      expect(filtered.status).toBe(200);
      expect(filtered.body).toHaveLength(1);
      expect(filtered.body[0].id).toBe(parameterId);
    });

    test('nested chatParameters on create inserts and attaches', async () => {
      const chat = await request(app).post('/api/chats').send({
        title: 'Param chat',
        chatParameters: {
          temperature: 0.2,
          topM: 0.5,
          stream: true,
          thinking: false,
          thinkingLevel: 'none'
        }
      });
      expect(chat.status).toBe(201);
      expect(chat.body.chatParametersId).toBeTruthy();
      const params = await request(app).get(`/api/chat-parameters/${chat.body.chatParametersId}`);
      expect(params.status).toBe(200);
      expect(params.body.temperature).toBe(0.2);
      expect(params.body.topM).toBe(0.5);
    });

    test('DELETE /api/chat-parameters/:id nulls owners', async () => {
      const res = await request(app).delete(`/api/chat-parameters/${parameterId}`);
      expect(res.status).toBe(204);
      const project = await request(app).get(`/api/projects/${projectId}`);
      expect(project.status).toBe(200);
      expect(project.body.chatParametersId).toBeNull();
    });
  });

  // ------------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------------
  describe('Users', () => {
    let userId;

    test('GET /api/users starts empty', async () => {
      const res = await request(app).get('/api/users');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    test('POST /api/users requires username and password', async () => {
      const res = await request(app).post('/api/users').send({ email: 'a@b.c' });
      expect(res.status).toBe(400);
    });

    test('POST /api/users creates a user without returning the hash', async () => {
      const res = await request(app).post('/api/users').send({
        username: 'andi',
        password: 'secret-pass',
        email: 'andi@example.com',
        phoneNumber: '+15551234567'
      });
      expect(res.status).toBe(201);
      expect(res.body.username).toBe('andi');
      expect(res.body.email).toBe('andi@example.com');
      expect(res.body.phoneNumber).toBe('+15551234567');
      expect(res.body.id).toBeDefined();
      expect(res.body.password).toBeUndefined();
      expect(res.body.passwordHash).toBeUndefined();
      expect(res.body.password_hash).toBeUndefined();
      userId = res.body.id;
    });

    test('POST /api/users rejects a duplicate username', async () => {
      const res = await request(app).post('/api/users').send({
        username: 'andi',
        password: 'other'
      });
      expect(res.status).toBe(409);
    });

    test('POST /api/users/login accepts username and password', async () => {
      const res = await request(app).post('/api/users/login').send({
        username: 'andi',
        password: 'secret-pass'
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(userId);
      expect(res.body.password_hash).toBeUndefined();
    });

    test('POST /api/users/login accepts email', async () => {
      const res = await request(app).post('/api/users/login').send({
        email: 'andi@example.com',
        password: 'secret-pass'
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(userId);
    });

    test('POST /api/users/login rejects a bad password', async () => {
      const res = await request(app).post('/api/users/login').send({
        username: 'andi',
        password: 'nope'
      });
      expect(res.status).toBe(401);
    });

    test('DELETE /api/users/:id removes the identity', async () => {
      const res = await request(app).delete(`/api/users/${userId}`);
      expect(res.status).toBe(204);
      const missing = await request(app).get(`/api/users/${userId}`);
      expect(missing.status).toBe(404);
    });
  });

  describe('Content and provider clients', () => {
    test('content client owns topics; provider client owns providers', async () => {
      const identity = await request(app).post('/api/users').send({
        username: 'owner2',
        password: 'secret-pass'
      });
      expect(identity.status).toBe(201);

      const content = await request(app).post('/api/workspaces').send({
        name: 'Writing desk'
      });
      expect(content.status).toBe(201);

      const wallet = await request(app).post('/api/wallets').send({
        name: 'Model wallet'
      });
      expect(wallet.status).toBe(201);

      const contentGrant = await request(app)
        .post(`/api/workspaces/${content.body.id}/authorizations`)
        .send({ userId: identity.body.id, scopes: ['topics.read', 'topics.write'] });
      expect(contentGrant.status).toBe(201);
      expect(contentGrant.body.userId).toBe(identity.body.id);
      expect(contentGrant.body.clientId).toBe(content.body.id);

      const providerGrant = await request(app)
        .post(`/api/wallets/${wallet.body.id}/authorizations`)
        .send({ userId: identity.body.id });
      expect(providerGrant.status).toBe(201);

      const topic = await request(app).post('/api/topics').send({
        name: 'Desk topic',
        workspaceId: content.body.id
      });
      expect(topic.status).toBe(201);
      expect(topic.body.workspaceId).toBe(content.body.id);
      expect(topic.body.userId).toBeUndefined();

      const provider = await request(app).post('/api/providers').send({
        name: 'Desk router',
        baseUrl: 'https://desk.invalid',
        apiKey: 'k',
        walletId: wallet.body.id
      });
      expect(provider.status).toBe(201);
      expect(provider.body.walletId).toBe(wallet.body.id);

      const listedTopics = await request(app).get(`/api/workspaces/${content.body.id}/topics`);
      expect(listedTopics.body.some(t => t.id === topic.body.id)).toBe(true);

      const listedProviders = await request(app).get(`/api/wallets/${wallet.body.id}/providers`);
      expect(listedProviders.body.some(p => p.id === provider.body.id)).toBe(true);

      const authorizedContent = await request(app).get(`/api/users/${identity.body.id}/workspaces`);
      expect(authorizedContent.body.some(c => c.id === content.body.id)).toBe(true);

      const authorizedProviders = await request(app).get(`/api/users/${identity.body.id}/wallets`);
      expect(authorizedProviders.body.some(c => c.id === wallet.body.id)).toBe(true);

      const denied = await request(app).post('/api/oauth/token').send({
        grant_type: 'password',
        username: 'owner2',
        password: 'secret-pass',
        client_id: 'missing-client'
      });
      expect(denied.status).toBe(400);

      const tokenRes = await request(app).post('/api/oauth/token').send({
        grant_type: 'password',
        username: 'owner2',
        password: 'secret-pass',
        client_id: content.body.id
      });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body.token_type).toBe('Bearer');
      expect(tokenRes.body.access_token).toBeTruthy();
      expect(tokenRes.body.audience).toBe('content');
      expect(tokenRes.body.user_id).toBe(identity.body.id);

      const introspect = await request(app).post('/api/oauth/introspect').send({
        token: tokenRes.body.access_token
      });
      expect(introspect.status).toBe(200);
      expect(introspect.body.active).toBe(true);
      expect(introspect.body.clientId).toBe(content.body.id);
      expect(introspect.body.scopes).toEqual(expect.arrayContaining(['topics.read', 'topics.write']));

      const tokeninfo = await request(app)
        .get('/api/oauth/tokeninfo')
        .set('Authorization', `Bearer ${tokenRes.body.access_token}`);
      expect(tokeninfo.status).toBe(200);
      expect(tokeninfo.body.userId).toBe(identity.body.id);

      const otherClientList = await request(app)
        .get(`/api/workspaces/${content.body.id}/topics`)
        .set('Authorization', `Bearer ${tokenRes.body.access_token}`);
      expect(otherClientList.status).toBe(200);

      const wrongClient = await request(app)
        .get(`/api/wallets/${wallet.body.id}/providers`)
        .set('Authorization', `Bearer ${tokenRes.body.access_token}`);
      expect(wrongClient.status).toBe(403);

      const invalid = await request(app)
        .get('/api/oauth/tokeninfo')
        .set('Authorization', 'Bearer not-a-token');
      expect(invalid.status).toBe(401);

      await request(app).post('/api/oauth/revoke').send({ token: tokenRes.body.access_token });
      const revoked = await request(app).post('/api/oauth/introspect').send({
        token: tokenRes.body.access_token
      });
      expect(revoked.body.active).toBe(false);
    });
  });

  describe('ABAC token claims', () => {
    async function seed(label) {
      const user = await request(app).post('/api/users').send({
        username: `user-${label}`,
        password: 'secret-pass'
      });
      const studioA = await request(app).post('/api/workspaces').send({ name: `studio-a-${label}` });
      const studioB = await request(app).post('/api/workspaces').send({ name: `studio-b-${label}` });
      const wallet = await request(app).post('/api/wallets').send({ name: `wallet-${label}` });
      const otherWallet = await request(app).post('/api/wallets').send({ name: `wallet-other-${label}` });

      await request(app)
        .post(`/api/workspaces/${studioA.body.id}/authorizations`)
        .send({ userId: user.body.id, scopes: ['topics.read', 'topics.write'] });
      await request(app)
        .post(`/api/workspaces/${studioB.body.id}/authorizations`)
        .send({ userId: user.body.id, scopes: ['topics.read'] });
      await request(app)
        .post(`/api/wallets/${wallet.body.id}/authorizations`)
        .send({ userId: user.body.id, scopes: ['providers.read', 'providers.write'] });
      await request(app)
        .post(`/api/wallets/${otherWallet.body.id}/authorizations`)
        .send({ userId: user.body.id, scopes: ['providers.read'] });

      const topicA = await request(app).post('/api/topics').send({
        name: `topic-a-${label}`,
        workspaceId: studioA.body.id
      });
      const topicB = await request(app).post('/api/topics').send({
        name: `topic-b-${label}`,
        workspaceId: studioB.body.id
      });
      const provider = await request(app).post('/api/providers').send({
        name: `prov-${label}`,
        baseUrl: 'https://models.invalid',
        apiKey: 'k',
        walletId: wallet.body.id
      });
      const otherProvider = await request(app).post('/api/providers').send({
        name: `prov-other-${label}`,
        baseUrl: 'https://other.invalid',
        apiKey: 'k2',
        walletId: otherWallet.body.id
      });
      const model = await request(app).post('/api/models').send({
        displayName: `model-${label}`,
        modelId: `test/${label}`,
        providerId: provider.body.id
      });
      const chatA = await request(app).post('/api/chats').send({
        title: `chat-a-${label}`,
        projectId: topicA.body.defaultProjectId
      });
      const chatB = await request(app).post('/api/chats').send({
        title: `chat-b-${label}`,
        projectId: topicB.body.defaultProjectId
      });

      return {
        user, studioA, studioB, wallet, otherWallet,
        topicA, topicB, provider, otherProvider, model, chatA, chatB
      };
    }

    async function issue(username, claims) {
      return request(app).post('/api/oauth/token').send({
        grant_type: 'password',
        username,
        password: 'secret-pass',
        claims
      });
    }

    function bearer(token) {
      return { Authorization: `Bearer ${token}` };
    }

    test('issues opaque token with N topic claims and one provider claim', async () => {
      const f = await seed('multi');
      const res = await issue('user-multi', {
        topics: [
          { workspaceId: f.studioA.body.id, access: 'write' },
          { workspaceId: f.studioB.body.id, access: 'read' }
        ],
        provider: {
          walletId: f.wallet.body.id,
          access: 'run',
          contingent: { maxCost: 10, maxTokens: 1000 }
        }
      });
      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeTruthy();
      expect(res.body.claims.topics).toEqual(expect.arrayContaining([
        { workspaceId: f.studioA.body.id, access: 'write' },
        { workspaceId: f.studioB.body.id, access: 'read' }
      ]));
      expect(res.body.claims.provider.walletId).toBe(f.wallet.body.id);
      expect(res.body.claims.provider.access).toBe('run');
      expect(res.body.claims.provider.contingent.maxCost).toBe(10);

      const introspect = await request(app).post('/api/oauth/introspect').send({
        token: res.body.access_token
      });
      expect(introspect.body.active).toBe(true);
      expect(introspect.body.claims.topics).toHaveLength(2);
      expect(introspect.body.access_token).toBeUndefined();
    });

    test('rejects write claim when user grant is read-only', async () => {
      const f = await seed('ro-write');
      const res = await issue('user-ro-write', {
        topics: [{ workspaceId: f.studioB.body.id, access: 'write' }]
      });
      expect(res.status).toBe(403);
    });

    test('rejects a second provider client on one token', async () => {
      const f = await seed('two-wallets');
      const res = await request(app).post('/api/oauth/token').send({
        grant_type: 'password',
        username: 'user-two-wallets',
        password: 'secret-pass',
        client_id: f.wallet.body.id,
        additional_client_ids: [f.otherWallet.body.id]
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/only one provider/i);
    });

    test('no Bearer leaves topic and provider routes open', async () => {
      const f = await seed('public');
      const topics = await request(app).get('/api/topics');
      expect(topics.status).toBe(200);
      const providers = await request(app).get('/api/providers');
      expect(providers.status).toBe(200);
      const node = await request(app).post(`/api/chats/${f.chatA.body.id}/nodes`).send({
        role: 'user',
        content: 'open'
      });
      expect(node.status).toBe(201);
    });

    test('read claim lists topics but cannot mutate that studio', async () => {
      const f = await seed('read-topic');
      const token = await issue('user-read-topic', {
        topics: [{ workspaceId: f.studioB.body.id, access: 'read' }]
      });
      expect(token.status).toBe(200);
      const hdr = bearer(token.body.access_token);

      const listed = await request(app).get('/api/topics').set(hdr);
      expect(listed.status).toBe(200);
      expect(listed.body.some(t => t.id === f.topicB.body.id)).toBe(true);

      const rename = await request(app)
        .put(`/api/topics/${f.topicB.body.id}`)
        .set(hdr)
        .send({ name: 'nope' });
      expect(rename.status).toBe(403);

      const node = await request(app)
        .post(`/api/chats/${f.chatB.body.id}/nodes`)
        .set(hdr)
        .send({ role: 'user', content: 'nope' });
      expect(node.status).toBe(403);
    });

    test('write claim on A cannot write a chat that belongs to B', async () => {
      const f = await seed('cross');
      const token = await issue('user-cross', {
        topics: [{ workspaceId: f.studioA.body.id, access: 'write' }]
      });
      const hdr = bearer(token.body.access_token);

      const ok = await request(app)
        .post(`/api/chats/${f.chatA.body.id}/nodes`)
        .set(hdr)
        .send({ role: 'user', content: 'ok' });
      expect(ok.status).toBe(201);

      const denied = await request(app)
        .post(`/api/chats/${f.chatB.body.id}/nodes`)
        .set(hdr)
        .send({ role: 'user', content: 'other studio' });
      expect(denied.status).toBe(403);
    });

    test('run claim may use a model on its wallet but cannot manage keys', async () => {
      const f = await seed('run-only');
      const token = await issue('user-run-only', {
        topics: [{ workspaceId: f.studioA.body.id, access: 'write' }],
        provider: { walletId: f.wallet.body.id, access: 'run' }
      });
      const hdr = bearer(token.body.access_token);

      const node = await request(app)
        .post(`/api/chats/${f.chatA.body.id}/nodes`)
        .set(hdr)
        .send({
          role: 'assistant',
          content: 'answer',
          modelId: f.model.body.id,
          providerId: f.provider.body.id
        });
      expect(node.status).toBe(201);

      const manage = await request(app)
        .put(`/api/providers/${f.provider.body.id}`)
        .set(hdr)
        .send({ name: 'renamed' });
      expect(manage.status).toBe(403);
    });

    test('run claim cannot use a model from another wallet', async () => {
      const f = await seed('wrong-wallet');
      const token = await issue('user-wrong-wallet', {
        topics: [{ workspaceId: f.studioA.body.id, access: 'write' }],
        provider: { walletId: f.wallet.body.id, access: 'run' }
      });
      const hdr = bearer(token.body.access_token);

      const denied = await request(app)
        .post(`/api/chats/${f.chatA.body.id}/nodes`)
        .set(hdr)
        .send({
          role: 'assistant',
          content: 'x',
          providerId: f.otherProvider.body.id
        });
      expect(denied.status).toBe(403);
    });

    test('manage claim can update provider keys', async () => {
      const f = await seed('manage');
      const token = await issue('user-manage', {
        provider: { walletId: f.wallet.body.id, access: 'manage' }
      });
      const hdr = bearer(token.body.access_token);

      const updated = await request(app)
        .put(`/api/providers/${f.provider.body.id}`)
        .set(hdr)
        .send({ name: 'managed' });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe('managed');
    });

    test('contingent blocks further model use after spend reaches maxCost', async () => {
      const f = await seed('quota');
      const token = await issue('user-quota', {
        topics: [{ workspaceId: f.studioA.body.id, access: 'write' }],
        provider: {
          walletId: f.wallet.body.id,
          access: 'run',
          contingent: { maxCost: 1, maxTokens: 10000 }
        }
      });
      const hdr = bearer(token.body.access_token);

      const first = await request(app)
        .post(`/api/chats/${f.chatA.body.id}/nodes`)
        .set(hdr)
        .send({
          role: 'assistant',
          content: 'first',
          modelId: f.model.body.id,
          totalCost: 1,
          totalTokens: 10
        });
      expect(first.status).toBe(201);

      const info = await request(app).get('/api/oauth/tokeninfo').set(hdr);
      expect(info.body.claims.provider.contingent.spentCost).toBe(1);

      const second = await request(app)
        .post(`/api/chats/${f.chatA.body.id}/nodes`)
        .set(hdr)
        .send({
          role: 'assistant',
          content: 'second',
          modelId: f.model.body.id,
          totalCost: 0.1
        });
      expect(second.status).toBe(403);
      expect(second.body.error).toMatch(/contingent/i);
    });

    test('refresh keeps claims on the new access token', async () => {
      const f = await seed('refresh');
      const issued = await issue('user-refresh', {
        topics: [{ workspaceId: f.studioA.body.id, access: 'write' }],
        provider: { walletId: f.wallet.body.id, access: 'run' }
      });
      const refreshed = await request(app).post('/api/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: issued.body.refresh_token
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.claims.topics[0].workspaceId).toBe(f.studioA.body.id);
      expect(refreshed.body.claims.provider.walletId).toBe(f.wallet.body.id);
    });

    test('legacy client_id still mints a write topic claim', async () => {
      const f = await seed('legacy');
      const res = await request(app).post('/api/oauth/token').send({
        grant_type: 'password',
        username: 'user-legacy',
        password: 'secret-pass',
        client_id: f.studioA.body.id
      });
      expect(res.status).toBe(200);
      expect(res.body.claims.topics).toEqual([
        { workspaceId: f.studioA.body.id, access: 'write' }
      ]);
    });
  });

  // ------------------------------------------------------------------------
  // Topic / project / chat assignment
  // ------------------------------------------------------------------------
  describe('Assignment invariants', () => {
    test('every project belongs to a topic and every topic has a default project', async () => {
      const topic = await request(app).post('/api/topics').send({ name: 'Noir' });
      expect(topic.status).toBe(201);
      expect(topic.body.defaultProjectId).toBeTruthy();
      expect(topic.body.projectIds).toContain(topic.body.defaultProjectId);

      const inbox = await request(app).get(`/api/projects/${topic.body.defaultProjectId}`);
      expect(inbox.status).toBe(200);
      expect(inbox.body.isDefault).toBe(true);
      expect(inbox.body.topicIds).toContain(topic.body.id);

      const project = await request(app).post('/api/projects').send({
        name: 'Case files',
        topicId: topic.body.id
      });
      expect(project.status).toBe(201);
      expect(project.body.topicIds).toContain(topic.body.id);
    });

    test('creating a chat without a project still assigns one', async () => {
      const res = await request(app).post('/api/chats').send({ title: 'Loose story' });
      expect(res.status).toBe(201);
      expect(res.body.projectId).toBeTruthy();
    });

    test('unassigning a chat moves it to the topic default project', async () => {
      const topic = await request(app).post('/api/topics').send({ name: 'Western' });
      const project = await request(app).post('/api/projects').send({
        name: 'Dust town',
        topicId: topic.body.id
      });
      const chat = await request(app).post('/api/chats').send({
        title: 'Showdown',
        projectId: project.body.id
      });
      expect(chat.body.projectId).toBe(project.body.id);

      const unassigned = await request(app)
        .patch(`/api/chats/${chat.body.id}`)
        .send({ projectId: null });
      expect(unassigned.status).toBe(200);
      expect(unassigned.body.projectId).toBe(topic.body.defaultProjectId);
      expect(unassigned.body.projectId).not.toBe(project.body.id);
    });

    test('deleting a project rehomes chats onto the topic default', async () => {
      const topic = await request(app).post('/api/topics').send({ name: 'Space' });
      const project = await request(app).post('/api/projects').send({
        name: 'Orbital',
        topicId: topic.body.id
      });
      const chat = await request(app).post('/api/chats').send({
        title: 'Docking',
        projectId: project.body.id
      });

      const del = await request(app).delete(`/api/projects/${project.body.id}`);
      expect(del.status).toBe(204);

      const moved = await request(app).get(`/api/chats/${chat.body.id}`);
      expect(moved.status).toBe(200);
      expect(moved.body.projectId).toBe(topic.body.defaultProjectId);
    });
  });
});
