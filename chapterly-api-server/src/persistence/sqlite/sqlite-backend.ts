import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { PersistenceKind } from '../../domain/chat-api.port.js';
import type { ProviderSnapshot, TopicSnapshot } from '../memory/memory-persistence.js';
import type { SnapshotBackend } from '../snapshot-store.js';
import { conflict } from '../../http/http-error.js';

export class SqliteSnapshot implements SnapshotBackend {
  readonly kind: PersistenceKind = 'sqlite';
  private db: Database.Database | null = null;

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new Database(this.filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_snapshots (
        topic_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        update_id TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_snapshots (
        provider_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        update_id TEXT NOT NULL,
        json TEXT NOT NULL
      );
    `);
  }

  private store(): Database.Database {
    if (!this.db) throw new Error('sqlite backend closed');
    return this.db;
  }

  async listTopicIds(): Promise<string[]> {
    const rows = this.store().prepare('SELECT topic_id FROM topic_snapshots').all() as {
      topic_id: string;
    }[];
    return rows.map((row) => row.topic_id);
  }

  async listProviderIds(): Promise<string[]> {
    const rows = this.store().prepare('SELECT provider_id FROM provider_snapshots').all() as {
      provider_id: string;
    }[];
    return rows.map((row) => row.provider_id);
  }

  async loadTopic(topicId: string): Promise<TopicSnapshot | null> {
    const row = this.store()
      .prepare('SELECT json FROM topic_snapshots WHERE topic_id = ?')
      .get(topicId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TopicSnapshot) : null;
  }

  async loadProvider(providerId: string): Promise<ProviderSnapshot | null> {
    const row = this.store()
      .prepare('SELECT json FROM provider_snapshots WHERE provider_id = ?')
      .get(providerId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as ProviderSnapshot) : null;
  }

  async saveTopic(snapshot: TopicSnapshot): Promise<{ revision: number; updateId: string }> {
    const nextRevision = snapshot.revision + 1;
    const updateId = randomUUID();
    const next: TopicSnapshot = { ...snapshot, revision: nextRevision, updateId };
    const json = JSON.stringify(next);
    if (snapshot.revision === 0) {
      try {
        this.store()
          .prepare(
            `
          INSERT INTO topic_snapshots (topic_id, revision, update_id, json)
          VALUES (?, ?, ?, ?)
        `,
          )
          .run(snapshot.topicId, nextRevision, updateId, json);
      } catch {
        throw conflict(`topic ${snapshot.topicId} was created by another node`);
      }
      return { revision: nextRevision, updateId };
    }
    const result = this.store()
      .prepare(
        `
      UPDATE topic_snapshots
      SET revision = ?, update_id = ?, json = ?
      WHERE topic_id = ? AND revision = ?
    `,
      )
      .run(nextRevision, updateId, json, snapshot.topicId, snapshot.revision);
    if (result.changes === 0) {
      throw conflict(`topic ${snapshot.topicId} revision ${snapshot.revision} is stale`);
    }
    return { revision: nextRevision, updateId };
  }

  async saveProvider(snapshot: ProviderSnapshot): Promise<{ revision: number; updateId: string }> {
    const nextRevision = snapshot.revision + 1;
    const updateId = randomUUID();
    const next: ProviderSnapshot = { ...snapshot, revision: nextRevision, updateId };
    const json = JSON.stringify(next);
    if (snapshot.revision === 0) {
      try {
        this.store()
          .prepare(
            `
          INSERT INTO provider_snapshots (provider_id, revision, update_id, json)
          VALUES (?, ?, ?, ?)
        `,
          )
          .run(snapshot.providerId, nextRevision, updateId, json);
      } catch {
        throw conflict(`provider ${snapshot.providerId} was created by another node`);
      }
      return { revision: nextRevision, updateId };
    }
    const result = this.store()
      .prepare(
        `
      UPDATE provider_snapshots
      SET revision = ?, update_id = ?, json = ?
      WHERE provider_id = ? AND revision = ?
    `,
      )
      .run(nextRevision, updateId, json, snapshot.providerId, snapshot.revision);
    if (result.changes === 0) {
      throw conflict(`provider ${snapshot.providerId} revision ${snapshot.revision} is stale`);
    }
    return { revision: nextRevision, updateId };
  }

  async deleteTopic(topicId: string): Promise<void> {
    this.store().prepare('DELETE FROM topic_snapshots WHERE topic_id = ?').run(topicId);
  }

  async deleteProvider(providerId: string): Promise<void> {
    this.store().prepare('DELETE FROM provider_snapshots WHERE provider_id = ?').run(providerId);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
