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
import {ProjectService} from '../../core/project.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { LlmService } from '../../core/llm/llm.service';
import { GenerationSettingsService } from '../../core/generation-settings.service';
import { GenerationTaskKind } from '../../models/generation-task';
import { ModelEntry, ProviderConfig } from '../../models/chat-config';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatTitleEditorComponent, ChatNodeComponent, SideBarComponent, ChatParametersEditorComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent implements OnInit {
  readonly chatService = inject(ChatService);
  readonly i18n = inject(I18nService);
  readonly projectService = inject(ProjectService);
  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly parameters = inject(ChatParametersService);
  private readonly llmService = inject(LlmService);
  private readonly generation = inject(GenerationSettingsService);

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
  readonly isGeneratingStructure = signal(false);
  readonly pendingStructure = signal<string | null>(null);

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
    await this.projectService.loadTopics();
    await this.projectService.loadProjects();
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
    const project = chat?.projectId ? this.projectService.getProject(chat.projectId) : null;
    const topic = this.projectService.topicForProject(project?.id, this.projectService.topics()) ?? null;
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

  /** Generate a title for the whole story (context = all assistant nodes). */
  async generateTitle(): Promise<void> {
    await this.runStructureGeneration('title');
  }

  /** Generate a summary of the whole story (context = all assistant nodes). */
  async generateSummary(): Promise<void> {
    await this.runStructureGeneration('overview');
  }

  /** Shared generation for the chat-level Title / Summary buttons. */
  private async runStructureGeneration(task: GenerationTaskKind): Promise<void> {
    const chatId = this.currentChatId();
    if (!chatId || this.isGeneratingStructure()) return;

    const resolvedModel = this.resolveStructureModel(task);
    if (!resolvedModel) {
      alert(this.i18n.t('node.structureModelMissing'));
      return;
    }
    const { model, provider } = resolvedModel;

    this.isGeneratingStructure.set(true);
    this.pendingStructure.set(task);
    try {
      const resolved = await this.llmService.resolveForCurrentChat(model);
      const config = this.generation.get(task);
      const instruction = config.prompt.trim() || this.defaultStructurePrompt(task);

      // Whole-story context: the text of every current assistant node.
      const context = this.chatService.currentNodes()
        .filter(n => n.isCurrent && n.role === 'assistant' && n.content?.trim())
        .map(n => n.content)
        .join('\n\n');

      const result = await this.llmService.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        [{
          role: 'user',
          content: `${instruction}\n\nCurrent chat context:\n${context || '(empty chat)'}\n\nReturn only the resulting text.`
        }],
        resolved.stream,
        undefined,
        undefined,
        this.llmService.toLlmExtras(resolved),
        model.providerId
      );
      const content = result.content.trim();
      if (!content) throw new Error(this.i18n.t('node.structureEmpty'));

      if (task === 'title') {
        // The title wraps the whole story: insert at root above the first node.
        const first = this.chatService.getActiveChild(null);
        const created = await this.addStructureNode(chatId, null, content, model);
        if (first) {
          await this.chatService.reparentNodes(chatId, [first.id], created.id);
          this.chatService.setActiveChild(null, created.id);
          this.chatService.setActiveChild(created.id, first.id);
        } else {
          this.chatService.setActiveChild(null, created.id);
        }
        // The generated title also becomes the chat/story title.
        await this.chatService.updateChatTitle(chatId, content);
      } else {
        // The summary lands at the end of the active path.
        const path = this.chatService.getActivePath();
        const parentId = path[path.length - 1]?.id ?? null;
        const created = await this.addStructureNode(chatId, parentId, content, model);
        this.chatService.setActiveChild(parentId, created.id);
      }
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      this.isGeneratingStructure.set(false);
      this.pendingStructure.set(null);
    }
  }

  /** Generate a heading for EVERY assistant node on the active path. */
  async generateHeadings(): Promise<void> {
    const chatId = this.currentChatId();
    if (!chatId || this.isGeneratingStructure()) return;

    const resolvedModel = this.resolveStructureModel('headings');
    if (!resolvedModel) {
      alert(this.i18n.t('node.structureModelMissing'));
      return;
    }
    const { model, provider } = resolvedModel;

    this.isGeneratingStructure.set(true);
    this.pendingStructure.set('headings');
    try {
      const resolved = await this.llmService.resolveForCurrentChat(model);
      const config = this.generation.get('headings');
      const instruction = config.prompt.trim() || this.defaultStructurePrompt('headings');

      // The active path is the linear reading order of the story.
      const assistants = this.chatService.getActivePath()
        .filter(n => n.role === 'assistant' && n.content?.trim());

      const nodeById = new Map(this.chatService.currentNodes().map(n => [n.id, n]));
      const previous: { node: ChatNode; heading: ChatNode }[] = [];
      for (const assistant of assistants) {
        // A chapter counts as headed when its parent is a structural node.
        // Already-headed chapters are kept in the context but not regenerated.
        const parent = assistant.parentId ? nodeById.get(assistant.parentId) : undefined;
        if (parent?.role === 'structural') {
          previous.push({ node: assistant, heading: parent });
          continue;
        }

        // Context = earlier chapters (incl. their generated headings) + the current one.
        const blocks: string[] = previous.map(({ node, heading }) =>
          `Chapter — heading: "${heading.content}"\n\nContent:\n${node.content}`);
        blocks.push(`Chapter — heading: (to be created)\n\nContent:\n${assistant.content}`);

        const result = await this.llmService.askLlm(
          provider.baseUrl,
          provider.apiKey,
          model.modelId,
          [{
            role: 'user',
            content: `${instruction}\n\nThe following chapters are listed in story order. Every chapter already has a heading EXCEPT the LAST one.\nGenerate the heading for the LAST chapter only; use the earlier chapters to match the style.\n\n${blocks.join('\n\n')}\n\nReturn only the heading text.`
          }],
          resolved.stream,
          undefined,
          undefined,
          this.llmService.toLlmExtras(resolved),
          model.providerId
        );
        const headingContent = result.content.trim();
        if (!headingContent) throw new Error(this.i18n.t('node.structureEmpty'));

        // Wrap this chapter under a new structural heading (same parent as the answer).
        const heading = await this.chatService.addNode(chatId, {
          parentId: assistant.parentId,
          role: 'structural',
          content: headingContent,
          modelId: model.modelId,
          providerId: model.providerId,
          chatParametersId: this.chatService.chats().find(c => c.id === chatId)?.chatParametersId
            || model.chatParametersId
            || undefined
        });
        await this.chatService.reparentNodes(chatId, [assistant.id], heading.id);
        this.chatService.setActiveChild(assistant.parentId, heading.id);
        this.chatService.setActiveChild(heading.id, assistant.id);

        previous.push({ node: assistant, heading });
      }
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      this.isGeneratingStructure.set(false);
      this.pendingStructure.set(null);
    }
  }

  /** Resolve the model+provider for an authoring task, or null if unset/unknown. */
  private resolveStructureModel(task: GenerationTaskKind): { model: ModelEntry; provider: ProviderConfig } | null {
    const configuredModel = this.generation.modelFor(task);
    const model = configuredModel
      ?? this.enabledModels().find(m =>
        m.modelId === this.lastModelService.selectedModelId() ||
        m.id === this.lastModelService.selectedModelId())
      ?? this.enabledModels()[0];
    if (!model) return null;
    const provider = this.settings.providers().find(p => p.id === model.providerId);
    return provider ? { model, provider } : null;
  }

  private async addStructureNode(chatId: string, parentId: string | null, content: string, model: ModelEntry): Promise<ChatNode> {
    return this.chatService.addNode(chatId, {
      parentId,
      role: 'structural',
      content,
      modelId: model.modelId,
      providerId: model.providerId,
      chatParametersId: this.chatService.chats().find(c => c.id === chatId)?.chatParametersId
        || model.chatParametersId
        || undefined
    });
  }

  private defaultStructurePrompt(task: GenerationTaskKind): string {
    if (task === 'title') return 'Generate a concise title for this story.';
    return 'Generate a concise overview of this story so far.';
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
