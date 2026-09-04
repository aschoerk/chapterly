import { Injectable, signal, computed, inject } from '@angular/core';
import { Chat, ChatNode, CreateNodeRequest,  NodeAttachment } from '../models/chat';
import { CHAT_API } from '../api/chat-api.token';
import {NodeEditSession} from './node-edit-session';

const LS_CHAT  = 'chat.currentChatId';
const LS_SCROLL = 'chat.scrollByChatId';

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private readonly api = inject(CHAT_API);
  private readonly editSession = inject(NodeEditSession)


  readonly _chats = signal<Chat[]>([]);
  private readonly _nodes = signal<ChatNode[]>([]);
  private readonly _currentChatId = signal<string | null>(null);

  readonly chats = computed(() => this._chats());
  readonly nodes = computed(() => this._nodes());
  readonly currentChatId = computed(() => this._currentChatId());


  readonly chatsByProject = computed(() => {
    const map = new Map<string | null, Chat[]>();
    for (const chat of this._chats()) {
      const key = chat.projectId ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(chat);
    }
    return map;
  });

  /** All nodes of the currently selected chat as a flat list */
  readonly currentNodes = computed(() => {
    const chatId = this._currentChatId();
    if (!chatId) return [];
    return this._nodes().filter(n => n.chatId === chatId);
  });

  private loadViewPref(key: string, fallback: boolean): boolean {
    const raw = localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  }

  readonly followStreaming = signal(this.loadViewPref('chat.view.followStreaming', true));
  readonly followThinking = signal(this.loadViewPref('chat.view.followThinking', true));
  readonly alwaysOpenAtLeaf = signal(this.loadViewPref('chat.view.alwaysOpenAtLeaf', false));

  setFollowStreaming(on: boolean) {
    this.followStreaming.set(on);
    localStorage.setItem('chat.view.followStreaming', on ? '1' : '0');
  }

  setFollowThinking(on: boolean) {
    this.followThinking.set(on);
    localStorage.setItem('chat.view.followThinking', on ? '1' : '0');
  }

  setAlwaysOpenAtLeaf(on: boolean) {
    this.alwaysOpenAtLeaf.set(on);
    localStorage.setItem('chat.view.alwaysOpenAtLeaf', on ? '1' : '0');
  }

  readonly streamSpeedUnit = signal<'char' | 'word'>(
    this.loadViewPrefStr('chat.view.streamSpeedUnit', 'char') as 'char' | 'word'
  );
  /** Units per second. 0 = instant (current behavior). */
  readonly streamSpeed = signal(this.loadViewPrefNum('chat.view.streamSpeed', 0));

  private loadViewPrefStr(key: string, fallback: string): string {
    return localStorage.getItem(key) || fallback;
  }

  private loadViewPrefNum(key: string, fallback: number): number {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) ? n : fallback;
  }

  private static readonly CHARS_PER_WORD = 5;
  private static readonly CHAR_MAX = 160;
  private static readonly WORD_MAX = 30;

  setStreamSpeedUnit(unit: 'char' | 'word') {
    const from = this.streamSpeedUnit();
    if (unit === from) return;

    const rate = this.streamSpeed();
    let next = rate;

    if (rate > 0) {
      next = from === 'char'
        ? rate / ChatService.CHARS_PER_WORD
        : rate * ChatService.CHARS_PER_WORD;
    }

    const max = unit === 'word' ? ChatService.WORD_MAX : ChatService.CHAR_MAX;
    const step = unit === 'word' ? 1 : 5;
    next = rate === 0 ? 0 : Math.min(max, Math.max(step, Math.round(next / step) * step));

    this.streamSpeedUnit.set(unit);
    localStorage.setItem('chat.view.streamSpeedUnit', unit);
    this.setStreamSpeed(next);
  }

  setStreamSpeed(rate: number) {
    const n = Math.max(0, rate);
    this.streamSpeed.set(n);
    localStorage.setItem('chat.view.streamSpeed', String(n));
  }

  private readScrollMap(): Record<string, number> {
    try {
      const raw = localStorage.getItem(LS_SCROLL);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  getSavedScroll(chatId: string | null | undefined): number | null {
    if (!chatId) return null;
    const value = this.readScrollMap()[chatId];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  saveScroll(chatId: string | null | undefined, top: number): void {
    if (!chatId) return;
    const map = this.readScrollMap();
    map[chatId] = Math.max(0, Math.round(top));
    localStorage.setItem(LS_SCROLL, JSON.stringify(map));
  }

  scrollToNode(nodeId: string) {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement | null;
    if (!el) return;

    el.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
      inline: 'nearest'
    });
  }

  updateNodes(updateFn: (value: ChatNode[]) => ChatNode[]): void {
    this._nodes?.update?.(updateFn);
  }


  // ---------- Chats ----------

  async loadChats(): Promise<void> {
    this._chats.set(await this.api.getChats());
  }

  async createChat(title = 'New Chat', projectId: string | null = null): Promise<Chat> {
    const chat = await this.api.createChat(title, projectId);
    this._chats.update(list => [chat, ...list]);
    return chat;
  }

  async deleteChat(id: string): Promise<void> {
    await this.api.deleteChat(id);
    this._chats.update(list => list.filter(c => c.id !== id));

    if (this._currentChatId() === id) {
      this._currentChatId.set(null);
      this._nodes.set([]);
    }
  }

  async reassignChat(chatId: string, projectId: string | null): Promise<Chat> {
    const chat = await this.api.patchChat(chatId, {projectId});
    this._chats.update(list =>
      list.map(c => (c.id === chatId ? chat : c))
    );
    return chat;
  }

  async reassignChatParams(chatId: string, chatParametersId: string | null): Promise<Chat> {
    const chat = await this.api.patchChat(chatId, { chatParametersId });
    this._chats.update(list =>
      list.map(c => (c.id === chatId ? chat : c))
    );
    return chat;
  }


  /** Walk root → leaf, choosing the newest child at every fork. */
  restoreMostRecentPath(): void {
    const map: Record<string, string> = {};
    let parentId: string | null = null;
    while (true) {
      const child = this.newestChild(parentId);
      if (!child) break;
      map[parentId ?? 'root'] = child.id;
      parentId = child.id;
    }
    this._activeChildMap.set(map);
  }

  async selectChat(chatId: string): Promise<void> {
    if (chatId === this._currentChatId()) return;

    if (!(await this.editSession.canLeaveChat(chatId))) {
      return; // tree, path, localStorage untouched
    }
    if (chatId) {
      localStorage.setItem(LS_CHAT, chatId);
    } else {
      localStorage.removeItem(LS_CHAT);
    }
    this._currentChatId.set(chatId);
    this._activeChildMap.set({});
    await this.loadNodes(chatId);
    this.restoreMostRecentPath();
    await this.ensureDraftAtLeaf(chatId);
  }

  // ---------- Nodes ----------

  async loadNodes(chatId: string): Promise<void> {
    this._nodes.set(await this.api.getNodes(chatId));
  }

  async addNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    const node = await this.api.createNode(chatId, data);
    this._nodes.update(list => [...list, node]);
    return node;
  }

  async deleteNode(chatId: string, nodeId: string): Promise<void> {
    const snapshot = this._nodes();
    const target = snapshot.find(n => n.id === nodeId);
    const parentId = target?.parentId ?? null;

    await this.api.deleteNode(chatId, nodeId);

    const toDelete = new Set<string>();
    const collect = (id: string) => {
      toDelete.add(id);
      snapshot.filter(n => n.parentId === id).forEach(child => collect(child.id));
    };
    collect(nodeId);

    this._nodes.update(list => list.filter(n => !toDelete.has(n.id)));

    this._activeChildMap.update(m => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(m)) {
        if (toDelete.has(k) || toDelete.has(v)) continue;
        next[k] = v;
      }
      return next;
    });

    const remaining = this.getChildren(parentId);
    if (remaining.length > 0) {
      this.setActiveChild(parentId, this.newestChild(parentId)!.id);
    }

    await this.ensureDraftAtLeaf(chatId);
  }

  private adoptSubtree(oldId: string, newId: string): void {
    if (oldId === newId) return;

    this._nodes.update(list =>
      list.map(n => n.parentId === oldId ? { ...n, parentId: newId } : n)
    );

    this._activeChildMap.update(m => {
      if (!(oldId in m)) return m;
      const { [oldId]: childId, ...rest } = m;
      return { ...rest, [newId]: childId };
    });
  }

  async editAssistant(chatId: string, nodeId: string, content: string,
                      attachments?: NodeAttachment[],
                      thinking?: string): Promise<ChatNode> {
    const body: any = {content};
    const saved = await this.api.editAssistant(chatId, nodeId, content, attachments, thinking);

    this._nodes.update(list => {
      const retired = list.map(n =>
        n.id === nodeId && saved.id !== nodeId ? { ...n, isCurrent: false } : n
      );
      const withoutDup = retired.filter(n => n.id !== saved.id);
      return [...withoutDup, saved];
    });

    this.adoptSubtree(nodeId, saved.id);
    this.setActiveChild(saved.parentId ?? null, saved.id);
    await this.ensureDraftAtLeaf(chatId);
    return saved;
  }

  async editUser(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    const saved = await this.api.editUser(chatId, nodeId, content, attachments);

    this._nodes.update(list => {
      const retired = list.map(n =>
        n.id === nodeId && saved.id !== nodeId ? { ...n, isCurrent: false } : n
      );
      const withoutDup = retired.filter(n => n.id !== saved.id);
      return [...withoutDup, saved];
    });

    this.adoptSubtree(nodeId, saved.id);
    this.setActiveChild(saved.parentId ?? null, saved.id);
    return saved;
  }

  /** Edit a question → creates a new branch */
  async branchQuestion(
    chatId: string,
    nodeId: string,
    content: string,
    modelId?: string,
    providerId?: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    const body: any = {content, modelId, providerId};
    if (attachments !== undefined) body.attachments = attachments;
    const node = await this.api.branchUser(chatId, nodeId, {
      content,
      modelId,
      providerId,
      attachments
    });
    this._nodes.update(list => [...list, node]);
    return node;
  }


  async updateChatTitle(id: string, title: string): Promise<void> {
    const updated = await this.api.patchChat(id, {title});

    this._chats.update(list =>
      list.map(c => (c.id === id ? updated : c))
    );
  }

  // Currently generating answer
  readonly generatingNodeId = signal<string | null>(null);

  private currentAbortController: AbortController | null = null;

  startGeneration(nodeId: string): AbortSignal {
    this.stopGeneration(); // cancel any previous one
    this.currentAbortController = new AbortController();
    this.generatingNodeId.set(nodeId);
    return this.currentAbortController.signal;
  }

  stopGeneration(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.generatingNodeId.set(null);
  }

  isGenerating(nodeId: string): boolean {
    return this.generatingNodeId() === nodeId;
  }

  /** parentId → currently active childId */
  private readonly _activeChildMap = signal<Record<string, string>>({});

// ---------- Public API ----------

  /** Currently chosen child under a parent (null parent = root level) */
  getActiveChildId(parentId: string | null): string | null {
    const key = parentId ?? 'root';
    return this._activeChildMap()[key] ?? null;
  }

  /** Switch the active sibling under a parent */
  setActiveChild(parentId: string | null, childId: string): void {
    const key = parentId ?? 'root';
    this._activeChildMap.update(m => ({...m, [key]: childId}));
  }

  private nodeTimestamp(n: ChatNode): number {
    const raw = n.updatedAt || n.createdAt || '';
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  }

  newestChild(parentId: string | null): ChatNode | null {
    const siblings = this.getChildren(parentId);
    if (siblings.length === 0) return null;
    return siblings.reduce((a, b) =>
      this.nodeTimestamp(a) >= this.nodeTimestamp(b) ? a : b
    );
  }

  getActiveChild(parentId: string | null): ChatNode | null {
    const siblings = this.getChildren(parentId);
    if (siblings.length === 0) return null;

    const activeId = this.getActiveChildId(parentId);
    const found = siblings.find(s => s.id === activeId);
    return found ?? this.newestChild(parentId);
  }

  /** Linear path from root following the active-child map */
  getActivePath(): ChatNode[] {
    const path: ChatNode[] = [];
    let current = this.getActiveChild(null);
    while (current) {
      path.push(current);
      current = this.getActiveChild(current.id);
    }
    return path;
  }


  /** Path from root down to (and including) a given node */
  getPathToNode(nodeId: string): ChatNode[] {
    const map = new Map(this._nodes().map(n => [n.id, n]));
    const path: ChatNode[] = [];
    let cur: ChatNode | undefined = map.get(nodeId);
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? map.get(cur.parentId) : undefined;
    }
    return path;
  }


  getChildren(parentId: string | null): ChatNode[] {
    return this._nodes().filter(n =>
      (n.parentId ?? null) === (parentId ?? null) &&
      n.isCurrent
    );
  }

  /** All siblings of a given node (including the node itself) */
  getSiblingsOf(node: ChatNode): ChatNode[] {
    return this.getChildren(node.parentId ?? null);
  }


// on startup (e.g. inside loadChats / init)
  restoreCurrentChat(): void {
    const saved = localStorage.getItem(LS_CHAT);
    if (saved && this._chats().some(c => c.id === saved)) {
      this.selectChat(saved);
    } else {
      localStorage.removeItem(LS_CHAT);
    }
  }

  private ensuringDraft = false;

  isDraftQuestion(node: ChatNode): boolean {
    return node.role === 'user'
      && !node.content?.trim()
      && !(node.attachments?.length);
  }

  async persistQuestion(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[],
    modelId?: string,
    providerId?: string
  ): Promise<ChatNode> {
    const node = await this.api.patchNode(chatId, nodeId, {
      content,
      attachments,
      modelId,
      providerId
    });
    this._nodes.update(list => list.map(n => (n.id === nodeId ? {...n, ...node} : n)));
    return this._nodes().find(n => n.id === nodeId) ?? node;
  }

  /**
   * Guarantee the active path ends on an empty question the user can type into.
   * - empty chat → root draft question
   * - leaf answer with generated text and no child question → child draft
   */
  async ensureDraftAtLeaf(chatId: string): Promise<void> {
    if (!chatId || this.ensuringDraft || this.generatingNodeId()) return;
    if (this._currentChatId() !== chatId) return;

    this.ensuringDraft = true;
    try {
      if (this._nodes().every(n => n.chatId !== chatId)) {
        await this.loadNodes(chatId);
      }

      if (!this.getActivePath().length) {
        this.restoreMostRecentPath();
      }

      let leaf = this.getActivePath().at(-1) ?? null;

      if (!leaf) {
        const roots = this.getChildren(null).filter(n => n.role === 'user');
        if (roots.length > 0) {
          this.setActiveChild(null, this.newestChild(null)!.id);
          return;
        }
        const draft = await this.addNode(chatId, {
          parentId: null,
          role: 'user',
          content: ''
        });
        this.setActiveChild(null, draft.id);
        return;
      }

      if (leaf.role !== 'assistant') return;
      if (!leaf.content?.trim()) return;

      const existing = this.getChildren(leaf.id).filter(n => n.role === 'user');
      if (existing.length > 0) {
        const draft = existing.find(n => this.isDraftQuestion(n)) ?? existing[0];
        this.setActiveChild(leaf.id, draft.id);
        return;
      }

      const draft = await this.addNode(chatId, {
        parentId: leaf.id,
        role: 'user',
        content: '',
        modelId: leaf.modelId || undefined,
        providerId: leaf.providerId || undefined
      });
      this.setActiveChild(leaf.id, draft.id);
    } finally {
      this.ensuringDraft = false;
    }
  }
  async fetchNodes(chatId: string): Promise<ChatNode[]> {
    return this.api.getNodes(chatId);
  }
}
