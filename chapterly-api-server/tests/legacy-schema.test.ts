/**
 * Regression test for versioning (edit-user / edit-assistant) against a DB
 * whose chat_nodes table carries an EXTRA column (e.g. a legacy `total_cost`
 * column). The versioning INSERT must use an explicit column list so it works
 * regardless of extra columns in a pre-existing database.
 *
 * Bug: positional `INSERT INTO chat_nodes SELECT ...` failed with
 * "table chat_nodes has 18 columns but 17 values were supplied" whenever the
 * live DB schema had more columns than the fresh one used in tests.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { SqlitePersistence } from '../src/persistence/sqlite/sqlite-persistence.js';
import { createApp } from '../src/http/create-app.js';

let app: Express;
let store: SqlitePersistence;
let dbFile: string;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chapterly-legacy-'));
  dbFile = path.join(dir, 'chapterly.sqlite');

  const legacy = new Database(dbFile);
  legacy.exec(`
    CREATE TABLE chat_nodes (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      parent_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      thinking TEXT,
      model_id TEXT,
      provider_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      previous_version_id TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      attachments TEXT DEFAULT '[]',
      is_current INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      chat_parameters_id TEXT
    );
    ALTER TABLE chat_nodes ADD COLUMN total_cost REAL;
  `);
  legacy.close();

  store = new SqlitePersistence(dbFile);
  await store.init();

  app = createApp(store);
});

afterAll(async () => {
  await store.close();
  if (dbFile) fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe('versioning on a legacy DB with an extra column', () => {
  test('edit-user returns 201 and creates a new version (non-empty node)', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'legacy' });
    expect(chat.status).toBe(201);

    const node = await request(app)
      .post(`/api/chats/${chat.body.id}/nodes`)
      .send({ role: 'user', content: 'Question' });
    expect(node.status).toBe(201);

    const edit = await request(app)
      .post(`/api/chats/${chat.body.id}/nodes/${node.body.id}/edit-user`)
      .send({ content: 'Edited question' });

    expect(edit.status).toBe(201);
    expect(edit.body.id).not.toBe(node.body.id);
    expect(edit.body.version).toBe(2);
    expect(edit.body.previousVersionId).toBe(node.body.id);
    expect(edit.body.content).toBe('Edited question');
  });

  test('edit-assistant returns 201 and reparents children (empty-leaf in place)', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'legacy2' });

    const empty = await request(app)
      .post(`/api/chats/${chat.body.id}/nodes`)
      .send({ role: 'assistant', content: '', parentId: null });
    expect(empty.body.version).toBe(1);

    const child = await request(app)
      .post(`/api/chats/${chat.body.id}/nodes`)
      .send({ role: 'user', content: 'child', parentId: empty.body.id });
    expect(child.status).toBe(201);

    const edit = await request(app)
      .post(`/api/chats/${chat.body.id}/nodes/${empty.body.id}/edit-assistant`)
      .send({ content: 'filled now' });

    expect(edit.status).toBe(201);
    // has a child -> NOT an empty placeholder -> new version row
    expect(edit.body.id).not.toBe(empty.body.id);
    expect(edit.body.version).toBe(2);

    const nodes = await request(app).get(`/api/chats/${chat.body.id}/nodes`);
    const reparented = nodes.body.find((n: { id: string }) => n.id === child.body.id);
    expect(reparented.parentId).toBe(edit.body.id);
  });

  test('migrates the legacy role check so structural nodes can be created', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'structural legacy' });
    const structural = await request(app)
      .post(`/api/chats/${chat.body.id}/nodes`)
      .send({ role: 'structural', content: 'Chapter One' });

    expect(structural.status).toBe(201);
    expect(structural.body.role).toBe('structural');
  });
});