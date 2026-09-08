import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { ChatService } from './chat.service';
import { NodeEditSession } from './node-edit-session';
import { ConfirmService } from './confirm.service';
import { CHAT_API } from '../api/chat-api.token';
import { InMemoryChatApi } from '../../../test-helpers/in-memory-chat-api';
import { ChatNode, CreateNodeRequest } from '../models/chat';

/**
 * Chat-editing use cases (insert / remove / delete) on the Angular side.
 * Insert is simulated without an LLM: branchQuestion + addNode(answer) + reparentNodes.
 * startGeneration() freezes ensureDraftAtLeaf so draft nodes do not appear mid-assert.
 */

function ids(nodes: ChatNode[]): string[] {
  return nodes.map(n => n.id);
}

function byId(nodes: ChatNode[], id: string): ChatNode {
  const n = nodes.find(x => x.id === id);
  if (!n) throw new Error(`missing node ${id}`);
  return n;
}

describe('ChatService edit ops (insert / remove / delete)', () => {
  let api: InMemoryChatApi;
  let chat: ChatService;
  let chatId: string;

  beforeEach(async () => {
    api = new InMemoryChatApi();
    localStorage.removeItem('chat.currentChatId');
    localStorage.removeItem('chat.scrollByChatId');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ChatService,
        NodeEditSession,
        ConfirmService,
        { provide: CHAT_API, useValue: api }
      ]
    });
    chat = TestBed.inject(ChatService);

    const row = await chat.createChat('edit-ops');
    chatId = row.id;
    await chat.selectChat(chatId);
    chat.startGeneration('freeze-drafts');

    const leftover = chat.nodes().filter(n => n.chatId === chatId);
    for (const n of leftover) {
      await chat.deleteNode(chatId, n.id);
    }
    expect(chat.nodes().filter(n => n.chatId === chatId)).toEqual([]);
  });

  async function add(data: CreateNodeRequest): Promise<ChatNode> {
    return chat.addNode(chatId, data);
  }

  /** Linear thread: u0 → a0 → u1 → a1 → u2 → a2 (u0 is the root). */
  async function linear() {
    const u0 = await add({ parentId: null, role: 'user', content: 'Q0' });
    const a0 = await add({ parentId: u0.id, role: 'assistant', content: 'A0' });
    const u1 = await add({ parentId: a0.id, role: 'user', content: 'Q1' });
    const a1 = await add({ parentId: u1.id, role: 'assistant', content: 'A1' });
    const u2 = await add({ parentId: a1.id, role: 'user', content: 'Q2' });
    const a2 = await add({ parentId: u2.id, role: 'assistant', content: 'A2' });
    chat.setActiveChild(null, u0.id);
    chat.setActiveChild(u0.id, a0.id);
    chat.setActiveChild(a0.id, u1.id);
    chat.setActiveChild(u1.id, a1.id);
    chat.setActiveChild(a1.id, u2.id);
    chat.setActiveChild(u2.id, a2.id);
    return { u0, a0, u1, a1, u2, a2 };
  }

  /**
   * Insert without streaming: sibling question + answer, then adopt every
   * previous node that shared the insertion parent's children list.
   */
  async function insertAt(question: ChatNode, text = 'inserted Q') {
    const parentId = question.parentId ?? null;
    const newQ = await chat.branchQuestion(chatId, question.id, text);
    const newA = await add({ parentId: newQ.id, role: 'assistant', content: 'inserted A' });
    const adoptIds = chat.nodes()
      .filter(n => n.chatId === chatId && (n.parentId ?? null) === parentId && n.id !== newQ.id)
      .map(n => n.id);
    await chat.reparentNodes(chatId, adoptIds, newA.id);
    return { newQ, newA, adoptIds, parentId };
  }

  describe('delete cascade (remove subtree)', () => {
    it('deletes a leaf assistant and leaves the rest of the path intact', async () => {
      const t = await linear();
      await chat.deleteNode(chatId, t.a2.id);

      const left = chat.nodes();
      expect(ids(left).sort()).toEqual(ids([t.u0, t.a0, t.u1, t.a1, t.u2]).sort());
      expect(chat.getChildren(t.u2.id)).toEqual([]);
      expect(api.nodes.find(n => n.id === t.a2.id)).toBeUndefined();
    });

    it('deletes a mid-tree answer and every descendant', async () => {
      const t = await linear();
      await chat.deleteNode(chatId, t.a1.id);

      const left = chat.nodes();
      expect(ids(left).sort()).toEqual(ids([t.u0, t.a0, t.u1]).sort());
      expect(left.some(n => n.id === t.u2 || n.id === t.a2)).toBe(false);
      expect(api.nodes.filter(n => n.chatId === chatId).map(n => n.id).sort())
        .toEqual(ids(left).sort());
    });

    it('deletes the root question and the entire tree', async () => {
      const t = await linear();
      await chat.deleteNode(chatId, t.u0.id);

      expect(chat.nodes().filter(n => n.chatId === chatId)).toEqual([]);
      expect(api.nodes.filter(n => n.chatId === chatId)).toEqual([]);
    });

    it('rejects delete of a missing node', async () => {
      await linear();
      await expect(chat.deleteNode(chatId, 'no-such-node')).rejects.toThrow(/not found/i);
    });
  });

  describe('delete keepChildren (remove node only)', () => {
    it('reparents mid-tree children onto the deleted node\'s parent', async () => {
      const t = await linear();
      await chat.deleteNode(chatId, t.a1.id, { keepChildren: true });

      const left = chat.nodes();
      expect(left.find(n => n.id === t.a1.id)).toBeUndefined();
      expect(byId(left, t.u2.id).parentId).toBe(t.u1.id);
      expect(byId(left, t.a2.id).parentId).toBe(t.u2.id);
      expect(ids(chat.getChildren(t.u1.id))).toEqual([t.u2.id]);
    });

    it('promotes children of a deleted root to new roots', async () => {
      const t = await linear();
      await chat.deleteNode(chatId, t.u0.id, { keepChildren: true });

      const left = chat.nodes();
      expect(left.find(n => n.id === t.u0.id)).toBeUndefined();
      expect(byId(left, t.a0.id).parentId).toBeNull();
      expect(ids(chat.getChildren(null))).toEqual([t.a0.id]);
      expect(byId(left, t.u1.id).parentId).toBe(t.a0.id);
    });

    it('removing a leaf with keepChildren is the same as cascade', async () => {
      const t = await linear();
      await chat.deleteNode(chatId, t.a2.id, { keepChildren: true });
      expect(chat.nodes().find(n => n.id === t.a2.id)).toBeUndefined();
      expect(ids(chat.getChildren(t.u2.id))).toEqual([]);
    });
  });

  describe('insert (branch + reparent)', () => {
    it('inserts above a mid-tree question and hangs the old subtree under the new answer', async () => {
      const t = await linear();
      const { newQ, newA, parentId } = await insertAt(t.u1);

      expect(newQ.parentId).toBe(parentId);
      expect(newQ.parentId).toBe(t.a0.id);
      expect(byId(chat.nodes(), t.u1.id).parentId).toBe(newA.id);
      expect(byId(chat.nodes(), t.a1.id).parentId).toBe(t.u1.id);
      expect(ids(chat.getChildren(t.a0.id))).toEqual([newQ.id]);
      expect(ids(chat.getChildren(newA.id))).toEqual([t.u1.id]);
    });

    it('inserts above the root question: new root, old root adopted under the new answer', async () => {
      const t = await linear();
      const { newQ, newA } = await insertAt(t.u0, 'new root Q');

      expect(newQ.parentId).toBeNull();
      expect(byId(chat.nodes(), t.u0.id).parentId).toBe(newA.id);
      expect(ids(chat.getChildren(null))).toEqual([newQ.id]);
      expect(ids(chat.getChildren(newA.id))).toEqual([t.u0.id]);
      expect(byId(chat.nodes(), t.a0.id).parentId).toBe(t.u0.id);
    });

    it('inserts above a leaf question (no further descendants yet)', async () => {
      const t = await linear();
      const { newQ, newA } = await insertAt(t.u2);

      expect(newQ.parentId).toBe(t.a1.id);
      expect(byId(chat.nodes(), t.u2.id).parentId).toBe(newA.id);
      expect(ids(chat.getChildren(t.a1.id))).toEqual([newQ.id]);
      expect(ids(chat.getChildren(newA.id))).toEqual([t.u2.id]);
    });

    it('insert among several siblings adopts every previous sibling, not just the edited one', async () => {
      const t = await linear();
      const u1b = await add({ parentId: t.a0.id, role: 'user', content: 'Q1-sibling' });
      const { newQ, newA } = await insertAt(t.u1);

      const adopted = chat.getChildren(newA.id).map(n => n.id).sort();
      expect(adopted).toEqual([t.u1.id, u1b.id].sort());
      expect(ids(chat.getChildren(t.a0.id))).toEqual([newQ.id]);
    });
  });

  describe('reparentNodes fringe cases', () => {
    it('skips a self-parent request (no API write, tree unchanged)', async () => {
      const t = await linear();
      await chat.reparentNodes(chatId, [t.u1.id], t.u1.id);
      expect(byId(chat.nodes(), t.u1.id).parentId).toBe(t.a0.id);
    });

    it('moves a mid-tree node under another existing node', async () => {
      const t = await linear();
      await chat.reparentNodes(chatId, [t.u2.id], t.a0.id);
      expect(byId(chat.nodes(), t.u2.id).parentId).toBe(t.a0.id);
      expect(ids(chat.getChildren(t.a1.id))).toEqual([]);
    });

    it('can lift a node to root by passing parentId null', async () => {
      const t = await linear();
      await chat.reparentNodes(chatId, [t.u1.id], null);
      expect(byId(chat.nodes(), t.u1.id).parentId).toBeNull();
      expect(ids(chat.getChildren(null)).sort()).toEqual([t.u0.id, t.u1.id].sort());
    });
  });

  describe('ensureDraftAtLeaf after delete', () => {
    it('does not spawn a draft while generation is frozen', async () => {
      const t = await linear();
      await chat.deleteNode(chatId, t.a2.id);
      expect(chat.nodes().some(n => chat.isDraftQuestion(n))).toBe(false);
    });

    it('creates a root draft after the last node is deleted once generation is cleared', async () => {
      const t = await linear();
      await chat.deleteNode(chatId, t.u0.id);
      expect(chat.nodes()).toEqual([]);

      chat.stopGeneration();
      await chat.ensureDraftAtLeaf(chatId);

      const draft = chat.nodes().find(n => chat.isDraftQuestion(n));
      expect(draft).toBeTruthy();
      expect(draft!.parentId).toBeNull();
      expect(draft!.role).toBe('user');
    });

    it('adds a draft question under a remaining leaf answer', async () => {
      const t = await linear();
      await chat.deleteNode(chatId, t.u2.id);
      chat.stopGeneration();
      chat.setActiveChild(t.u1.id, t.a1.id);
      await chat.ensureDraftAtLeaf(chatId);

      const kids = chat.getChildren(t.a1.id);
      expect(kids).toHaveLength(1);
      expect(chat.isDraftQuestion(kids[0])).toBe(true);
    });
  });
});
