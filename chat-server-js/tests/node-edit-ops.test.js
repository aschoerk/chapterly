/**
 * Insert / remove / delete (and reparent) on the chat-server node routes.
 * Isolated from routes.test.js so each case starts from a clean DB.
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
const { createApp } = require('../src/app');

let app;

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
    'oauth_codes',
    'workspace_authorizations',
    'wallet_authorizations',
    'workspaces',
    'wallets',
    'users'
  ];
  mockdb.exec('PRAGMA foreign_keys = OFF');
  for (const table of tables) {
    mockdb.exec(`DELETE FROM ${table}`);
  }
  mockdb.exec('PRAGMA foreign_keys = ON');
}

beforeAll(() => {
  app = createApp();
});

beforeEach(() => {
  clearDatabase();
});

async function createChat(title = 'edit-ops') {
  const res = await request(app).post('/api/chats').send({ title });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function addNode(chatId, body) {
  const res = await request(app).post(`/api/chats/${chatId}/nodes`).send(body);
  expect(res.status).toBe(201);
  return res.body;
}

async function listNodes(chatId) {
  const res = await request(app).get(`/api/chats/${chatId}/nodes`);
  expect(res.status).toBe(200);
  return res.body;
}

async function linear(chatId) {
  const u0 = await addNode(chatId, { parentId: null, role: 'user', content: 'Q0' });
  const a0 = await addNode(chatId, { parentId: u0.id, role: 'assistant', content: 'A0' });
  const u1 = await addNode(chatId, { parentId: a0.id, role: 'user', content: 'Q1' });
  const a1 = await addNode(chatId, { parentId: u1.id, role: 'assistant', content: 'A1' });
  const u2 = await addNode(chatId, { parentId: a1.id, role: 'user', content: 'Q2' });
  const a2 = await addNode(chatId, { parentId: u2.id, role: 'assistant', content: 'A2' });
  return { u0, a0, u1, a1, u2, a2 };
}

function ids(nodes) {
  return nodes.map(n => n.id);
}

describe('DELETE /api/chats/:chatId/nodes/:nodeId', () => {
  test('cascade (default) deletes a leaf and leaves the rest', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app).delete(`/api/chats/${chatId}/nodes/${t.a2.id}`);
    expect(res.status).toBe(204);

    const left = await listNodes(chatId);
    expect(ids(left).sort()).toEqual(ids([t.u0, t.a0, t.u1, t.a1, t.u2]).sort());
  });

  test('cascade deletes a mid-tree node and the whole descendant subtree (FK)', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app).delete(`/api/chats/${chatId}/nodes/${t.a1.id}`);
    expect(res.status).toBe(204);

    const left = await listNodes(chatId);
    expect(ids(left).sort()).toEqual(ids([t.u0, t.a0, t.u1]).sort());
    expect(left.some(n => n.id === t.u2 || n.id === t.a2)).toBe(false);
  });

  test('cascade from the root question wipes the chat tree', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app).delete(`/api/chats/${chatId}/nodes/${t.u0.id}`);
    expect(res.status).toBe(204);
    expect(await listNodes(chatId)).toEqual([]);
  });

  test('keepChildren=true reparents mid-tree children onto the deleted parent', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app)
      .delete(`/api/chats/${chatId}/nodes/${t.a1.id}`)
      .query({ keepChildren: 'true' });
    expect(res.status).toBe(204);

    const left = await listNodes(chatId);
    expect(left.find(n => n.id === t.a1.id)).toBeUndefined();
    expect(left.find(n => n.id === t.u2.id).parentId).toBe(t.u1.id);
    expect(left.find(n => n.id === t.a2.id).parentId).toBe(t.u2.id);
  });

  test('keepChildren=true on the root promotes its children to roots', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app)
      .delete(`/api/chats/${chatId}/nodes/${t.u0.id}`)
      .query({ keepChildren: '1' });
    expect(res.status).toBe(204);

    const left = await listNodes(chatId);
    expect(left.find(n => n.id === t.u0.id)).toBeUndefined();
    expect(left.find(n => n.id === t.a0.id).parentId).toBeNull();
  });

  test('keepChildren on a leaf only removes that leaf', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app)
      .delete(`/api/chats/${chatId}/nodes/${t.a2.id}`)
      .query({ keepChildren: 'yes' });
    expect(res.status).toBe(204);

    const left = await listNodes(chatId);
    expect(ids(left).sort()).toEqual(ids([t.u0, t.a0, t.u1, t.a1, t.u2]).sort());
  });

  test('404 when the node does not exist', async () => {
    const chatId = await createChat();
    const res = await request(app).delete(`/api/chats/${chatId}/nodes/missing-node`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('404 when the node belongs to a different chat', async () => {
    const chatA = await createChat('A');
    const chatB = await createChat('B');
    const t = await linear(chatA);
    const res = await request(app).delete(`/api/chats/${chatB}/nodes/${t.u0.id}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/chats/:chatId/nodes/:nodeId parentId', () => {
  test('reparents a mid-tree node under another node', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app)
      .patch(`/api/chats/${chatId}/nodes/${t.u2.id}`)
      .send({ parentId: t.a0.id });
    expect(res.status).toBe(200);
    expect(res.body.parentId).toBe(t.a0.id);

    const left = await listNodes(chatId);
    expect(left.find(n => n.id === t.u2.id).parentId).toBe(t.a0.id);
    expect(left.find(n => n.id === t.a2.id).parentId).toBe(t.u2.id);
  });

  test('lifts a node to root with parentId null', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app)
      .patch(`/api/chats/${chatId}/nodes/${t.u1.id}`)
      .send({ parentId: null });
    expect(res.status).toBe(200);
    expect(res.body.parentId).toBeNull();
  });

  test('400 when reparenting a node under itself', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app)
      .patch(`/api/chats/${chatId}/nodes/${t.u1.id}`)
      .send({ parentId: t.u1.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/itself/i);
  });

  test('400 when reparenting a node under its descendant', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app)
      .patch(`/api/chats/${chatId}/nodes/${t.a0.id}`)
      .send({ parentId: t.a2.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/descendant/i);
  });

  test('400 when the new parent does not exist', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const res = await request(app)
      .patch(`/api/chats/${chatId}/nodes/${t.u1.id}`)
      .send({ parentId: 'no-such-parent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Parent node not found/i);
  });

  test('404 when the node itself is missing', async () => {
    const chatId = await createChat();
    const res = await request(app)
      .patch(`/api/chats/${chatId}/nodes/missing-node`)
      .send({ parentId: null });
    expect(res.status).toBe(404);
  });
});

describe('insert via branch-user + reparent', () => {
  test('mid-tree insert: new sibling question, then adopt old siblings under the new answer', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const branched = await request(app)
      .post(`/api/chats/${chatId}/nodes/${t.u1.id}/branch-user`)
      .send({ content: 'inserted Q' });
    expect(branched.status).toBe(201);
    expect(branched.body.parentId).toBe(t.u1.parentId);

    const answer = await addNode(chatId, {
      parentId: branched.body.id,
      role: 'assistant',
      content: 'inserted A'
    });

    const adopt = await request(app)
      .patch(`/api/chats/${chatId}/nodes/${t.u1.id}`)
      .send({ parentId: answer.id });
    expect(adopt.status).toBe(200);
    expect(adopt.body.parentId).toBe(answer.id);

    const left = await listNodes(chatId);
    expect(left.find(n => n.id === branched.body.id).parentId).toBe(t.a0.id);
    expect(left.find(n => n.id === t.u1.id).parentId).toBe(answer.id);
    expect(left.find(n => n.id === t.a1.id).parentId).toBe(t.u1.id);
  });

  test('root insert: new root question, old root adopted under the new answer', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const branched = await request(app)
      .post(`/api/chats/${chatId}/nodes/${t.u0.id}/branch-user`)
      .send({ content: 'new root Q' });
    expect(branched.status).toBe(201);
    expect(branched.body.parentId).toBeNull();

    const answer = await addNode(chatId, {
      parentId: branched.body.id,
      role: 'assistant',
      content: 'inserted A'
    });

    const adopt = await request(app)
      .patch(`/api/chats/${chatId}/nodes/${t.u0.id}`)
      .send({ parentId: answer.id });
    expect(adopt.status).toBe(200);

    const left = await listNodes(chatId);
    const roots = left.filter(n => n.parentId == null).map(n => n.id);
    expect(roots).toEqual([branched.body.id]);
    expect(left.find(n => n.id === t.u0.id).parentId).toBe(answer.id);
  });

  test('leaf-question insert adopts the old leaf question under the new answer', async () => {
    const chatId = await createChat();
    const t = await linear(chatId);

    const branched = await request(app)
      .post(`/api/chats/${chatId}/nodes/${t.u2.id}/branch-user`)
      .send({ content: 'leaf insert' });
    expect(branched.status).toBe(201);
    expect(branched.body.parentId).toBe(t.a1.id);

    const answer = await addNode(chatId, {
      parentId: branched.body.id,
      role: 'assistant',
      content: 'inserted A'
    });

    await request(app)
      .patch(`/api/chats/${chatId}/nodes/${t.u2.id}`)
      .send({ parentId: answer.id })
      .expect(200);

    const left = await listNodes(chatId);
    expect(left.find(n => n.id === t.u2.id).parentId).toBe(answer.id);
    expect(left.find(n => n.id === t.a2.id).parentId).toBe(t.u2.id);
  });
});
