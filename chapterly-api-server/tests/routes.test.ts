/**
 * API route tests against the chapterly-api-server with an in-memory SQLite
 * database. Ported from chat-server-js/tests/routes.test.js.
 *
 * Not ported (no counterpart in chapterly-api-server yet):
 *  - Users / OAuth / workspaces / wallets / ABAC claims (authorization scope)
 *  - Topic-default-project "Assignment invariants"
 */

import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import type { Express } from 'express';
import type { PersistencePort } from '../src/domain/chat-api.port.js';
import { makeApp } from './helpers/app.js';

let app: Express;
let store: PersistencePort;

beforeAll(async () => {
  ({ app, store } = await makeApp());
});

describe('API Routes (in-memory SQLite)', () => {
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
        apiKey: 'sk-or-v1-test',
      };
      const res = await request(app).post('/api/providers').send(newProvider);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'OpenRouter',
        type: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-v1-test',
        enabled: true,
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
        type: 'custom',
        baseUrl: 'http://temp',
        apiKey: 'temp-key',
      });
      const id = created.body.id;

      const res = await request(app)
        .put(`/api/providers/${id}`)
        .send({ name: 'Updated', enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
      expect(res.body.enabled).toBe(false);
    });

    test('DELETE /api/providers/:id removes a provider', async () => {
      for (const provider of await store.getProviders()) {
        await store.deleteProvider(provider.id);
      }
      const created = await request(app).post('/api/providers').send({
        name: 'DeleteMe',
        type: 'custom',
        baseUrl: 'http://delete',
        apiKey: 'delete-key',
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
    let providerId: string;

    beforeAll(async () => {
      const provider = await request(app).post('/api/providers').send({
        name: 'Provider for Models',
        type: 'custom',
        baseUrl: 'http://provider',
        apiKey: 'key',
      });
      providerId = provider.body.id;
    });

    test('POST /api/models creates a model', async () => {
      const res = await request(app).post('/api/models').send({
        displayName: 'Claude 3.5 Sonnet',
        modelId: 'anthropic/claude-3.5-sonnet',
        providerId,
        type: 'preset',
        contextLength: 200000,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        displayName: 'Claude 3.5 Sonnet',
        modelId: 'anthropic/claude-3.5-sonnet',
        providerId,
        type: 'preset',
        enabled: true,
        contextLength: 200000,
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
        providerId,
        type: 'preset',
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
        providerId,
        type: 'preset',
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
    let chatId: string;

    test('POST /api/chats creates a chat', async () => {
      const res = await request(app).post('/api/chats').send({ title: 'Test Chat' });
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
        .send({ title: 'Renamed Chat' });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Renamed Chat');
    });

    test('POST /api/chats/:chatId/nodes adds a question', async () => {
      const res = await request(app)
        .post(`/api/chats/${chatId}/nodes`)
        .send({ content: 'Hello?', thinking: 'thinking', role: 'user' });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('user');
      expect(res.body.content).toBe('Hello?');
    });

    test('POST /api/chats/:chatId/nodes adds an answer', async () => {
      const nodes = await request(app).get(`/api/chats/${chatId}/nodes`);
      const questionId = nodes.body[0].id;

      const res = await request(app)
        .post(`/api/chats/${chatId}/nodes`)
        .send({
          content: 'Hi there!',
          role: 'assistant',
          parentId: questionId,
        });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('assistant');
      expect(res.body.parentId).toBe(questionId);
    });

    test('POST /api/chats/:chatId/nodes/:nodeId/branch-user branches from a question', async () => {
      const nodes = await request(app).get(`/api/chats/${chatId}/nodes`);
      const node = nodes.body.find((entry: { role: string }) => entry.role === 'user');
      const questionId = node.id;

      const res = await request(app)
        .post(`/api/chats/${chatId}/nodes/${questionId}/branch-user`)
        .send({ content: 'Branch question?' });
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
        .send({ content: 'Updated content' });
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
      let chatId: string;
      let rootQuestionId: string;
      let rootAnswerId: string;
      let childQuestionId: string;

      beforeEach(async () => {
        const chatRes = await request(app).post('/api/chats').send({ title: 'Versioning Test Chat' });
        chatId = chatRes.body.id;

        const rootQuestionRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({ content: 'Root question?', role: 'user' });
        rootQuestionId = rootQuestionRes.body.id;

        const rootAnswerRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Root answer.',
            role: 'assistant',
            parentId: rootQuestionId,
          });
        rootAnswerId = rootAnswerRes.body.id;

        const childQuestionRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Child question?',
            role: 'user',
            parentId: rootAnswerId,
          });
        childQuestionId = childQuestionRes.body.id;
      });

      test('POST /api/chats/:chatId/nodes/:nodeId/edit-assistant creates a new version of an answer', async () => {
        const res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootAnswerId}/edit-assistant`)
          .send({ content: 'Updated answer content' });

        expect(res.status).toBe(201);
        expect(res.body.content).toBe('Updated answer content');
        expect(res.body.version).toBe(2);
        expect(res.body.previousVersionId).toBe(rootAnswerId);
        expect(res.body.isCurrent).toBe(true);

        const oldNodeRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const oldNode = oldNodeRes.body.find((node: { id: string }) => node.id === rootAnswerId);
        expect(oldNode.isCurrent).toBe(false);
      });

      test('POST /api/chats/:chatId/nodes/:nodeId/edit-user creates a new version of a question', async () => {
        const res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootQuestionId}/edit-user`)
          .send({ content: 'Updated question content' });

        expect(res.status).toBe(201);
        expect(res.body.content).toBe('Updated question content');
        expect(res.body.version).toBe(2);
        expect(res.body.previousVersionId).toBe(rootQuestionId);
        expect(res.body.isCurrent).toBe(true);

        const oldNodeRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const oldNode = oldNodeRes.body.find((node: { id: string }) => node.id === rootQuestionId);
        expect(oldNode.isCurrent).toBe(false);
      });

      test('Editing a node reparents child nodes to the new version', async () => {
        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootAnswerId}/edit-assistant`)
          .send({ content: 'Edited root answer' });

        const newVersionId = editRes.body.id;

        const nodesRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const childNode = nodesRes.body.find((node: { id: string }) => node.id === childQuestionId);

        expect(childNode.parentId).toBe(newVersionId);
      });

      test('Editing maintains attachments from previous version when not specified', async () => {
        const attachments = [
          {
            id: uuidv4(),
            name: 'test.txt',
            mimeType: 'text/plain',
            size: 100,
            dataUrl: 'data:text/plain;base64,dGVzdA==',
          },
        ];

        const nodeWithAttachmentsRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Node with attachments',
            role: 'user',
            attachments,
          });
        const nodeId = nodeWithAttachmentsRes.body.id;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${nodeId}/edit-user`)
          .send({ content: 'Edited content' });

        expect(editRes.status).toBe(201);
        expect(editRes.body.attachments).toEqual(attachments);
      });

      test('Editing replaces attachments when explicitly provided', async () => {
        const originalAttachments = [
          {
            id: uuidv4(),
            name: 'original.txt',
            mimeType: 'text/plain',
            size: 100,
            dataUrl: 'data:text/plain;base64,b3JpZ2luYWw=',
          },
        ];
        const newAttachments = [
          {
            id: uuidv4(),
            name: 'replacement.txt',
            mimeType: 'text/plain',
            size: 200,
            dataUrl: 'data:text/plain;base64/cmVwbGFjZW1lbnQ=',
          },
        ];

        const nodeWithAttachmentsRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Node with attachments',
            role: 'user',
            attachments: originalAttachments,
          });
        const nodeId = nodeWithAttachmentsRes.body.id;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${nodeId}/edit-user`)
          .send({
            content: 'Edited content',
            attachments: newAttachments,
          });

        expect(editRes.status).toBe(201);
        expect(editRes.body.attachments).toEqual(newAttachments);
      });

      test('Editing with empty attachments array clears attachments', async () => {
        const attachments = [
          {
            id: uuidv4(),
            name: 'test.txt',
            mimeType: 'text/plain',
            size: 100,
            dataUrl: 'data:text/plain;base64,dGVzdA==',
          },
        ];

        const nodeWithAttachmentsRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Node with attachments',
            role: 'user',
            attachments,
          });
        const nodeId = nodeWithAttachmentsRes.body.id;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${nodeId}/edit-user`)
          .send({
            content: 'Edited content',
            attachments: [],
          });

        expect(editRes.status).toBe(201);
        expect(editRes.body.attachments).toEqual([]);
      });

      test('Multiple edits create sequential versions', async () => {
        const edit1Res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootQuestionId}/edit-user`)
          .send({ content: 'First edit' });
        const edit1Id = edit1Res.body.id;

        const edit2Res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${edit1Id}/edit-user`)
          .send({ content: 'Second edit' });

        expect(edit2Res.status).toBe(201);
        expect(edit2Res.body.version).toBe(3);
        expect(edit2Res.body.previousVersionId).toBe(edit1Id);
      });

      test('Editing preserves model and provider information', async () => {
        const modelId = 'test-model-id';
        const providerId = 'test-provider-id';

        const nodeWithModelRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Node with model info',
            role: 'user',
            modelId,
            providerId,
          });
        const nodeId = nodeWithModelRes.body.id;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${nodeId}/edit-user`)
          .send({ content: 'Edited content' });

        expect(editRes.status).toBe(201);
        expect(editRes.body.modelId).toBe(modelId);
        expect(editRes.body.providerId).toBe(providerId);
      });

      test('Editing a node with no children does not affect other nodes', async () => {
        const isolatedQuestionRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({ content: 'Isolated question?', role: 'user' });
        const isolatedQuestionId = isolatedQuestionRes.body.id;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${isolatedQuestionId}/edit-user`)
          .send({ content: 'Edited isolated question' });

        expect(editRes.status).toBe(201);

        const nodesRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const rootNode = nodesRes.body.find(
          (node: { id: string; isCurrent: boolean }) =>
            node.id === rootQuestionId && node.isCurrent,
        );

        expect(rootNode).toBeDefined();
        expect(rootNode.content).toBe('Root question?');
      });

      test('Editing handles deeply nested node structures', async () => {
        const deepAnswerRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Deep answer',
            role: 'assistant',
            parentId: childQuestionId,
          });
        const deepAnswerId = deepAnswerRes.body.id;

        const editRes = await request(app)
          .post(`/api/chats/${chatId}/nodes/${childQuestionId}/edit-user`)
          .send({ content: 'Edited child question' });
        const newChildVersionId = editRes.body.id;

        const nodesRes = await request(app).get(`/api/chats/${chatId}/nodes`);
        const deepAnswerNode = nodesRes.body.find((node: { id: string }) => node.id === deepAnswerId);

        expect(deepAnswerNode.parentId).toBe(newChildVersionId);
      });

      test('Editing an empty answer with no children updates the current version in place', async () => {
        const emptyAnswerRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: '',
            role: 'assistant',
            parentId: childQuestionId,
            thinking: null,
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
        const matches = afterNodes.body.filter((n: { id: string }) => n.id === emptyAnswerId);
        expect(matches).toHaveLength(1);
        expect(afterNodes.body.length).toBe(beforeCount);
        expect(
          afterNodes.body.some((n: { previousVersionId: string }) => n.previousVersionId === emptyAnswerId),
        ).toBe(false);

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
        const oldRow = afterNodes.body.find((n: { id: string }) => n.id === emptyQuestionId);
        expect(oldRow.isCurrent).toBe(true);
        expect(oldRow.content).toBe('Now a real question');
      });

      test('Editing a non-empty answer with no children still creates a new version', async () => {
        const leafAnswerRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Already filled leaf',
            role: 'assistant',
            parentId: childQuestionId,
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
        const oldNode = nodesRes.body.find((n: { id: string }) => n.id === leafAnswerId);
        expect(oldNode.isCurrent).toBe(false);
        expect(oldNode.content).toBe('Already filled leaf');
      });

      test('Editing an empty answer that already has a child creates a new version', async () => {
        const emptyParentRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: '',
            role: 'assistant',
            parentId: childQuestionId,
          });
        const emptyParentId = emptyParentRes.body.id;

        const grandchildRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: 'Follow-up under empty answer',
            role: 'user',
            parentId: emptyParentId,
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
        const oldNode = nodesRes.body.find((n: { id: string }) => n.id === emptyParentId);
        expect(oldNode.isCurrent).toBe(false);
        const movedChild = nodesRes.body.find((n: { id: string }) => n.id === grandchildId);
        expect(movedChild.parentId).toBe(editRes.body.id);
      });

      test('In-place empty-leaf edit keeps attachments when omitted and replaces them when sent', async () => {
        const originalAttachments = [
          {
            id: uuidv4(),
            name: 'kept.txt',
            mimeType: 'text/plain',
            size: 4,
            dataUrl: 'data:text/plain;base64,a2VwdA==',
          },
        ];
        const replacementAttachments = [
          {
            id: uuidv4(),
            name: 'new.txt',
            mimeType: 'text/plain',
            size: 3,
            dataUrl: 'data:text/plain;base64,bmV3',
          },
        ];

        const emptyRes = await request(app)
          .post(`/api/chats/${chatId}/nodes`)
          .send({
            content: '',
            role: 'user',
            attachments: originalAttachments,
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
          .send({ content: 'Edit attempt' });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      });

      test('Editing with wrong node type returns error', async () => {
        const res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootQuestionId}/edit-assistant`)
          .send({ content: 'Wrong type edit' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Only assistants can be versioned this way');
      });

      test('Editing without content returns validation error', async () => {
        const res = await request(app)
          .post(`/api/chats/${chatId}/nodes/${rootQuestionId}/edit-user`)
          .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('content is required');
      });
    });
  });

  // ------------------------------------------------------------------------
  // Projects
  // ------------------------------------------------------------------------
  describe('Projects', () => {
    let projectId: string;

    test('POST /api/projects creates a project', async () => {
      const res = await request(app).post('/api/projects').send({
        name: 'My Project',
        greeting: 'Hi',
        systemPrompt: 'You are helpful.',
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Project');
      projectId = res.body.id;
    });

    test('GET /api/projects lists projects', async () => {
      const res = await request(app).get('/api/projects');
      expect(res.status).toBe(200);
      expect(res.body.some((p: { id: string }) => p.id === projectId)).toBe(true);
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
    let personaId: string;

    test('POST /api/personas creates a persona', async () => {
      const res = await request(app).post('/api/personas').send({
        name: 'Dr. Elena Voss',
        shortName: 'Elena',
        description: 'A brilliant physicist.',
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
    let topicId: string;
    let projectId: string;

    beforeAll(async () => {
      const project = await request(app).post('/api/projects').send({
        name: 'Topic Project',
      });
      projectId = project.body.id;
    });

    test('POST /api/topics creates a topic', async () => {
      const res = await request(app).post('/api/topics').send({
        name: 'Cyberpunk',
        description: 'Neon-lit scenarios',
        projectIds: [projectId],
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Cyberpunk');
      expect(res.body.projectIds).toContain(projectId);
      topicId = res.body.id;
    });

    test('GET /api/topics lists topics', async () => {
      const res = await request(app).get('/api/topics');
      expect(res.status).toBe(200);
      expect(res.body.some((t: { id: string }) => t.id === topicId)).toBe(true);
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
      const project = await request(app).post('/api/projects').send({
        name: 'Second Project',
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
    let parameterId: string;
    let projectId: string;

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
        reasoning_effort: 'high',
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
        chatParametersId: parameterId,
      });
      expect(project.status).toBe(201);
      expect(project.body.chatParametersId).toBe(parameterId);
      projectId = project.body.id;

      const owners = await request(app).get(`/api/chat-parameters/${parameterId}/owners`);
      expect(owners.status).toBe(200);
      expect(owners.body).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'project', id: projectId })]),
      );

      const filtered = await request(app).get(
        `/api/chat-parameters?ownerType=project&ownerId=${projectId}`,
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
          thinkingLevel: 'none',
        },
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
});