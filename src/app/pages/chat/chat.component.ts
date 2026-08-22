import {Component, computed, inject, OnInit, signal} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { Chat, ChatNode } from '../../models/chat';
import { SettingsService } from '../../core/settings.service';
import { Router } from '@angular/router';
import { ChatTitleEditorComponent } from '../../components/chat-title-editor/chat-title-editor.component';

// inside the class:

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatTitleEditorComponent],
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
  /** parentId → active child nodeId */
  readonly activeChild = signal<Record<string, string>>({});

  readonly newQuestion = signal('');
  readonly selectedModelId = signal<string>('');
  readonly isLoading = signal(false);

  // Enabled models for the dropdown
  readonly enabledModels = this.settings.enabledModels;
  readonly editingNodeId = signal<string | null>(null);
  readonly editingContent = signal('');
  readonly editingMode = signal<'edit' | 'branch' | null>(null);
  readonly editingModelId = signal<string>('');
  readonly lastUsedModelId = signal<string>('');
  readonly editingContentNodeId = signal<string | null>(null);
  readonly contentDraft = signal('');

  // Branch edit (Edit branch button)
  readonly branchingNodeId = signal<string | null>(null);
  readonly branchContent = signal('');
  readonly branchModelId = signal('');

  async ngOnInit() {
    this.loadLastUsedModel();
    await this.chatService.loadChats();
    await this.settings.loadAll(); // make sure models are loaded
  }

  async createChat() {
    const chat = await this.chatService.createChat();
    await this.chatService.selectChat(chat.id);

    // Restore the globally last used model
    if (this.lastUsedModelId()) {
      this.selectedModelId.set(this.lastUsedModelId());
    } else {
      this.selectedModelId.set('');
    }
  }

  async selectChat(chat: Chat) {
    await this.chatService.selectChat(chat.id);
    this.setLastUsedModel();   // model from this chat + update global lastUsedModelId
  }

  async deleteChat(chat: Chat, event: Event) {
    event.stopPropagation();
    if (confirm(`Delete chat "${chat.title}"?`)) {
      await this.chatService.deleteChat(chat.id);
    }
  }

  /** Returns children of a node (only current answers + questions) */
  getChildren(parentId: string | null): ChatNode[] {
    return this.chatService.getChildren(parentId);
  }

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

    // inside addRootQuestion(), after the question was created successfully:
    if (model) {
      this.saveLastUsedModel(model.id);
      this.selectedModelId.set(model.id);
    }

    // We need the full provider (for baseUrl + apiKey)
    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      alert('Provider not found');
      return;
    }

    // Continue from the current leaf (or start at root if the chat is empty)
    const leaf = this.getCurrentLeaf();
    const parentId = leaf ? leaf.id : null;

    this.isLoading.set(true);

    try {
      // 1. Create the question node
      const questionNode = await this.chatService.addNode(chatId, {
        parentId: parentId,
        type: 'question',
        content,
        modelId: model.modelId,
        providerId: model.providerId
      });

      // Inside addRootQuestion, after the questionNode was created:
      if (parentId === null) {
        // This is the first question of the chat → use first line as title
        const firstLine = content.split('\n')[0].trim().slice(0, 80);
        if (firstLine) {
          await this.chatService.updateChatTitle(chatId, firstLine);
        }
      }

      // Make sure the new question becomes the active child of its parent
      this.setActiveChild(parentId, questionNode.id);

      this.newQuestion.set('');
      this.saveLastUsedModel(model.id);

      // Build the previous context of the current branch
      const contextMessages = this.buildContextMessages();

      // Add the new question
      contextMessages.push({ role: 'user', content });

      // Call the LLM with the full context
      const answerText = await this.chatService.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        contextMessages
      );

      // 3. Create the answer as child of the new question
      const answerNode = await this.chatService.addNode(chatId, {
        parentId: questionNode.id,
        type: 'answer',
        content: answerText,
        modelId: model.modelId,
        providerId: model.providerId
      });

      // Activate the new answer
      this.setActiveChild(questionNode.id, answerNode.id);

    } catch (err: any) {
      console.error(err);
      alert('Failed to get answer: ' + (err?.message || err));
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Returns the linear list of nodes from root to the current leaf (active branch only) */
  getActivePath(): ChatNode[] {
    const path: ChatNode[] = [];
    let current = this.getActiveSibling(null);

    while (current) {
      path.push(current);
      current = this.getActiveSibling(current.id);
    }

    return path;
  }

  async submitEditedQuestion() {
    const nodeId = this.editingNodeId();
    const content = this.editingContent().trim();
    const mode = this.editingMode();
    const chatId = this.currentChatId();

    if (!nodeId || !content || !mode || !chatId) return;

    const originalNode = this.nodes().find(n => n.id === nodeId);
    if (!originalNode) return;

    const model = this.enabledModels().find(
      m => m.modelId === this.editingModelId() || m.id === this.editingModelId()
    );

    if (!model) {
      alert('Selected model not found');
      return;
    }

    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      alert('Provider not found');
      return;
    }

    this.isLoading.set(true);

    try {
      // 1. Create the new branched question
      const newQuestion = await this.chatService.branchQuestion(
        chatId,
        nodeId,
        content,
        model.modelId,
        model.providerId
      );

      // Activate the new branch
      this.setActiveChild(originalNode.parentId, newQuestion.id);
      this.saveLastUsedModel(model.id);

      // 2. Build context:
      //    Path from root up to the *parent* of the original question,
      //    then add the new question content.
      const contextMessages = this.buildContextMessagesUpTo(originalNode.parentId);
      contextMessages.push({ role: 'user', content });

      // 3. Call the LLM
      const answerText = await this.chatService.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        contextMessages
      );

      // 4. Create the answer under the new question
      const answerNode = await this.chatService.addNode(chatId, {
        parentId: newQuestion.id,
        type: 'answer',
        content: answerText,
        modelId: model.modelId,
        providerId: model.providerId
      });

      this.setActiveChild(newQuestion.id, answerNode.id);
      this.cancelEditing();

    } catch (err: any) {
      console.error(err);
      alert('Failed: ' + (err?.message || err));
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Builds messages from the root down to the given parentId (inclusive).
   * If parentId is null, returns an empty context (starting a new root branch).
   */
  buildContextMessagesUpTo(parentId: string | null): { role: 'user' | 'assistant'; content: string }[] {
    if (!parentId) return [];

    const path = this.chatService.getPathToNode(parentId);
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];

    for (const node of path) {
      if (node.type === 'question') {
        messages.push({ role: 'user', content: node.content });
      } else if (node.type === 'answer' && node.isCurrent) {
        messages.push({ role: 'assistant', content: node.content });
      }
    }

    return messages;
  }

  async goToConfig() {
    await this.router.navigate(['/config']);
  }

  async editAnswer(node: ChatNode) {
    const newContent = prompt('Edit answer:', node.content);
    if (newContent === null || newContent.trim() === node.content) return;

    const chatId = this.currentChatId();
    if (!chatId) return;

    await this.chatService.editAnswer(chatId, node.id, newContent.trim());
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

  async editQuestion(node: ChatNode) {
    // Simple overwrite for now (or you can decide to always branch)
    const newContent = prompt('Edit question:', node.content);
    if (newContent === null || newContent.trim() === node.content) return;

    // For a true "edit" you may want a dedicated backend endpoint.
    // For now we can reuse branch as a safe behavior, or implement a real update later.
    alert('Simple overwrite of questions is not yet implemented. Use "Edit branch" for now.');
  }

  async branchQuestion(node: ChatNode) {
    const newContent = prompt('New branched question:', node.content);
    if (newContent === null || !newContent.trim()) return;

    const chatId = this.currentChatId();
    if (!chatId) return;

    await this.chatService.branchQuestion(
      chatId,
      node.id,
      newContent.trim(),
      node.modelId || undefined,
      node.providerId || undefined
    );
  }

  async deleteNode(node: ChatNode) {
    if (!confirm('Delete this question and all its answers/branches?')) return;

    const chatId = this.currentChatId();
    if (!chatId) return;

    try {
      await this.chatService.deleteNode(chatId, node.id);
    } catch (err: any) {
      console.error(err);
      alert('Failed to delete: ' + (err?.message || err));
    }
  }

  startEditQuestion(node: ChatNode) {
    this.editingNodeId.set(node.id);
    this.editingContent.set(node.content);
    this.editingModelId.set(node.modelId || '');
    this.editingMode.set('edit');
  }

  cancelEditing() {
    this.editingNodeId.set(null);
    this.editingContent.set('');
    this.editingMode.set(null);
  }

  private setLastUsedModel() {
    const nodes = this.nodes();

    // Find the most recent question that has a model.loadAll();Id
    const lastQuestion = [...nodes]
      .filter(n => n.type === 'question' && n.modelId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    if (!lastQuestion?.modelId) {
      return;
    }

    // Try to find the matching enabled model
    const model = this.enabledModels().find(
      m => m.modelId === lastQuestion.modelId || m.id === lastQuestion.modelId
    );

    const id = model ? model.id : lastQuestion.modelId;
    this.selectedModelId.set(id);
    this.saveLastUsedModel(id);   // remember it globally
  }

  getSiblings(parentId: string | null): ChatNode[] {
    return this.getChildren(parentId); // already returns current children
  }

  getActiveSibling(parentId: string | null): ChatNode | null {
    const siblings = this.getSiblings(parentId);
    if (siblings.length === 0) return null;

    const activeId = this.getActiveChildId(parentId);
    const found = siblings.find(s => s.id === activeId);
    return found || siblings[0];
  }

  getSiblingIndex(parentId: string | null): { current: number; total: number } {
    const siblings = this.getSiblings(parentId);
    if (siblings.length === 0) return { current: 0, total: 0 };

    const active = this.getActiveSibling(parentId);
    const index = siblings.findIndex(s => s.id === active?.id);
    return {
      current: index + 1,
      total: siblings.length
    };
  }

  prevSibling(parentId: string | null) {
    const siblings = this.getSiblings(parentId);
    if (siblings.length < 2) return;

    const active = this.getActiveSibling(parentId);
    const index = siblings.findIndex(s => s.id === active?.id);
    const prev = siblings[(index - 1 + siblings.length) % siblings.length];
    this.setActiveChild(parentId, prev.id);
  }

  nextSibling(parentId: string | null) {
    const siblings = this.getSiblings(parentId);
    if (siblings.length < 2) return;

    const active = this.getActiveSibling(parentId);
    const index = siblings.findIndex(s => s.id === active?.id);
    const next = siblings[(index + 1) % siblings.length];
    this.setActiveChild(parentId, next.id);
  }

  /** Returns the deepest node in the currently active branch */
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

  setActiveChild(parentId: string | null, childId: string) {
    const key = parentId ?? 'root';
    this.activeChild.update(map => ({ ...map, [key]: childId }));
  }

  getActiveChildId(parentId: string | null): string | null {
    const key = parentId ?? 'root';
    return this.activeChild()[key] || null;
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

  // ----- Simple Edit -----
  startInlineEdit(node: ChatNode) {
    this.editingContentNodeId.set(node.id);
    this.contentDraft.set(node.content);
    this.branchingNodeId.set(null); // close the other editor
  }

  cancelInlineEdit() {
    this.editingContentNodeId.set(null);
    this.contentDraft.set('');
  }

// ----- Edit branch -----
  startBranchQuestion(node: ChatNode) {
    this.branchingNodeId.set(node.id);
    this.branchContent.set(node.content);
    this.branchModelId.set(node.modelId || '');
    this.editingContentNodeId.set(null); // close the other editor
  }

  cancelBranch() {
    this.branchingNodeId.set(null);
    this.branchContent.set('');
  }

  async submitBranch() {
    // Re-use the logic you already have in submitEditedQuestion,
    // but reading from branchingNodeId / branchContent / branchModelId
    // ...
  }

  async saveInlineEdit(node: ChatNode) {
    const newContent = this.contentDraft().trim();
    if (!newContent || newContent === node.content) {
      this.cancelInlineEdit();
      return;
    }

    const chatId = this.currentChatId();
    if (!chatId) return;

    try {
      if (node.type === 'answer') {
        await this.chatService.editAnswer(chatId, node.id, newContent);
      } else {
        // For questions we currently branch (safer).
        // True overwrite can be added later if you want.
        await this.chatService.branchQuestion(
          chatId,
          node.id,
          newContent,
          node.modelId || undefined,
          node.providerId || undefined
        );
      }
      this.cancelInlineEdit();
    } catch (err: any) {
      alert('Save failed: ' + (err?.message || err));
    }
  }

}
