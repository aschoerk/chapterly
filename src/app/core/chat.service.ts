import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Chat, ChatNode, CreateNodeRequest } from '../models/chat';
import { getServerConfig } from './server-config';

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private readonly http = inject(HttpClient);
  private readonly config = getServerConfig();

  private readonly _chats = signal<Chat[]>([]);
  private readonly _nodes = signal<ChatNode[]>([]);
  private readonly _currentChatId = signal<string | null>(null);

  readonly chats = computed(() => this._chats());
  readonly nodes = computed(() => this._nodes());
  readonly currentChatId = computed(() => this._currentChatId());

  /** All nodes of the currently selected chat as a flat list */
  readonly currentNodes = computed(() => {
    const chatId = this._currentChatId();
    if (!chatId) return [];
    return this._nodes().filter(n => n.chatId === chatId);
  });

  // ---------- Chats ----------

  async loadChats(): Promise<void> {
    const chats = await firstValueFrom(
      this.http.get<Chat[]>(`${this.config.apiBase}/chats`)
    );
    this._chats.set(chats);
  }

  async createChat(title = 'New Chat'): Promise<Chat> {
    const chat = await firstValueFrom(
      this.http.post<Chat>(`${this.config.apiBase}/chats`, { title })
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
    messages: { role: string; content: string }[]
  ): Promise<string> {
    const config = getServerConfig();

    const response: any = await firstValueFrom(
      this.http.post(`${config.proxyBase}/chat/completions`, {
        model: modelId,
        messages,
        temperature: 0.7
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'x-target-base': providerBaseUrl,
          'HTTP-Referer': 'https://chat-client.local',
          'X-Title': 'Chat Client'
        }
      })
    );

    return response?.choices?.[0]?.message?.content?.trim() || '(no response)';
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
}
