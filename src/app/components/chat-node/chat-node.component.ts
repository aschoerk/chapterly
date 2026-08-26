import {
  Component, inject, input, output, signal, effect,
  viewChild, ElementRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { SettingsService } from '../../core/settings.service';
import { ChatNode, NodeAttachment, ChatMessage } from '../../models/chat';
import { MarkdownService } from '../../core/markdown.service';

@Component({
  selector: 'app-chat-node',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-node.component.html',
  styleUrl: './chat-node.component.css'
})
export class ChatNodeComponent {
  private readonly settings = inject(SettingsService);
  public readonly markdownService = inject(MarkdownService);
  readonly chatService = inject(ChatService);

  readonly node = input.required<ChatNode>();
  readonly activeChildId = input<string | null>(null);
  readonly activate = output<string>();

  readonly editAttachments = signal<NodeAttachment[]>([]);
  readonly isEditorDragOver = signal(false);
  private readonly MAX_ATTACHMENT_BYTES = 4_000_000;

  readonly isEditing = signal(false);
  readonly contentDraft = signal('');
  readonly branchModelId = signal('');
  readonly isLoading = signal(false);
  readonly pendingAction = signal<'version' | 'branch' | 'send' | 'continue' | null>(null);
  readonly showPreview = signal(false);
  /** Set by Cancel so auto-open does not immediately re-enter edit. */
  readonly editDismissed = signal(false);
  readonly enabledModels = this.settings.enabledModels;

  private readonly editArea = viewChild<ElementRef<HTMLTextAreaElement>>('editArea');

  get siblings(): ChatNode[] {
    return this.chatService.getChildren(this.node().parentId);
  }

  get hasSiblings(): boolean {
    return this.siblings.length > 1;
  }

  get siblingIndex(): { current: number; total: number } {
    const list = this.siblings;
    if (list.length === 0) return { current: 0, total: 0 };

    const activeId = this.activeChildId() ?? list[0]?.id;
    const index = list.findIndex(s => s.id === activeId);
    return {
      current: (index >= 0 ? index : 0) + 1,
      total: list.length
    };
  }

  isDraftEmpty(): boolean {
    return !this.contentDraft().trim() && this.editAttachments().length === 0;
  }

  /** Question that has not produced an answer yet — the in-thread composer. */
  isUnsentQuestion(): boolean {
    const n = this.node();
    if (n.type !== 'question') return false;
    return !this.chatService.getChildren(n.id).some(child => child.type === 'answer');
  }

  /** Last node on the active path (no current children). */
  isLeafNode(): boolean {
    return this.chatService.getChildren(this.node().id).length === 0;
  }

  resizeTextarea(): void {
    const textarea = this.editArea()?.nativeElement;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = window.innerHeight * 0.55;
    textarea.style.height = `${Math.min(textarea.scrollHeight + 4, maxHeight)}px`;
  }

  private scheduleResize(): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.resizeTextarea();
        this.editArea()?.nativeElement?.focus();
      });
    });
  }

  onContentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, textarea, .chip, .file-link')) {
      return;
    }
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      return;
    }
    if (this.chatService.isGenerating(this.node().id)) {
      return;
    }
    this.startEdit();
  }

  startEdit(): void {
    if (this.isEditing()) return;
    const n = this.node();
    this.editDismissed.set(false);
    this.contentDraft.set(n.content || '');
    this.editAttachments.set([...(n.attachments || [])]);
    this.branchModelId.set(this.resolvePreferredModelId(n));
    this.pendingAction.set(null);
    this.isEditing.set(true);
    this.scheduleResize();
  }

  /**
   * Model shown in the question listbox:
   * 1. already-queried question → the LLM that produced its answer
   * 2. else project.defaultModelId, if the chat belongs to a project
   * 3. else defaultModelId of a topic that contains that project
   * 4. else first enabled model (last-resort fallback)
   */
  resolvePreferredModelId(node: ChatNode): string {
    const models = this.enabledModels();
    const match = (ref?: string | null) =>
      models.find(m => !!ref && (m.id === ref || m.modelId === ref));

    const queried = node.type === 'question' &&
      this.chatService.getChildren(node.id).some(c => c.type === 'answer');

    if (queried) {
      const fromQuestion = match(node.modelId);
      if (fromQuestion) return fromQuestion.modelId;

      const currentAnswer = this.chatService.getChildren(node.id)
          .find(c => c.type === 'answer' && c.isCurrent)
        ?? this.chatService.getChildren(node.id).find(c => c.type === 'answer');
      const fromAnswer = match(currentAnswer?.modelId);
      if (fromAnswer) return fromAnswer.modelId;
    }

    const chatId = node.chatId || this.chatService.currentChatId();
    const chat = this.chatService.chats().find(c => c.id === chatId);
    const project = this.chatService.getProject(chat?.projectId ?? null);

    const fromProject = match(project?.defaultModelId);
    if (fromProject) return fromProject.modelId;

    if (project) {
      const topics = this.chatService.topics().filter(t =>
        Array.isArray(t.projectIds) && t.projectIds.includes(project.id)
      );
      for (const topic of topics) {
        const fromTopic = match(topic.defaultModelId);
        if (fromTopic) return fromTopic.modelId;
      }
    }

    return models[0]?.modelId || '';
  }

  cancelEdit(): void {
    this.editDismissed.set(true);
    this.pendingAction.set(null);
    this.showPreview.set(false);
    this.isEditing.set(false);
    this.contentDraft.set('');
    this.editAttachments.set([]);
  }

  /**
   * OK — persist as a new version of this node. Does not call the LLM.
   * Answers use /edit-answer. Questions use /edit-question (see patches).
   */
  async saveAsVersion(): Promise<void> {
    const node = this.node();
    const newContent = this.contentDraft().trim();
    const attachments = this.editAttachments();

    const attachmentsUnchanged =
      JSON.stringify(attachments) === JSON.stringify(node.attachments || []);

    if ((!newContent && attachments.length === 0) ||
      (newContent === node.content && attachmentsUnchanged)) {
      this.cancelEdit();
      return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    this.isLoading.set(true);
    this.pendingAction.set('version');
    try {
      let saved: ChatNode;
      if (node.type === 'answer') {
        saved = await this.chatService.editAnswer(
          chatId,
          node.id,
          newContent,
          attachments
        );
      } else {
        saved = await this.chatService.editQuestion(
          chatId,
          node.id,
          newContent,
          attachments
        );
      }
      this.activate.emit(saved.id);
      this.cancelEdit();
    } catch (err: any) {
      console.error(err);
      alert('Save failed: ' + (err?.message || err));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  /**
   * Empty leaf question: put “continue” in the draft, pin the default LLM,
   * and send. Same path as Send, no extra branch.
   */
  async continueDraft(): Promise<void> {
    if (!this.isUnsentQuestion() || this.isLoading()) return;
    this.contentDraft.set('continue');
    this.editAttachments.set([]);
    this.branchModelId.set(this.resolvePreferredModelId(this.node()));
    this.pendingAction.set('continue');
    await this.sendDraft();
  }

  /**
   * Send an unsent question (the in-thread composer).
   * Writes the draft onto this same node, then streams the answer.
   */
  async sendDraft(): Promise<void> {
    const node = this.node();
    const content = this.contentDraft().trim();
    const attachments = this.editAttachments();
    if (!content && attachments.length === 0) return;

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const modelId = this.branchModelId() || this.resolvePreferredModelId(node);
    const model = this.enabledModels().find(
      m => m.modelId === modelId || m.id === modelId
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
    if (this.pendingAction() !== 'continue') {
      this.pendingAction.set('send');
    }
    try {
      const saved = await this.chatService.persistQuestion(
        chatId,
        node.id,
        content,
        attachments,
        model.modelId,
        model.providerId
      );

      this.activate.emit(saved.id);

      if (!node.parentId) {
        const firstLine = content
          ? content.split('\n')[0].trim().slice(0, 80)
          : (attachments[0]?.name ?? '');
        if (firstLine && this.chatService.chats().find(c => c.id === chatId)?.title === 'New Chat') {
          await this.chatService.updateChatTitle(chatId, firstLine);
        }
      }

      const contextMessages = this.buildContextMessagesUpTo(saved.parentId);
      contextMessages.push({
        role: 'user',
        content: this.nodeToMessageContent({ ...saved, content, attachments })
      });

      this.cancelEdit();

      await this.chatService.streamAnswer(
        chatId,
        saved.id,
        provider,
        model,
        contextMessages
      );
    } catch (err: any) {
      console.error(err);
      alert('Failed: ' + (err?.message || err));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  /**
   * Branch — create a new sibling question (a new leaf) and stream an answer.
   *
   * - From a question: sibling under the same parent.
   * - From an answer: new question whose parent is this answer
   *   (continues the thread from this point).
   */
  async saveAsBranchAndSend(): Promise<void> {
    const node = this.node();
    const content = this.contentDraft().trim();
    const attachments = this.editAttachments();
    if (!content && attachments.length === 0) return;

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const modelId = this.branchModelId() || this.resolvePreferredModelId(node);
    const model = this.enabledModels().find(
      m => m.modelId === modelId || m.id === modelId
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
    this.pendingAction.set('branch');
    try {
      let newQuestion: ChatNode;

      if (node.type === 'question') {
        newQuestion = await this.chatService.branchQuestion(
          chatId,
          node.id,
          content,
          model.modelId,
          model.providerId,
          attachments
        );
        this.activate.emit(newQuestion.id);
      } else {
        newQuestion = await this.chatService.addNode(chatId, {
          parentId: node.id,
          type: 'question',
          content,
          modelId: model.modelId,
          providerId: model.providerId,
          attachments
        });
        this.activate.emit(newQuestion.id);
      }

      const contextParentId = node.type === 'question' ? node.parentId : node.id;
      const contextMessages = this.buildContextMessagesUpTo(contextParentId);
      contextMessages.push({
        role: 'user',
        content: this.nodeToMessageContent(newQuestion)
      });

      this.cancelEdit();

      await this.chatService.streamAnswer(
        chatId,
        newQuestion.id,
        provider,
        model,
        contextMessages
      );
    } catch (err: any) {
      console.error(err);
      alert('Failed: ' + (err?.message || err));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  async deleteNode(): Promise<void> {
    const node = this.node();
    const subtree = this.collectSubtree(node.id);
    const nonTrivial = subtree.filter(n => !this.isTrivialNode(n));

    if (nonTrivial.length > 0) {
      const extra = subtree.length - 1;
      const msg = extra > 0
        ? `Delete this ${node.type} and its ${extra} descendant(s)? ${nonTrivial.length} node(s) have content.`
        : `Delete this ${node.type}? It has content.`;
      if (!confirm(msg)) return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const parentId = node.parentId;

    try {
      await this.chatService.deleteNode(chatId, node.id);

      const remaining = parentId
        ? this.chatService.getChildren(parentId)
        : this.chatService.getChildren(null);
      if (remaining.length > 0) {
        const newest = remaining.reduce((a, b) =>
          this.nodeTimestamp(a) >= this.nodeTimestamp(b) ? a : b
        );
        this.activate.emit(newest.id);
      }

      const ensure = (this.chatService as any).ensureDraftAtLeaf;
      if (typeof ensure === 'function') {
        await ensure.call(this.chatService, chatId);
      }
    } catch (err: any) {
      console.error(err);
      alert('Failed to delete: ' + (err?.message || err));
    }
  }

  private isTrivialNode(n: ChatNode): boolean {
    const emptyText = !n.content?.trim();
    const noFiles = !(n.attachments && n.attachments.length);
    return emptyText && noFiles;
  }

  private nodeTimestamp(n: ChatNode): number {
    const raw = n.updatedAt || n.createdAt || '';
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  }

  private collectSubtree(rootId: string): ChatNode[] {
    const all = this.chatService.nodes();
    const result: ChatNode[] = [];
    const walk = (id: string) => {
      const n = all.find(x => x.id === id);
      if (n) result.push(n);
      all.filter(x => x.parentId === id).forEach(child => walk(child.id));
    };
    walk(rootId);
    return result;
  }

  prevSibling(): void {
    const list = this.chatService.getSiblingsOf(this.node());
    if (list.length < 2) return;

    const activeId = this.activeChildId() ?? list[0].id;
    const index = list.findIndex(s => s.id === activeId);
    const prev = list[(index - 1 + list.length) % list.length];
    this.activate.emit(prev.id);
  }

  nextSibling(): void {
    const list = this.siblings;
    if (list.length < 2) return;

    const activeId = this.activeChildId() ?? list[0].id;
    const index = list.findIndex(s => s.id === activeId);
    const next = list[(index + 1) % list.length];
    this.activate.emit(next.id);
  }

  private buildContextMessagesUpTo(parentId: string | null): ChatMessage[] {
    if (!parentId) return [];

    if (typeof (this.chatService as any).getPathToNode === 'function') {
      const path: ChatNode[] = (this.chatService as any).getPathToNode(parentId);
      const messages: ChatMessage[] = [];

      for (const n of path) {
        if (n.type === 'question') {
          messages.push({
            role: 'user',
            content: this.nodeToMessageContent(n)
          });
        } else if (n.type === 'answer' && n.isCurrent) {
          messages.push({
            role: 'assistant',
            content: this.nodeToMessageContent(n)
          });
        }
      }
      return messages;
    }

    return [];
  }

  readonly renderedHtml = signal('');

  constructor() {
    effect(() => {
      const content = this.node().content;
      this.updateRendered(content);
    });

    // Leaf questions open ready to type / edit, unless the user just cancelled.
    effect(() => {
      const n = this.node();
      if (
        n.type === 'question' &&
        this.isLeafNode() &&
        !this.isEditing() &&
        !this.editDismissed() &&
        !this.chatService.isGenerating(n.id)
      ) {
        this.startEdit();
      }
    });
  }

  updateRendered(content: string): void {
    this.renderedHtml.set(this.markdownService.toHtml(content ?? ''));
  }

  readonly copied = signal(false);
  private copyTimeout: any = null;

  async copyContent(): Promise<void> {
    const content = this.node().content ?? '';

    try {
      await navigator.clipboard.writeText(content);
      this.copied.set(true);
      clearTimeout(this.copyTimeout);
      this.copyTimeout = setTimeout(() => this.copied.set(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        this.copied.set(true);
        clearTimeout(this.copyTimeout);
        this.copyTimeout = setTimeout(() => this.copied.set(false), 1500);
      } catch {
        alert('Copy failed');
      }
      document.body.removeChild(textarea);
    }
  }

  stopGeneration(): void {
    this.chatService.stopGeneration();
  }

  private readAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  private async filesToAttachments(files: FileList | File[]): Promise<NodeAttachment[]> {
    const result: NodeAttachment[] = [];
    for (const file of Array.from(files)) {
      if (file.size > this.MAX_ATTACHMENT_BYTES) {
        alert(`${file.name} is too large (max 4 MB)`);
        continue;
      }
      const dataUrl = await this.readAsDataURL(file);
      result.push({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        dataUrl
      });
    }
    return result;
  }

  async onEditorFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const added = await this.filesToAttachments(input.files);
    this.editAttachments.update(list => [...list, ...added]);
    input.value = '';
  }

  onEditorDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isEditorDragOver.set(true);
  }

  onEditorDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isEditorDragOver.set(false);
  }

  async onEditorDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isEditorDragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files?.length) {
      const added = await this.filesToAttachments(files);
      this.editAttachments.update(list => [...list, ...added]);
    }
  }

  removeEditAttachment(id: string) {
    this.editAttachments.update(list => list.filter(a => a.id !== id));
  }

  openImage(dataUrl: string) {
    window.open(dataUrl, '_blank');
  }

  private nodeToMessageContent(
    node: ChatNode
  ): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
    const attachments = node.attachments || [];
    if (attachments.length === 0) {
      return node.content || '';
    }

    const images = attachments.filter(a => a.mimeType?.startsWith('image/'));
    const other = attachments.filter(a => !a.mimeType?.startsWith('image/'));

    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    let text = node.content || '';
    if (other.length) {
      text +=
        (text ? '\n\n' : '') +
        '[Attached files]\n' +
        other.map(a => `- ${a.name} (${a.mimeType})`).join('\n');
    }
    if (text.trim()) {
      parts.push({ type: 'text', text });
    }

    for (const img of images) {
      parts.push({
        type: 'image_url',
        image_url: { url: img.dataUrl }
      });
    }

    if (parts.length === 1 && parts[0].type === 'text') {
      return parts[0].text!;
    }
    return parts;
  }
}
