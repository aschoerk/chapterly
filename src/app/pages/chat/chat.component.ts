import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { LastModelService } from '../../core/last-model.service';
import { Chat, ChatNode } from '../../models/chat';
import { SettingsService } from '../../core/settings.service';
import { Router } from '@angular/router';
import { ChatTitleEditorComponent } from '../../components/chat-title-editor/chat-title-editor.component';
import { ChatNodeComponent } from '../../components/chat-node/chat-node.component';
import {SideBarComponent} from '../../components/side-bar/side-bar.component';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatTitleEditorComponent, ChatNodeComponent, SideBarComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly router = inject(Router);

  readonly chats = this.chatService.chats;
  readonly currentChatId = this.chatService.currentChatId;
  readonly nodes = this.chatService.currentNodes;

  /** parentId → active child nodeId  (shared tree navigation state) */
  readonly activeChild = signal<Record<string, string>>({});

  readonly newQuestion = signal('');
  readonly isLoading = signal(false);

  readonly enabledModels = this.settings.enabledModels;

  async ngOnInit() {
    await this.chatService.loadChats();
    await this.settings.loadAll();
  }

  // ------------------------------------------------------------------
  // Root question (composer)
  // ------------------------------------------------------------------

  async addRootQuestion() {
    const chatId = this.currentChatId();
    const content = this.newQuestion().trim();
    const selectedId = this.lastModelService.selectedModelId();
    if (!chatId || !content || !selectedId) return;

    const model = this.enabledModels().find(
      m => m.id === selectedId || m.modelId === selectedId
    );
    if (!model) {
      alert('Selected model not found');
      return;
    }

    this.lastModelService.saveLastUsedModel(model.id);
    this.lastModelService.setSelectedModel(model.id);

    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      alert('Provider not found');
      return;
    }

    const leaf = this.getCurrentLeaf();
    const parentId = leaf ? leaf.id : null;
    this.isLoading.set(true);

    try {
      // 1. Create the question node
      const questionNode = await this.chatService.addNode(chatId, {
        parentId,
        type: 'question',
        content,
        modelId: model.modelId,
        providerId: model.providerId
      });

      // Auto-title for new chats
      if (parentId === null) {
        const firstLine = content.split('\n')[0].trim().slice(0, 80);
        if (firstLine) {
          await this.chatService.updateChatTitle(chatId, firstLine);
        }
      }

      this.setActiveChild(parentId, questionNode.id);
      this.newQuestion.set('');

      // 2. Make the new answer the active child (so it appears in the path)
      //    The actual answer node is created inside streamAnswer
      //    We need its id → so we temporarily set it after creation.
      //    For simplicity we can let streamAnswer return the answer node id as well,
      //    or just rely on the path updating via the nodes signal.

      // Build context
      const contextMessages = this.buildContextMessages();
      contextMessages.push({ role: 'user', content });

      // 3. Shared streaming logic
      await this.chatService.streamAnswer(
        chatId,
        questionNode.id,
        provider,
        model,
        contextMessages
      );

      // After streaming we can set the active child to the latest answer
      // (optional – depends on how getActivePath works)
      const answers = this.chatService.getChildren(questionNode.id);
      if (answers.length > 0) {
        this.setActiveChild(questionNode.id, answers[answers.length - 1].id);
      }

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


  protected selectedModelId() {
    return this.lastModelService.selectedModelId;
  }

  protected setSelectedModelId($event: any) {
    this.lastModelService.setSelectedModel($event);
  }
}
