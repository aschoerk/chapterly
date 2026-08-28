import {Component, effect, ElementRef, viewChild, inject, OnInit, signal, HostListener} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { LastModelService } from '../../core/last-model.service';
import { ChatNode, NodeAttachment, ChatMessage } from '../../models/chat';
import { SettingsService } from '../../core/settings.service';
import { ChatTitleEditorComponent } from '../../components/chat-title-editor/chat-title-editor.component';
import { ChatNodeComponent } from '../../components/chat-node/chat-node.component';
import {SideBarComponent} from '../../components/side-bar/side-bar.component';
import {Router} from '@angular/router';

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

  private readonly tree = viewChild<ElementRef<HTMLElement>>('tree');

  /** Node whose block sits nearest the top of .tree */
  readonly visibleNodeId = signal<string | null>(null);

  private readonly router = inject(Router);

  openReader() {
    void this.router.navigate(['/read']);
  }

  async ngOnInit() {
    await this.chatService.loadChats();
    await this.settings.loadAll();
  }

  constructor() {
    console.log('ChatComponent constructed', Date.now());
    effect(() => {
      const chatId = this.currentChatId();
      const generating = this.chatService.generatingNodeId();
      // re-run when the tree or the active path changes
      this.chatService.currentNodes();
      this.chatService.getActivePath();
      if (!chatId || generating) return;
      queueMicrotask(() => {
        void this.chatService.ensureDraftAtLeaf(chatId);
      });
    });
    effect(() => {
      this.currentChatId();
      this.chatService.currentNodes();
      this.getActivePath();
      queueMicrotask(() => this.syncVisibleNode());
    });
  }

  onTreeScroll(): void {
    this.syncVisibleNode();
  }

  protected isNearViewport(id: string): boolean {
    return this.visibleNodeId() === id;
  }

  private syncVisibleNode(): void {
    const root = this.tree()?.nativeElement;
    if (!root) {
      this.visibleNodeId.set(null);
      return;
    }

    const top = root.getBoundingClientRect().top;
    let bestId: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const node of this.getActivePath()) {
      const el = root.querySelector(`[data-node-id="${node.id}"]`) as HTMLElement | null;
      if (!el) continue;
      const dist = Math.abs(el.getBoundingClientRect().top - top);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = node.id;
      }
    }

    this.visibleNodeId.set(bestId);
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

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent) {
    if (this.isTyping(event)) return;
    if (event.key === 'b' || event.key === 'B') {
      if (!this.currentChatId()) return;
      event.preventDefault();
      this.openReader();
    }
  }

  private isTyping(event: KeyboardEvent): boolean {
    const t = event.target as HTMLElement | null;
    return !!t && (
      t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable
    );
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

}
