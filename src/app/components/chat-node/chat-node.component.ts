import {
  Component, inject, input, output, signal, effect,
  viewChild, ElementRef, afterNextRender
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { SettingsService } from '../../core/settings.service';
import {ChatNode, NodeAttachment, ChatMessage } from '../../models/chat';
import { MarkdownService} from '../../core/markdown.service';

@Component({
  selector: 'app-chat-node',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-node.component.html',
  styleUrl: './chat-node.component.css'
})
export class ChatNodeComponent {
  private readonly settings = inject(SettingsService);
  public readonly  markdownService = inject(MarkdownService);
  readonly chatService = inject(ChatService);

  /** The node this component renders */
  readonly node = input.required<ChatNode>();
// ---------- Attachment state for edit / branch ----------
  readonly editAttachments = signal<NodeAttachment[]>([]);
  readonly isEditorDragOver = signal(false);

  private readonly MAX_ATTACHMENT_BYTES = 4_000_000;

  /**
   * Currently active sibling id for this node's parent.
   * Used only for the branch switcher UI.
   */
  readonly activeChildId = input<string | null>(null);

  /** Emitted when the user switches to another sibling branch */
  readonly activate = output<string>();

  // ---- local UI state (owned by the node) ----
  readonly isContentEditing = signal(false);
  readonly contentDraft = signal('');

  readonly isBranching = signal(false);
  readonly branchContent = signal('');
  readonly branchModelId = signal('');

  readonly isLoading = signal(false);

  readonly enabledModels = this.settings.enabledModels;

  // ---- derived helpers for the branch switcher ----
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

  // ---- actions ----
// Reference to the editing textarea
  private readonly editArea = viewChild<ElementRef<HTMLTextAreaElement>>('editArea');

// Add this signal
  readonly showPreview = signal(false);

// Optional helper if you want to reset preview when closing

  /** Auto-resize the textarea to fit its content */
  resizeTextarea(): void {
    const textarea = this.editArea()?.nativeElement;
    if (!textarea) return;

    textarea.style.height = 'auto';

    const maxHeight = window.innerHeight * 0.80;   // 80 % of screen height
    const contentHeight = textarea.scrollHeight + 4;

    textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  }

  async saveInlineEdit(): Promise<void> {
    const node = this.node();
    const newContent = this.contentDraft().trim();
    const attachments = this.editAttachments();

    // nothing changed (text and attachments identical) → just close
    const attachmentsUnchanged =
      JSON.stringify(attachments) === JSON.stringify(node.attachments || []);

    if ((!newContent && attachments.length === 0) ||
      (newContent === node.content && attachmentsUnchanged)) {
      this.cancelInlineEdit();
      return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    this.isLoading.set(true);
    try {
      if (node.type === 'answer') {
        // create a new version of the answer, carrying the current attachments
        await this.chatService.editAnswer(
          chatId,
          node.id,
          newContent,
          attachments
        );
      } else {
        // Questions currently create a branch (safer than overwrite)
        await this.chatService.branchQuestion(
          chatId,
          node.id,
          newContent,
          node.modelId || undefined,
          node.providerId || undefined,
          attachments
        );
      }
      this.cancelInlineEdit();
    } catch (err: any) {
      console.error(err);
      alert('Save failed: ' + (err?.message || err));
    } finally {
      this.isLoading.set(false);
    }
  }

  private scheduleResize(): void {
    // Two animation frames = after Angular has rendered + browser has laid out
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.resizeTextarea());
    });
  }



  async submitBranch(): Promise<void> {
    const node = this.node();
    const content = this.branchContent().trim();
    const attachments = this.editAttachments();

    // allow send when there is text OR at least one attachment
    if (!content && attachments.length === 0) return;

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const modelId = this.branchModelId();
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
    try {
      // 1. Create the new branched question (with attachments)
      const newQuestion = await this.chatService.branchQuestion(
        chatId,
        node.id,
        content,
        model.modelId,
        model.providerId,
        attachments
      );

      // 2. Activate immediately (while this component is still alive)
      this.activate.emit(newQuestion.id);

      // 3. Close the editor UI early
      this.cancelBranch();

      // 4. Build context up to the parent, then add the new question
      //    with proper multimodal content (images → image_url parts)
      const contextMessages = this.buildContextMessagesUpTo(node.parentId);
      contextMessages.push({
        role: 'user',
        content: this.nodeToMessageContent(newQuestion)
      });

      // 5. Stream the answer
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
    }
  }

  async deleteNode(): Promise<void> {
    if (!confirm('Delete this question and all its answers/branches?')) return;

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    try {
      await this.chatService.deleteNode(chatId, this.node().id);
    } catch (err: any) {
      console.error(err);
      alert('Failed to delete: ' + (err?.message || err));
    }
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


  /**
   * Builds OpenAI-style messages from root down to the given parentId (inclusive).
   * Relies on ChatService.getPathToNode if available.
   */
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
    // Automatically re-render whenever the node content changes
    effect(() => {
      const content = this.node().content;
      this.updateRendered(content);
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

      // Reset the button text after 1.5 seconds
      clearTimeout(this.copyTimeout);
      this.copyTimeout = setTimeout(() => {
        this.copied.set(false);
      }, 1500);
    } catch (err) {
      console.error('Failed to copy:', err);

      // Fallback for older environments
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
      } catch (e) {
        alert('Copy failed');
      }
      document.body.removeChild(textarea);
    }
  }

  stopGeneration(): void {
    this.chatService.stopGeneration();
  }


  // ---------- Start edit / branch (seed attachments) ----------

  startInlineEdit() {
    const n = this.node();
    this.contentDraft.set(n.content || '');
    this.editAttachments.set([...(n.attachments || [])]); // copy
    this.isContentEditing.set(true);
    this.scheduleResize();
  }

  startBranch() {
    const n = this.node();
    this.branchContent.set(n.content || '');
    this.branchModelId.set(n.modelId || this.enabledModels()[0]?.modelId || '');
    this.editAttachments.set([...(n.attachments || [])]); // start with a copy
    this.isBranching.set(true);
    this.scheduleResize();
  }

  cancelInlineEdit() {
    this.isContentEditing.set(false);
    this.contentDraft.set('');
    this.editAttachments.set([]);
  }

  cancelBranch() {
    this.isBranching.set(false);
    this.branchContent.set('');
    this.editAttachments.set([]);
  }

  // ---------- Shared file helpers (same as in chat.component) ----------

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

  /**
   * Convert a single node into the content that goes into an OpenAI-style message.
   * - No attachments  → plain string
   * - With images     → array of {type:'text'} + {type:'image_url'} parts
   * - Other files     → listed in the text part
   */
  private nodeToMessageContent(
    node: ChatNode
  ): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
    const attachments = node.attachments || [];
    if (attachments.length === 0) {
      return node.content || '';
    }

    const images = attachments.filter(a => a.mimeType?.startsWith('image/'));
    const other  = attachments.filter(a => !a.mimeType?.startsWith('image/'));

    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    // text part (original content + list of non-image files)
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

    // image parts
    for (const img of images) {
      parts.push({
        type: 'image_url',
        image_url: { url: img.dataUrl }
      });
    }

    // if we only produced a single text part, keep the simple string form
    if (parts.length === 1 && parts[0].type === 'text') {
      return parts[0].text!;
    }
    return parts;
  }
}
