import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { Chat, ChatNode } from '../../models/chat';
import { SettingsService } from '../../core/settings.service';
import { Router } from '@angular/router';
import { ChatTitleEditorComponent } from '../../components/chat-title-editor/chat-title-editor.component';
import { ChatNodeComponent } from '../../components/chat-node/chat-node.component';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatTitleEditorComponent, ChatNodeComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);
  private readonly LAST_MODEL_KEY = 'chat.lastUsedModelId';

  readonly chats = this.chatService.chats;
  readonly currentChatId = this.chatService.currentChatId;
  readonly nodes = this.chatService.currentNodes;

  /** parentId → active child nodeId  (shared tree navigation state) */
  readonly activeChild = signal<Record<string, string>>({});

  readonly newQuestion = signal('');
  readonly selectedModelId = signal<string>('');
  readonly isLoading = signal(false);
  readonly lastUsedModelId = signal<string>('');

  readonly enabledModels = this.settings.enabledModels;

  async ngOnInit() {
    this.loadLastUsedModel();
    await this.chatService.loadChats();
    await this.settings.loadAll();
  }

  async createChat() {
    const chat = await this.chatService.createChat();
    await this.chatService.selectChat(chat.id);

    if (this.lastUsedModelId()) {
      this.selectedModelId.set(this.lastUsedModelId());
    } else {
      this.selectedModelId.set('');
    }
  }

  async selectChat(chat: Chat) {
    await this.chatService.selectChat(chat.id);
    this.setLastUsedModel();
  }

  async deleteChat(chat: Chat, event: Event) {
    event.stopPropagation();
    if (confirm(`Delete chat "${chat.title}"?`)) {
      await this.chatService.deleteChat(chat.id);
    }
  }

  async goToConfig() {
    await this.router.navigate(['/config']);
  }

  // ------------------------------------------------------------------
  // Root question (composer)
  // ------------------------------------------------------------------

  async addRootQuestion() {
    const chatId = this.currentChatId();
    const content = this.newQuestion().trim();
    const selectedId = this.selectedModelId();

    if (!chatId || !content || !selectedId) return;

    const model = this.enabledModels().find(
      m => m.id === selectedId || m.modelId === selectedId
    );

    if (!model) {
      alert('Selected model not found');
      return;
    }

    this.saveLastUsedModel(model.id);
    this.selectedModelId.set(model.id);

    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      alert('Provider not found');
      return;
    }

    const leaf = this.getCurrentLeaf();
    const parentId = leaf ? leaf.id : null;

    this.isLoading.set(true);

    try {
      const questionNode = await this.chatService.addNode(chatId, {
        parentId: parentId,
        type: 'question',
        content,
        modelId: model.modelId,
        providerId: model.providerId
      });

      if (parentId === null) {
        const firstLine = content.split('\n')[0].trim().slice(0, 80);
        if (firstLine) {
          await this.chatService.updateChatTitle(chatId, firstLine);
        }
      }

      this.setActiveChild(parentId, questionNode.id);
      this.newQuestion.set('');

      const contextMessages = this.buildContextMessages();
      contextMessages.push({ role: 'user', content });

      const answerText = await this.chatService.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        contextMessages
      );

      const answerNode = await this.chatService.addNode(chatId, {
        parentId: questionNode.id,
        type: 'answer',
        content: answerText,
        modelId: model.modelId,
        providerId: model.providerId
      });

      this.setActiveChild(questionNode.id, answerNode.id);
    } catch (err: any) {
      console.error(err);
      alert('Failed to get answer: ' + (err?.message || err));
    } finally {
      this.isLoading.set(false);
    }
  }

  // ------------------------------------------------------------------
  // Active path / branch navigation (only remaining shared state)
  // ------------------------------------------------------------------

  /** Linear list of nodes from root to the current leaf (active branch only) */
  getActivePath(): ChatNode[] {
    const path: ChatNode[] = [];
    let current = this.getActiveSibling(null);

    while (current) {
      path.push(current);
      current = this.getActiveSibling(current.id);
    }

    return path;
  }

  getChildren(parentId: string | null): ChatNode[] {
    return this.chatService.getChildren(parentId);
  }

  getSiblings(parentId: string | null): ChatNode[] {
    return this.getChildren(parentId);
  }

  getActiveSibling(parentId: string | null): ChatNode | null {
    const siblings = this.getSiblings(parentId);
    if (siblings.length === 0) return null;

    const activeId = this.getActiveChildId(parentId);
    const found = siblings.find(s => s.id === activeId);
    return found || siblings[0];
  }

  getActiveChildId(parentId: string | null): string | null {
    const key = parentId ?? 'root';
    return this.activeChild()[key] || null;
  }

  setActiveChild(parentId: string | null, childId: string) {
    const key = parentId ?? 'root';
    this.activeChild.update(map => ({ ...map, [key]: childId }));
  }

  /** Deepest node in the currently active branch */
  getCurrentLeaf(): ChatNode | null {
    let current: ChatNode | null = this.getActiveSibling(null);
    if (!current) return null;

    while (true) {
      const next = this.getActiveSibling(current.id);
      if (!next) break;
      current = next;
    }
    return current;
  }

  /**
   * Builds the OpenAI-style messages array for the current active branch,
   * up to (but not including) a new question we are about to add.
   */
  buildContextMessages(): { role: 'user' | 'assistant'; content: string }[] {
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];
    let current: ChatNode | null = this.getActiveSibling(null);

    while (current) {
      if (current.type === 'question') {
        messages.push({ role: 'user', content: current.content });
      } else if (current.type === 'answer' && current.isCurrent) {
        messages.push({ role: 'assistant', content: current.content });
      }
      current = this.getActiveSibling(current.id);
    }
    return messages;
  }

  // ------------------------------------------------------------------
  // Last-used model persistence
  // ------------------------------------------------------------------

  private setLastUsedModel() {
    const nodes = this.nodes();
    const lastQuestion = [...nodes]
      .filter(n => n.type === 'question' && n.modelId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    if (!lastQuestion?.modelId) return;

    const model = this.enabledModels().find(
      m => m.modelId === lastQuestion.modelId || m.id === lastQuestion.modelId
    );

    const id = model ? model.id : lastQuestion.modelId;
    this.selectedModelId.set(id);
    this.saveLastUsedModel(id);
  }

  private loadLastUsedModel() {
    const saved = localStorage.getItem(this.LAST_MODEL_KEY);
    if (saved) {
      this.lastUsedModelId.set(saved);
    }
  }

  private saveLastUsedModel(modelId: string) {
    this.lastUsedModelId.set(modelId);
    localStorage.setItem(this.LAST_MODEL_KEY, modelId);
  }
}
