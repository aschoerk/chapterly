import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Chat, ChatNode, CreateNodeRequest, Project, Persona } from '../models/chat';
import { getServerConfig } from './server-config';

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private readonly http = inject(HttpClient);
  private readonly config = getServerConfig();

  private readonly _chats = signal<Chat[]>([]);
  private readonly _nodes = signal<ChatNode[]>([]);
  private readonly _projects = signal<Project[]>([]);
  private readonly _personas = signal<Persona[]>([]);
  private readonly _currentChatId = signal<string | null>(null);

  readonly chats = computed(() => this._chats());
  readonly nodes = computed(() => this._nodes());
  readonly currentChatId = computed(() => this._currentChatId());
  readonly projects = computed(() => this._projects());
  readonly personas = computed(() => this._personas());
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
    const projects = await firstValueFrom(
      this.http.get<Project[]>(`${this.config.apiBase}/projects`)
    );
    this._projects.set(projects);
  }

  async createProject(data: {
    name: string;
    systemPrompt?: string;
    defaultModelId?: string | null;
  }): Promise<Project> {
    const project = await firstValueFrom(
      this.http.post<Project>(`${this.config.apiBase}/projects`, data)
    );
    this._projects.update(list =>
      [...list, project].sort((a, b) => a.name.localeCompare(b.name))
    );
    return project;
  }

  async updateProject(
    id: string,
    data: Partial<{
      name: string;
      systemPrompt: string;
      defaultModelId: string | null;
    }>
  ): Promise<Project> {
    const project = await firstValueFrom(
      this.http.put<Project>(`${this.config.apiBase}/projects/${id}`, data)
    );
    this._projects.update(list =>
      list
        .map(p => (p.id === id ? project : p))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    return project;
  }

  async deleteProject(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.config.apiBase}/projects/${id}`)
    );
    this._projects.update(list => list.filter(p => p.id !== id));

    // Locally clear projectId from chats that belonged to it
    // (server already sets project_id = NULL via ON DELETE SET NULL)
    this._chats.update(list =>
      list.map(c => (c.projectId === id ? { ...c, projectId: null } : c))
    );
  }

  getProject(id: string | null | undefined): Project | undefined {
    if (!id) return undefined;
    return this._projects().find(p => p.id === id);
  }

  // ---------- Chats ----------

  async loadChats(): Promise<void> {
    const chats = await firstValueFrom(
      this.http.get<Chat[]>(`${this.config.apiBase}/chats`)
    );
    this._chats.set(chats);
  }

  async createChat(title = 'New Chat', projectId: string | null = null): Promise<Chat> {
    const chat = await firstValueFrom(
      this.http.post<Chat>(`${this.config.apiBase}/chats`, { title, projectId })
    );
    this._chats.update(list => [chat, ...list]);
    return chat;
  }

  async deleteChat(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.config.apiBase}/chats/${id}`)
    );
    this._chats.update(list => list.filter(c => c.id !== id));

    if (this._currentChatId() === id) {
      this._currentChatId.set(null);
      this._nodes.set([]);
    }
  }

  async selectChat(chatId: string): Promise<void> {
    this._currentChatId.set(chatId);
    await this.loadNodes(chatId);
  }

  // ---------- Nodes ----------

  async loadNodes(chatId: string): Promise<void> {
    const nodes = await firstValueFrom(
      this.http.get<ChatNode[]>(`${this.config.apiBase}/chats/${chatId}/nodes`)
    );
    this._nodes.set(nodes);
  }

  async addNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    const node = await firstValueFrom(
      this.http.post<ChatNode>(`${this.config.apiBase}/chats/${chatId}/nodes`, data)
    );
    this._nodes.update(list => [...list, node]);
    return node;
  }

  /** Create a new version of an answer */
  async editAnswer(chatId: string, nodeId: string, content: string): Promise<ChatNode> {
    const node = await firstValueFrom(
      this.http.post<ChatNode>(
        `${this.config.apiBase}/chats/${chatId}/nodes/${nodeId}/edit-answer`,
        { content }
      )
    );

    // Mark old version as not current locally and add the new one
    this._nodes.update(list => {
      const updated = list.map(n =>
        n.id === nodeId ? { ...n, isCurrent: false } : n
      );
      return [...updated, node];
    });

    return node;
  }

  /** Edit a question → creates a new branch */
  async branchQuestion(
    chatId: string,
    nodeId: string,
    content: string,
    modelId?: string,
    providerId?: string
  ): Promise<ChatNode> {
    const node = await firstValueFrom(
      this.http.post<ChatNode>(
        `${this.config.apiBase}/chats/${chatId}/nodes/${nodeId}/branch-question`,
        { content, modelId, providerId }
      )
    );
    this._nodes.update(list => [...list, node]);
    return node;
  }

  // ---------- Helpers for the tree ----------

  /** Returns the children of a node */
  getChildren(nodeId: string | null): ChatNode[] {
    return this.currentNodes()
      .filter(n => n.parentId === nodeId && (n.type === 'question' || n.isCurrent))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Returns the full path from root to a given node (only current answers) */
  getPathToNode(nodeId: string): ChatNode[] {
    const nodes = this.currentNodes();
    const map = new Map(nodes.map(n => [n.id, n]));
    const path: ChatNode[] = [];

    let current = map.get(nodeId);
    while (current) {
      path.unshift(current);
      current = current.parentId ? map.get(current.parentId) : undefined;
    }

    return path;
  }

  async askLlm(
    providerBaseUrl: string,
    apiKey: string,
    modelId: string,
    messages: { role: string; content: string }[],
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
    messages: { role: string; content: string }[],
    onChunk?: (chunk: string) => void
  ): Promise<ChatNode> {

    // 1. Create empty answer node
    const answerNode = await this.addNode(chatId, {
      parentId: questionNodeId,
      type: 'answer',
      content: '',
      modelId: model.modelId,
      providerId: model.providerId
    });

    // 2. Start generation tracking (for Stop button + thinking indicator)
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
        await this.editAnswer(chatId, answerNode.id, accumulated);
      }

      return answerNode;
    } finally {
      this.stopGeneration();
    }
  }

  async deleteNode(chatId: string, nodeId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.config.apiBase}/chats/${chatId}/nodes/${nodeId}`)
    );

    // Remove the node and all its descendants from the local state
    this._nodes.update(list => {
      const toDelete = new Set<string>();

      const collect = (id: string) => {
        toDelete.add(id);
        list.filter(n => n.parentId === id).forEach(child => collect(child.id));
      };

      collect(nodeId);
      return list.filter(n => !toDelete.has(n.id));
    });
  }

  async updateChatTitle(id: string, title: string): Promise<void> {
    const updated = await firstValueFrom(
      this.http.patch<Chat>(`${this.config.apiBase}/chats/${id}`, { title })
    );

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
    const personas = await firstValueFrom(
      this.http.get<Persona[]>(`${this.config.apiBase}/personas`)
    );
    this._personas.set(personas);
  }

  async createPersona(data: {
    name: string;
    shortName: string;
    description?: string;
    avatar?: string;
  }): Promise<Persona> {
    const persona = await firstValueFrom(
      this.http.post<Persona>(`${this.config.apiBase}/personas`, data)
    );
    this._personas.update(list =>
      [...list, persona].sort((a, b) => a.name.localeCompare(b.name))
    );
    return persona;
  }

  async updatePersona(
    id: string,
    data: Partial<{
      name: string;
      shortName: string;
      description: string;
      avatar: string;
    }>
  ): Promise<Persona> {
    const persona = await firstValueFrom(
      this.http.put<Persona>(`${this.config.apiBase}/personas/${id}`, data)
    );
    this._personas.update(list =>
      list
        .map(p => (p.id === id ? persona : p))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    return persona;
  }

  async deletePersona(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.config.apiBase}/personas/${id}`)
    );
    this._personas.update(list => list.filter(p => p.id !== id));
  }

  getPersona(id: string | null | undefined): Persona | undefined {
    if (!id) return undefined;
    return this._personas().find(p => p.id === id);
  }
}
