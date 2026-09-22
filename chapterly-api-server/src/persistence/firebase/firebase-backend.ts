import { randomUUID } from 'node:crypto';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { PersistenceKind } from '../../domain/chat-api.port.js';
import type { ProviderSnapshot, TopicSnapshot } from '../memory/memory-persistence.js';
import type { SnapshotBackend } from '../snapshot-store.js';
import { conflict } from '../../http/http-error.js';

export class FirebaseSnapshotBackend implements SnapshotBackend {
  readonly kind: PersistenceKind = 'firebase';
  private db: Firestore;

  constructor() {
    if (!getApps().length) {
      const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      initializeApp({
        credential: credPath ? cert(credPath) : applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
    }
    this.db = getFirestore();
  }

  async listTopicIds(): Promise<string[]> {
    const snap = await this.db.collection('topic_snapshots').listDocuments();
    return snap.map((doc) => doc.id);
  }

  async listProviderIds(): Promise<string[]> {
    const snap = await this.db.collection('provider_snapshots').listDocuments();
    return snap.map((doc) => doc.id);
  }

  async loadTopic(topicId: string): Promise<TopicSnapshot | null> {
    const snap = await this.db.collection('topic_snapshots').doc(topicId).get();
    return snap.exists ? (snap.data() as TopicSnapshot) : null;
  }

  async loadProvider(providerId: string): Promise<ProviderSnapshot | null> {
    const snap = await this.db.collection('provider_snapshots').doc(providerId).get();
    return snap.exists ? (snap.data() as ProviderSnapshot) : null;
  }

  async saveTopic(snapshot: TopicSnapshot): Promise<{ revision: number; updateId: string }> {
    const ref = this.db.collection('topic_snapshots').doc(snapshot.topicId);
    return this.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const storedRevision = current.exists ? (current.data() as TopicSnapshot).revision : 0;
      if (storedRevision !== snapshot.revision) {
        throw conflict(
          `topic ${snapshot.topicId} revision ${snapshot.revision} is stale (have ${storedRevision})`,
        );
      }
      const revision = snapshot.revision + 1;
      const updateId = randomUUID();
      tx.set(ref, { ...snapshot, revision, updateId });
      return { revision, updateId };
    });
  }

  async saveProvider(snapshot: ProviderSnapshot): Promise<{ revision: number; updateId: string }> {
    const ref = this.db.collection('provider_snapshots').doc(snapshot.providerId);
    return this.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const storedRevision = current.exists ? (current.data() as ProviderSnapshot).revision : 0;
      if (storedRevision !== snapshot.revision) {
        throw conflict(
          `provider ${snapshot.providerId} revision ${snapshot.revision} is stale (have ${storedRevision})`,
        );
      }
      const revision = snapshot.revision + 1;
      const updateId = randomUUID();
      tx.set(ref, { ...snapshot, revision, updateId });
      return { revision, updateId };
    });
  }

  async deleteTopic(topicId: string): Promise<void> {
    await this.db.collection('topic_snapshots').doc(topicId).delete();
  }

  async deleteProvider(providerId: string): Promise<void> {
    await this.db.collection('provider_snapshots').doc(providerId).delete();
  }

  async close(): Promise<void> {}
}
