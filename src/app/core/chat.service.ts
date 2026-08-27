import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Chat, ChatNode, CreateNodeRequest, Project, Persona, Topic, ChatMessage, NodeAttachment } from '../models/chat';
import { ChatApiService } from '../api/chat-api.service';
import {
  CreatePersonaRequest,
  CreateProjectRequest,
  CreateTopicRequest,
  LlmChatMessage,
  LlmNodeAttachment,
  UpdatePersonaRequest,
  UpdateProjectRequest,
  UpdateTopicRequest
} from '../api/chat-api.types';
import { getServerConfig } from './server-config';
import { firstValueFrom } from "rxjs";

const LS_CHAT  = 'chat.currentChatId';

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private readonly api = inject(ChatApiService);
  private readonly http = inject(HttpClient);
  private readonly config = getServerConfig();


  private readonly _chats = signal<Chat[]>([]);
  private readonly _nodes = signal<ChatNode[]>([]);
  private readonly _projects = signal<Project[]>([]);
  private readonly _personas = signal<Persona[]>([]);
  private readonly _topics = signal<Topic[]>([]);
  private readonly _currentChatId = signal<string | null>(null);
  private readonly CURRENT_PERSONA_KEY = 'chat-client.currentPersonaId';
  private readonly _currentPersonaId = signal<string | null>(null);

  readonly chats = computed(() => this._chats());
  readonly nodes = computed(() => this._nodes());
  readonly currentChatId = computed(() => this._currentChatId());
  readonly projects = computed(() => this._projects());
  readonly personas = computed(() => this._personas());
  readonly topics = computed(() => this._topics());
  readonly currentPersonaId = computed(() => this._currentPersonaId());
  readonly currentPersona = computed(() => this.getPersona(this._currentPersonaId()));

  constructor() {
    this.loadCurrentPersonaId();   // ← critical line
  }

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

  scrollToNode(nodeId: string) {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement | null;
    if (!el) return;

    el.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
      inline: 'nearest'
    });
  }

  // ---------- Projects ----------

  async loadProjects(): Promise<void> {
    this._projects.set(await this.api.getProjects());
  }

  async createProject(data: CreateProjectRequest): Promise<Project> {
    const project = await this.api.createProject(data);
    this._projects.update(list =>
      [...list, project].sort((a, b) => a.name.localeCompare(b.name))
    );
    return project;
  }

  async updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    const project = await this.api.updateProject(id, data);
    this._projects.update(list =>
      list
        .map(p => (p.id === id ? project : p))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    return project;
  }

  async deleteProject(id: string, deleteChats = false): Promise<void> {
    await this.api.deleteProject(id, deleteChats);
    this._projects.update(list => list.filter(p => p.id !== id));

    if (deleteChats) {
      this._chats.update(list => list.filter(c => c.projectId !== id));
    } else {
      this._chats.update(list =>
        list.map(c => (c.projectId === id ? { ...c, projectId: null } : c))
      );
    }
  }

  getProject(id: string | null | undefined): Project | undefined {
    if (!id) return undefined;
    return this._projects().find(p => p.id === id);
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
    const chat = await this.api.patchChat(chatId, { projectId });
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

  async editAnswer(chatId: string, nodeId: string, content: string,
                   attachments?: NodeAttachment[]): Promise<ChatNode> {
    const body: any = { content };
    const node = await this.api.editAnswer(chatId, nodeId, content, attachments);

    // Mark old version as not current locally and add the new one
    this. _nodes.update(list => {
      const updated = list.map(n =>
        n.id === nodeId ? { ...n, isCurrent: false } : n
      );
      return [...updated, node];
    });
    this.setActiveChild(node.parentId ?? null, node.id);
    await this.ensureDraftAtLeaf(chatId);
    return node;
  }

  async editQuestion(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    const node = await this.api.editQuestion(chatId, nodeId, content, attachments);

    this._nodes.update(list => {
      const updated = list.map(n => (n.id === nodeId ? { ...n, isCurrent: false } : n));
      return [...updated, node];
    });

    this.setActiveChild(node.parentId ?? null, node.id);
    return node;
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
    const body: any = { content, modelId, providerId };
    if (attachments !== undefined) body.attachments = attachments;
    const node = await this.api.branchQuestion(chatId, nodeId, {
      content,
      modelId,
      providerId,
      attachments
    });
    this._nodes.update(list => [...list, node]);
    return node;
  }



  async askLlm(
    providerBaseUrl: string,
    apiKey: string,
    modelId: string,
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const config = getServerConfig();

    const response = await fetch(`${config.proxyBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-target-base': providerBaseUrl,
        'HTTP-Referer': 'https://chat-client.local',
        'X-Title': 'Chat Client'
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: 0.7,
        stream: true
      }),
      signal                               // ← allows cancellation
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${errText}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
      while (true) {
        // This will throw if the signal is aborted
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                fullContent += delta;
                onChunk?.(delta);
              }
            } catch {
              // ignore partial / malformed chunks
            }
          }
        }
      }
    } catch (err: any) {
      // AbortError is expected when the user clicks Stop
      if (err?.name === 'AbortError') {
        // Return whatever we have received so far
        return fullContent.trim();
      }
      throw err;
    } finally {
      // Make sure the reader is released
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    return fullContent.trim() || '(no response)';
  }

  /**
   * Creates an empty answer node under the given question and streams the LLM response into it.
   * Supports cancellation via the generation AbortController.
   * Returns the final (or partial) content that was written.
   */
  async streamAnswer(
    chatId: string,
    questionNodeId: string,
    provider: { baseUrl: string; apiKey: string },
    model: { modelId: string; providerId: string },
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void
  ): Promise<ChatNode> {

    const answerNode = await this.addNode(chatId, {
      parentId: questionNodeId,
      type: 'answer',
      content: '',
      modelId: model.modelId,
      providerId: model.providerId
    });

    this.setActiveChild(questionNodeId, answerNode.id);

    const signal = this.startGeneration(answerNode.id);
    let accumulated = '';

    try {
      accumulated = await this.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        messages,
        (chunk: string) => {
          accumulated += chunk;

          // Live update in the local store
          this._nodes?.update?.(list =>
            list.map(n =>
              n.id === answerNode.id ? { ...n, content: accumulated } : n
            )
          );

          onChunk?.(chunk);
        },
        signal
      );

      // 3. Persist final / partial answer
      if (accumulated.trim()) {
        const versioned = await this.editAnswer(chatId, answerNode.id, accumulated);
        this.setActiveChild(questionNodeId, versioned.id);
        return versioned;
      }
      return answerNode;
    } catch (err) {
      // abort / network — keep whatever tokens we already wrote locally
      return answerNode;
    } finally {
      this.stopGeneration();
      if (accumulated.trim()) {
        const current = this.getActiveChild(questionNodeId) ?? answerNode;
        await this.ensureDraftAtLeaf(chatId);
        this.scrollToNode?.(current.id);
      }
    }
  }


  async updateChatTitle(id: string, title: string): Promise<void> {
    const updated = await this.api.patchChat(id, { title });

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

  // ---------- Personas ----------

  async loadPersonas(): Promise<void> {
    this._personas.set(await this.api.getPersonas());
  }

  async createPersona(data: CreatePersonaRequest): Promise<Persona> {
    const persona = await this.api.createPersona(data);
    this._personas.update(list =>
      [...list, persona].sort((a, b) => a.name.localeCompare(b.name))
    );
    return persona;
  }

  async updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> {
    const persona = await this.api.updatePersona(id, data);
    this._personas.update(list =>
      list
        .map(p => (p.id === id ? persona : p))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    return persona;
  }

  async deletePersona(id: string): Promise<void> {
    await this.api.deletePersona(id);
    this._personas.update(list => list.filter(p => p.id !== id));

    if (this._currentPersonaId() === id) {
      this.setCurrentPersona(null);
    }
  }

  getPersona(id: string | null | undefined): Persona | undefined {
    if (!id) return undefined;
    return this._personas().find(p => p.id === id);
  }

  // Call once (e.g. in constructor or a private init)
  private loadCurrentPersonaId() {
    try {
      const id = localStorage.getItem(this.CURRENT_PERSONA_KEY);
      if (id) {
        this._currentPersonaId.set(id);
      }
    } catch {
      // ignore
    }
  }

  setCurrentPersona(id: string | null): void {
    this._currentPersonaId.set(id);
    try {
      if (id) {
        localStorage.setItem(this.CURRENT_PERSONA_KEY, id);
      } else {
        localStorage.removeItem(this.CURRENT_PERSONA_KEY);
      }
    } catch {
      // ignore
    }
  }

  async loadTopics(): Promise<void> {
    this._topics.set(await this.api.getTopics());
  }

  async createTopic(data: CreateTopicRequest): Promise<Topic> {
    const topic = await this.api.createTopic(data);
    this._topics.update(list =>
      [...list, topic].sort((a, b) => a.name.localeCompare(b.name))
    );
    return topic;
  }

  async updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic> {
    const topic = await this.api.updateTopic(id, data);
    this._topics.update(list =>
      list
        .map(t => (t.id === id ? topic : t))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    return topic;
  }

  async deleteTopic(id: string): Promise<void> {
    await this.api.deleteTopic(id);
    this._topics.update(list => list.filter(t => t.id !== id));
  }

  /** Add a project to a topic */
  async addProjectToTopic(topicId: string, projectId: string): Promise<Topic> {
    const topic = await this.api.addProjectToTopic(topicId, projectId);
    this._topics.update(list =>
      list.map(t => (t.id === topicId ? topic : t))
    );
    return topic;
  }

  /** Remove a project from a topic */
  async removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic> {
    const topic = await this.api.removeProjectFromTopic(topicId, projectId);
    this._topics.update(list =>
      list.map(t => (t.id === topicId ? topic : t))
    );
    return topic;
  }

  getTopic(id: string | null | undefined): Topic | undefined {
    if (!id) return undefined;
    return this._topics().find(t => t.id === id);
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
    this._activeChildMap.update(m => ({ ...m, [key]: childId }));
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
    }
  }

  private ensuringDraft = false;

  isDraftQuestion(node: ChatNode): boolean {
    return node.type === 'question'
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
    this._nodes.update(list => list.map(n => (n.id === nodeId ? { ...n, ...node } : n)));
    return this._nodes().find(n => n.id === nodeId) ?? node;
  }

  /**
   * Guarantee the active path ends on an empty question the user can type into.
   * - empty chat → root draft question
   * - leaf answer with generated text and no child question → child draft
   */
  async ensureDraftAtLeaf(chatId: string): Promise<void> {
    if (!chatId || this.ensuringDraft || this.generatingNodeId()) return;

    let leaf = this.getActivePath().at(-1) ?? null;


    if (!leaf) {
      let nodes = await this.api.getNodes(chatId)
      const parentNodes = new Set(nodes.map(n => n.parentId));

      leaf = nodes.filter(n => parentNodes.has(n.id))
        .sort((a, b) => -a.createdAt.localeCompare(b.createdAt)).at(0) ?? null;
    }


    if (!leaf) {
      this.ensuringDraft = true;
      try {
        const draft = await this.addNode(chatId, {
          parentId: null,
          type: 'question',
          content: ''
        });
        this.setActiveChild(null, draft.id);
      } finally {
        this.ensuringDraft = false;
      }
      return;
    }

    if (leaf.type !== 'answer') return;
    if (!leaf.content?.trim()) return;

    const existing = this.getChildren(leaf.id).filter(n => n.type === 'question');
    if (existing.length > 0) {
      const draft = existing.find(n => this.isDraftQuestion(n)) ?? existing[0];
      this.setActiveChild(leaf.id, draft.id);
      return;
    }

    this.ensuringDraft = true;
    try {
      const draft = await this.addNode(chatId, {
        parentId: leaf.id,
        type: 'question',
        content: '',
        modelId: leaf.modelId || undefined,
        providerId: leaf.providerId || undefined
      });
      this.setActiveChild(leaf.id, draft.id);
    } finally {
      this.ensuringDraft = false;
    }
  }


}
