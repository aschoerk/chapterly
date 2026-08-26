import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { LastModelService } from '../../core/last-model.service';
import { ChatNode, NodeAttachment, ChatMessage } from '../../models/chat';
import { SettingsService } from '../../core/settings.service';
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

  readonly chats = this.chatService.chats;
  readonly currentChatId = this.chatService.currentChatId;
  readonly nodes = this.chatService.currentNodes;

  /** parentId → active child nodeId  (shared tree navigation state) */
  readonly activeChild = signal<Record<string, string>>({});

  readonly newQuestion = signal('');
  readonly isLoading = signal(false);

  readonly enabledModels = this.settings.enabledModels;

  // ---------- Attachment state (composer) ----------
  readonly pendingAttachments = signal<NodeAttachment[]>([]);
  readonly isDragOver = signal(false);

  private readonly MAX_ATTACHMENT_BYTES = 4_000_000;

  async ngOnInit() {
    await this.chatService.loadChats();
    await this.settings.loadAll();
  }

  // ------------------------------------------------------------------
  // Root question (composer)
  // ------------------------------------------------------------------

  // ---------- Send root question (adapted) ----------

  async addRootQuestion() {
    const chatId = this.currentChatId();
    const content = this.newQuestion().trim();
    const attachments = this.pendingAttachments();
    const selectedId = this.lastModelService.selectedModelId();

    // allow send when there is text OR at least one attachment
    if (!chatId || (!content && attachments.length === 0) || !selectedId) return;

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
      // 1. Create the question node (now with attachments)
      const questionNode = await this.chatService.addNode(chatId, {
        parentId,
        type: 'question',
        content,
        modelId: model.modelId,
        providerId: model.providerId,
        attachments                                // ← new
      });

      // Auto-title for new chats (use text if present, otherwise first file name)
      if (parentId === null) {
        const firstLine = content
          ? content.split('\n')[0].trim().slice(0, 80)
          : (attachments[0]?.name ?? 'New chat');
        if (firstLine) {
          await this.chatService.updateChatTitle(chatId, firstLine);
        }
      }

      this.setActiveChild(parentId, questionNode.id);

      // clear composer
      this.newQuestion.set('');
      this.pendingAttachments.set([]);             // ← clear chips

      // 2. Build context (already includes the new question via the active path,
      //    or we push it explicitly with multimodal content)
      const contextMessages = this.buildContextMessages();

      // If buildContextMessages stops before the node we just created,
      // push it explicitly with proper multimodal content:
      contextMessages.push({
        role: 'user',
        content: this.nodeToMessageContent(questionNode)   // ← handles images
      });

      // 3. Stream the answer
      await this.chatService.streamAnswer(
        chatId,
        questionNode.id,
        provider,
        model,
        contextMessages
      );

      // Activate the latest answer
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


  getActiveChild(parentId: string | null): ChatNode | null {
    const siblings = this.getChildren(parentId);
    if (siblings.length === 0) return null;

    const activeId = this.getActiveChildId(parentId);
    const found = siblings.find(s => s.id === activeId);
    return found || siblings[0];
  }


  /** Deepest node in the currently active branch */
  getCurrentLeaf(): ChatNode | null {
    let current: ChatNode | null = this.getActiveChild(null);
    if (!current) return null;

    while (true) {
      const next = this.getActiveChild(current.id);
      if (!next) break;
      current = next;
    }
    return current;
  }

  scrollToNode(nodeId: string) {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  getSiblingIndex(node: ChatNode): number {
    const siblings = this.getChildren(node.parentId);
    const idx = siblings.findIndex(s => s.id === node.id);
    return idx >= 0 ? idx + 1 : 1;
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

  /**
   * Builds the OpenAI-style messages array for the current active branch,
   * up to (but not including) a new question we are about to add.
   */
  buildContextMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // Prepend project system prompt if present
    const chatId = this.currentChatId();
    if (chatId) {
      const chat = this.chats().find(c => c.id === chatId);
      if (chat?.projectId) {
        const project = this.chatService.getProject(chat.projectId);
        if (project?.systemPrompt?.trim()) {
          messages.push({ role: 'system', content: project.systemPrompt.trim() });
        }
      }
    }

    let current: ChatNode | null = this.getActiveChild(null);
    while (current) {
      if (current.type === 'question') {
        messages.push({
          role: 'user',
          content: this.nodeToMessageContent(current)
        });
      } else if (current.type === 'answer' && current.isCurrent) {
        messages.push({
          role: 'assistant',
          content: this.nodeToMessageContent(current)
        });
      }
      current = this.getActiveChild(current.id);
    }

    return messages;
  }
  // ---------- File helpers ----------

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

  async onComposerFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const added = await this.filesToAttachments(input.files);
    this.pendingAttachments.update(list => [...list, ...added]);
    input.value = '';
  }

  onComposerDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  onComposerDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  async onComposerDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files?.length) {
      const added = await this.filesToAttachments(files);
      this.pendingAttachments.update(list => [...list, ...added]);
    }
  }

  removePendingAttachment(id: string) {
    this.pendingAttachments.update(list => list.filter(a => a.id !== id));
  }


  // remove local activeChildMap / getActivePath / setActiveChild …

// just delegate
  getActivePath()          { return this.chatService.getActivePath(); }
  getActiveChildId(pid: string | null)    { return this.chatService.getActiveChildId(pid); }
  setActiveChild(pid: string | null, cid: string) { this.chatService.setActiveChild(pid, cid); }
  getChildren(pid: string | null)         { return this.chatService.getChildren(pid); }

  protected selectedModelId() {
    return this.lastModelService.selectedModelId;
  }

  protected setSelectedModelId($event: any) {
    this.lastModelService.setSelectedModel($event);
  }


  protected isNearViewport(id: string) {

  }
}
