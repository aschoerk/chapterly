import {
  Component, inject, input, output, signal, effect,
  viewChild, ElementRef, Provider, computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { SettingsService } from '../../core/settings.service';
import { ChatNode, NodeAttachment, ChatMessage } from '../../models/chat';
import { MarkdownService } from '../../core/markdown.service';
import {ModelEntry} from '../../models/chat-config';
import {NodeEditSession} from '../../core/node-edit-session';
import {ConfirmDialogComponent} from '../confirm-dialog/confirm-dialog.component';
import {ConfirmService} from '../../core/confirm.service';
import {LlmService} from '../../core/llm.service';
import { ChatParametersService } from '../../core/chat-parameters.service';
import { inferMimeType, nodeToMessageContent } from '../../core/llm-message';
import { formatParametersSummary } from '../../models/chat-parameters';
import {ProjectService} from '../../core/project.service';

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
  readonly projectService = inject(ProjectService);
  readonly llmService = inject(LlmService);
  private readonly parameters = inject(ChatParametersService);

  private readonly confirm = inject(ConfirmService);

  readonly node = input.required<ChatNode>();
  readonly activeChildId = input<string | null>(null);
  readonly activate = output<string>();

  readonly editAttachments = signal<NodeAttachment[]>([]);
  readonly isEditorDragOver = signal(false);
  private readonly MAX_ATTACHMENT_BYTES = 4_000_000;

  readonly contentDraft = signal('');
  readonly branchModelId = signal('');
  readonly isLoading = signal(false);
  readonly pendingAction = signal<'version' | 'branch' | 'send' | 'continue' | null>(null);
  readonly showPreview = signal(false);
  /** Set by Cancel so auto-open does not immediately re-enter edit. */
  readonly editDismissed = signal(false);
  readonly enabledModels = this.settings.enabledModels;
  private readonly editSession = inject(NodeEditSession);
  readonly thinkingClosed = signal(true);

  private readonly editArea = viewChild<ElementRef<HTMLTextAreaElement>>('editArea');
  private readonly streamEnd = viewChild<ElementRef<HTMLElement>>('streamEnd');

  readonly isEditing = computed(() =>
    this.editSession.editingNodeId() === this.node().id
  );

  hasThinking(): boolean {
    return !!this.node().thinking?.trim();
  }

  isThinkingLive(): boolean {
    const n = this.node();
    return n.role === 'assistant' && this.chatService.isGenerating(n.id);
  }

  get siblings(): ChatNode[] {
    return this.chatService.getSiblingsOf(this.node());
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
    if (n.role !== 'user') return false;
    return !this.chatService.getChildren(n.id).some(child => child.role === 'assistant');
  }

  isQuestion(): boolean {
    const n = this.node();
    return n.role === 'user';
  }

  /** Last node on the active path (no current children). */
  isLeafNode(): boolean {
    return this.chatService.getChildren(this.node().id).length === 0;
  }

  /** Empty unsent leaf question with the inline editor closed. */
  showClosedContinue(): boolean {
    const n = this.node();
    return this.isUnsentQuestion()
      && this.isLeafNode()
      && !this.isEditing()
      && !n.content?.trim()
      && !(n.attachments?.length);
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

  async startEdit(source: 'user' | 'auto' = 'user'): Promise<void> {
    if (this.isEditing()) return;
    const n = this.node();
    const ok = await this.editSession.begin({
      chatId: n.chatId,
      nodeId: n.id,
      text: n.content || '',
      attachments: n.attachments || []
    }, source);

    if (!ok) return;

    this.editDismissed.set(false);
    this.contentDraft.set(n.content || '');
    this.editAttachments.set([...(n.attachments || [])]);
    this.branchModelId.set(n.modelId || this.resolvePreferredModelId(n));
    this.pendingAction.set(null);
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

    const queried = node.role === 'user' &&
      this.chatService.getChildren(node.id).some(c => c.role === 'assistant');

    if (queried) {
      const fromUser = match(node.modelId);
      if (fromUser) return fromUser.modelId;

      const currentAssistant = this.chatService.getChildren(node.id)
          .find(c => c.role === 'assistant' && c.isCurrent)
        ?? this.chatService.getChildren(node.id).find(c => c.role === 'assistant');
      const fromAnswer = match(currentAssistant?.modelId);
      if (fromAnswer) return fromAnswer.modelId;
    }

    const chatId = node.chatId || this.chatService.currentChatId();
    const chat = this.chatService.chats().find(c => c.id === chatId);
    const project = this.projectService.getProject(chat?.projectId ?? null);

    const fromProject = match(project?.defaultModelId);
    if (fromProject) return fromProject.modelId;

    if (project) {
      const topics = this.projectService.topics().filter(t =>
        Array.isArray(t.projectIds) && t.projectIds.includes(project.id)
      );
      for (const topic of topics) {
        const fromTopic = match(topic.defaultModelId);
        if (fromTopic) return fromTopic.modelId;
      }
    }

    return models[0]?.modelId || '';
  }

  async cancelEdit(): Promise<void> {
    if (
      this.editSession.editingNodeId() === this.node().id &&
      this.editSession.isDirty()
    ) {
      const discard = await this.confirm.ask({
        title: 'Discard edits?',
        message: 'Close this editor without saving?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true
      });
      if (!discard) return;
    }
    this.editDismissed.set(true);
    this.pendingAction.set(null);
    this.showPreview.set(false);
    this.contentDraft.set('');
    this.editAttachments.set([]);
    this.editSession.abandon(this.node().id);
  }

  private closeEditor(): void {
    const id = this.node().id;
    this.pendingAction.set(null);
    this.showPreview.set(false);
    this.contentDraft.set('');
    this.editAttachments.set([]);
    this.editSession.commit(id); // state → null; isEditing follows editingNodeId
  }


  /**
   * OK — persist as a new version of this node. Does not call the LLM.
   * Answers use /edit-assistant. Questions use /edit-question (see patches).
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
      if (node.role === 'assistant' || node.role === 'system') {
        saved = await this.chatService.editAssistant(
          chatId,
          node.id,
          newContent,
          attachments
        );
      } else {
        saved = await this.chatService.editUser(
          chatId,
          node.id,
          newContent,
          attachments
        );
      }
      this.activate.emit(saved.id);
      this.closeEditor();
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
    this.branchModelId.set(this.node().modelId || this.resolvePreferredModelId(this.node()));
    this.pendingAction.set('continue');
    await this.sendDraft();
    await this.cancelEdit();
  }

  onDraftText(text: string): void {
    this.contentDraft.set(text);
    this.editSession.patch(this.node().id, text, this.editAttachments());
  }

  private syncAttachments(): void {
    this.editSession.patch(this.node().id, this.contentDraft(), this.editAttachments());
  }


  private async resolveSendTarget(): Promise<{
    node: ChatNode;
    content: string;
    attachments: NodeAttachment[];
    chatId: string;
    model: ModelEntry;
    provider: { baseUrl: string; apiKey: string };
  } | null> {
    const node = this.node();
    const content = this.contentDraft().trim();
    const attachments = this.editAttachments();
    if (!content && attachments.length === 0) return null;

    const chatId = this.chatService.currentChatId();
    if (!chatId) return null;

    const modelId = this.branchModelId() || this.resolvePreferredModelId(node);
    const model = this.enabledModels().find(
      m => m.modelId === modelId || m.id === modelId
    );
    if (!model) {
      alert('Selected model not found');
      return null;
    }

    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      alert('Provider not found');
      return null;
    }

    return { node, content, attachments, chatId, model, provider };
  }

  private async runSend(
    pending: 'send' | 'branch' | 'continue',
    work: () => Promise<void>
  ): Promise<void> {
    if (pending !== 'continue' || this.pendingAction() !== 'continue') {
      this.pendingAction.set(pending);
    }
    this.isLoading.set(true);
    try {
      await work();
    } catch (err: any) {
      console.error(err);
      alert('Failed: ' + (err?.message || err));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  private async streamForQuestion(
    chatId: string,
    question: ChatNode,
    contextParentId: string | null,
    provider: { baseUrl: string; apiKey: string },
    model: ModelEntry,
    extra?: { content?: string; attachments?: NodeAttachment[] }
  ): Promise<void> {
    const contextMessages = this.buildContextMessagesUpTo(contextParentId);
    contextMessages.push({
      role: 'user',
      content: nodeToMessageContent(
        extra ? { ...question, content: extra.content ?? question.content, attachments: extra.attachments ?? question.attachments } : question
      )
    });
    this.closeEditor();
    await this.llmService.streamAnswer(chatId, question.id, provider, model, contextMessages);
  }

  /**
   * Send an unsent question (the in-thread composer).
   * Writes the draft onto this same node, then streams the answer.
   */
  async sendDraft(): Promise<void> {
    const target = await this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, chatId, model, provider } = target;

    await this.runSend(this.pendingAction() === 'continue' ? 'continue' : 'send', async () => {
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

      await this.streamForQuestion(chatId, saved, saved.parentId, provider, model, {
        content,
        attachments
      });
    });
  }

  /**
   * Branch — create a new sibling question (a new leaf) and stream an answer.
   *
   * - From a question: sibling under the same parent.
   * - From an answer: new question whose parent is this answer
   *   (continues the thread from this point).
   */
  async saveAsBranchAndSend(): Promise<void> {
    const target = await this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, chatId, model, provider } = target;

    await this.runSend('branch', async () => {
      const newQuestion =
        node.role === 'user'
          ? await this.chatService.branchQuestion(
            chatId,
            node.id,
            content,
            model.modelId,
            model.providerId,
            attachments
          )
          : await this.chatService.addNode(chatId, {
            parentId: node.id,
            role: 'user',
            content,
            modelId: model.modelId,
            providerId: model.providerId,
            attachments
          });

      this.activate.emit(newQuestion.id);

      const contextParentId = node.role === 'user' ? node.parentId : node.id;
      await this.streamForQuestion(chatId, newQuestion, contextParentId, provider, model, {
        content,
        attachments
      });
    });
  }

  /**
   * Delete this assistant answer and its subtree, then resend the parent
   * user request. Confirms first when the answer already has children.
   */
  async regenerateAnswer(): Promise<void> {
    const node = this.node();
    if (node.role !== 'assistant' || this.isLoading() || this.chatService.isGenerating(node.id)) {
      return;
    }

    const children = this.chatService.getChildren(node.id);
    if (children.length > 0) {
      const extra = this.collectSubtree(node.id).length - 1;
      const ok = await this.confirm.ask({
        title: 'Regenerate answer?',
        message: extra > 0
          ? `This answer has ${extra} descendant node(s). Regenerating deletes them and sends the last user request again.`
          : 'This answer has child nodes. Regenerating deletes them and sends the last user request again.',
        confirmLabel: 'Regenerate',
        cancelLabel: 'Cancel',
        danger: true
      });
      if (!ok) return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const question = node.parentId
      ? this.chatService.nodes().find(n => n.id === node.parentId)
      : undefined;
    if (!question || question.role !== 'user') {
      alert('Cannot regenerate: parent question not found');
      return;
    }

    const modelId = node.modelId || question.modelId || this.resolvePreferredModelId(question);
    const model = this.enabledModels().find(m => m.modelId === modelId || m.id === modelId);
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
    this.pendingAction.set('send');
    try {
      await this.chatService.deleteNode(chatId, node.id);
      this.activate.emit(question.id);
      await this.streamForQuestion(chatId, question, question.parentId, provider, model);
    } catch (err: any) {
      console.error(err);
      alert('Regenerate failed: ' + (err?.message || err));
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
        ? `Delete this ${node.role}node and its ${extra} descendant(s)? ${nonTrivial.length} node(s) have content.`
        : `Delete this ${node.role}node? It has content.`;
      if (!confirm(msg)) return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const parentId = node.parentId;

    try {
      await this.chatService.deleteNode(chatId, node.id);

      const remaining = parentId
        ? this.chatService.getChildren(parentId)
        : [];
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
        messages.push({
          role: n.role,
          content: nodeToMessageContent(n)
        });
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

    effect(() => {
      const n = this.node();
      if (!this.chatService.isGenerating(n.id)) return;
      if (this.chatService.followThinking() && n.thinking?.trim()) {
        this.thinkingClosed.set(false);
      }
      if (this.chatService.followStreaming() || (this.chatService.followThinking() && !n.content?.trim())) {
        queueMicrotask(() => this.followLive());
      }
    });
  }

  private followLive(): void {
    const anchor = this.streamEnd()?.nativeElement;
    if (!anchor) return;
    const tree = anchor.closest('.tree') as HTMLElement | null;
    if (!tree) {
      anchor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    const a = anchor.getBoundingClientRect();
    const t = tree.getBoundingClientRect();
    if (a.bottom > t.bottom - 12 || a.top < t.top + 12) {
      anchor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
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
        mimeType: inferMimeType(file.name, file.type),
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
    this.syncAttachments();
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
      this.syncAttachments();
    }
  }

  removeEditAttachment(id: string) {
    this.editAttachments.update(list => list.filter(a => a.id !== id));
    this.syncAttachments();
  }

  openImage(dataUrl: string) {
    window.open(dataUrl, '_blank');
  }

  hasUnsavedChanges(): boolean {
    const n = this.node();
    const attachmentsUnchanged =
      JSON.stringify(this.editAttachments()) === JSON.stringify(n.attachments || []);
    return this.contentDraft() !== (n.content || '') || !attachmentsUnchanged;
  }


  parametersFootnote(): string | null {
    if (this.node().role !== 'assistant') return null;
    const id = this.node().chatParametersId;
    const own = this.parameters.peek(id);
    if (own) return formatParametersSummary(own);
    const model = this.enabledModels().find(m => m.modelId === this.node().modelId || m.id === this.node().modelId);
    if (model?.chatParametersId) {
      const fromModel = this.parameters.peek(model.chatParametersId);
      if (fromModel) return formatParametersSummary(fromModel);
    }
    return null;
  }
}
