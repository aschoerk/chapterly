import {Component, effect, ElementRef, viewChild, inject, OnInit, signal, HostListener} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { LastModelService } from '../../core/last-model.service';
import { Chat, ChatNode, NodeAttachment, ChatMessage } from '../../models/chat';
import { SettingsService } from '../../core/settings.service';
import { ChatParametersService } from '../../core/chat-parameters.service';
import { ChatParametersEditorComponent } from '../../components/chat-parameters-editor/chat-parameters-editor.component';
import { ChatParametersDraft, ResolvedChatParameters, draftFromParameters, emptyParametersDraft, formatParametersSummary } from '../../models/chat-parameters';
import { ChatTitleEditorComponent } from '../../components/chat-title-editor/chat-title-editor.component';
import { ChatNodeComponent } from '../../components/chat-node/chat-node.component';
import {SideBarComponent} from '../../components/side-bar/side-bar.component';
import {Router} from '@angular/router';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatTitleEditorComponent, ChatNodeComponent, SideBarComponent, ChatParametersEditorComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent implements OnInit {
  readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly parameters = inject(ChatParametersService);

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
  private static readonly LS_SIDEBAR_WIDTH = 'chat-client.sidebar.width';
  private static readonly SIDEBAR_WIDTH_DEFAULT = 290;
  private static readonly SIDEBAR_WIDTH_MIN = 200;
  private static readonly SIDEBAR_WIDTH_MAX = 720;

  readonly sidebarWidth = signal(this.loadSidebarWidth());
  readonly isResizing = signal(false);
  readonly showChatParams = signal(false);
  readonly chatParamsOverride = signal(false);
  readonly chatParamsDraft = signal<ChatParametersDraft>(emptyParametersDraft());
  readonly chatParamsInherited = signal<ResolvedChatParameters | null>(null);
  readonly chatParamsSummary = signal('defaults');

  private resizeStartX = 0;
  private resizeStartWidth = 0;

  private readonly onResizePointerMove = (event: PointerEvent) => {
    if (!this.isResizing()) return;
    event.preventDefault();
    const delta = event.clientX - this.resizeStartX;
    const max = Math.min(
      ChatComponent.SIDEBAR_WIDTH_MAX,
      Math.round(window.innerWidth * 0.6)
    );
    const next = Math.round(
      Math.min(Math.max(this.resizeStartWidth + delta, ChatComponent.SIDEBAR_WIDTH_MIN), max)
    );
    this.sidebarWidth.set(next);
  };

  private readonly onResizePointerUp = () => this.endSidebarResize();

  private loadSidebarWidth(): number {
    const n = Number(localStorage.getItem('chat-client.sidebar.width'));
    if (!Number.isFinite(n)) return 290;
    return Math.min(720, Math.max(200, n));
  }

  startSidebarResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    this.isResizing.set(true);
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.sidebarWidth();

    document.body.classList.add('sidebar-resizing');
    document.addEventListener('pointermove', this.onResizePointerMove);
    document.addEventListener('pointerup', this.onResizePointerUp);
    document.addEventListener('pointercancel', this.onResizePointerUp);
  }

  endSidebarResize() {
    if (!this.isResizing()) return;
    this.isResizing.set(false);
    document.body.classList.remove('sidebar-resizing');
    document.removeEventListener('pointermove', this.onResizePointerMove);
    document.removeEventListener('pointerup', this.onResizePointerUp);
    document.removeEventListener('pointercancel', this.onResizePointerUp);
    localStorage.setItem('chat-client.sidebar.width', String(this.sidebarWidth()));
  }

  resetSidebarWidth() {
    this.sidebarWidth.set(290);
    localStorage.setItem('chat-client.sidebar.width', '290');
  }

  ngOnDestroy() {
    this.endSidebarResize();
  }


  openReader() {
    void this.router.navigate(['/read']);
  }

  async ngOnInit() {
    await this.chatService.loadChats();
    await this.chatService.loadTopics();
    await this.chatService.loadProjects();
    await this.settings.loadAll();
    await this.refreshChatParams();
  }

  constructor() {
    console.log('ChatComponent constructed', Date.now());
    effect(() => {
      const chatId = this.currentChatId();
      const generating = this.chatService.generatingNodeId();
      this.chatService.currentNodes();
      this.chatService.getActivePath();
      if (!chatId || generating) return;
      queueMicrotask(async () => {
        await this.chatService.ensureDraftAtLeaf(chatId);
        this.restoreOpenedChatPosition(chatId);
        this.syncVisibleNode();
      });
    });
  }

  private positionedChatId: string | null = null;

  onTreeScroll(): void {
    this.syncVisibleNode();
    const tree = this.tree()?.nativeElement;
    const chatId = this.currentChatId();
    if (tree && chatId && this.positionedChatId === chatId) {
      this.chatService.saveScroll(chatId, tree.scrollTop);
    }
  }

  private restoreOpenedChatPosition(chatId: string | null): void {
    if (!chatId) {
      this.positionedChatId = null;
      return;
    }
    if (this.positionedChatId === chatId) return;

    const tree = this.tree()?.nativeElement;
    const path = this.getActivePath();
    if (!tree || path.length === 0) return;

    this.positionedChatId = chatId;

    if (this.chatService.alwaysOpenAtLeaf()) {
      const leaf = this.getCurrentLeaf();
      if (leaf) {
        const el = tree.querySelector(`[data-node-id="${leaf.id}"]`) as HTMLElement | null;
        el?.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      return;
    }

    const saved = this.chatService.getSavedScroll(chatId);
    tree.scrollTop = saved ?? 0;
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


  currentChat(): Chat | undefined {
    const id = this.currentChatId();
    return this.chats().find(c => c.id === id);
  }

  async toggleChatParams() {
    const open = !this.showChatParams();
    this.showChatParams.set(open);
    if (open) await this.refreshChatParams();
  }

  async refreshChatParams() {
    const chat = this.currentChat();
    const project = chat?.projectId ? this.chatService.getProject(chat.projectId) : null;
    const topic = this.parameters.topicForProject(project?.id, this.chatService.topics()) ?? null;
    const model = this.settings.models().find(m => m.id === this.lastModelService.selectedModelId())
      || this.settings.enabledModels()[0]
      || null;
    await this.parameters.loadMany([
      chat?.chatParametersId,
      project?.chatParametersId,
      topic?.chatParametersId,
      model?.chatParametersId
    ]);
    const inherited = this.parameters.resolveForChat({ model, topic, project, chat: null });
    this.chatParamsInherited.set(inherited);
    const own = chat?.chatParametersId ? await this.parameters.get(chat.chatParametersId) : null;
    this.chatParamsOverride.set(!!own);
    this.chatParamsDraft.set(draftFromParameters(own));
    const effective = this.parameters.resolveForChat({ model, topic, project, chat: chat ?? null });
    const src = effective.source === 'default' ? 'defaults' : effective.source;
    this.chatParamsSummary.set(`${formatParametersSummary(effective)} (${src})`);
  }

  onChatParamsChanged(event: { override: boolean; draft: ChatParametersDraft }) {
    this.chatParamsOverride.set(event.override);
    this.chatParamsDraft.set(event.draft);
  }

  async saveChatParams() {
    const chat = this.currentChat();
    if (!chat) return;
    const chatParametersId = await this.parameters.persistDraft(
      chat.chatParametersId,
      this.chatParamsOverride(),
      this.chatParamsDraft()
    );
    await this.chatService.reassignChatParams(chat.id, chatParametersId);
    this.showChatParams.set(false);
    await this.refreshChatParams();
  }
}
