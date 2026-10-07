import {Component, computed, effect, ElementRef, viewChild, inject, OnInit, signal, HostListener} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { LastModelService } from '../../core/last-model.service';
import { Chat, ChatNode, NodeAttachment } from '../../models/chat';
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
import { GenerationSettingsService } from '../../core/generation-settings.service';
import { PromptDefaultsService } from '../../core/prompt-defaults.service';
import { GenerationTaskKind } from '../../models/generation-task';
import { ModelEntry, ProviderConfig } from '../../models/chat-config';
import { ConfirmService } from '../../core/confirm.service';
import { NodeClipboardService } from '../../core/node-clipboard.service';
import { NodeEditSession } from '../../core/node-edit-session';
import { LlmUseCaseRunner } from '../../core/llm/orchestration';

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
  /** Client-side node clipboard; used here to paste a copied branch at the top. */
  readonly clipboard = inject(NodeClipboardService);
  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly parameters = inject(ChatParametersService);
  private readonly llmRunner = inject(LlmUseCaseRunner);
  private readonly generation = inject(GenerationSettingsService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly confirm = inject(ConfirmService);
  private readonly editSession = inject(NodeEditSession);

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

  // ------------------------------------------------------------------
  // Navbar multi-selection (Ctrl+click / Ctrl+drag on the active path)
  // ------------------------------------------------------------------

  /** Ordered ids of the nodes selected in the navbar (subset of the active path). */
  readonly navSelectedIds = signal<string[]>([]);
  readonly navHasSelection = computed(() => this.navSelectedIds().length > 0);
  /** Navbar node currently under the pointer — target for Ctrl+V paste. */
  readonly navClipboardTargetId = signal<string | null>(null);

  private navDragActive = false;
  private navDragMoved = false;
  private navDragAnchor = -1;
  private navDragBase = new Set<string>();
  private navSelectionChatId: string | null = null;

  isNavNodeSelected(id: string): boolean {
    return this.navSelectedIds().includes(id);
  }

  /** Plain click → scroll to the node; Ctrl+click is handled by pointer down/up. */
  onNavNodeClick(event: MouseEvent, node: ChatNode): void {
    if (event.ctrlKey || event.metaKey) return;
    this.scrollToNode(node.id);
  }

  private navNodeIndex(nodeId: string): number {
    return this.getActivePath().findIndex(n => n.id === nodeId);
  }

  onNavPointerDown(event: PointerEvent, node: ChatNode): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    this.navDragActive = true;
    this.navDragMoved = false;
    this.navDragBase = new Set(this.navSelectedIds());
    this.navDragAnchor = this.navNodeIndex(node.id);
  }

  /** Fires on pointer-entering a nav node — extends a ctrl+drag and tracks hover. */
  onNavPointerEnter(node: ChatNode): void {
    this.navClipboardTargetId.set(node.id);
    if (!this.navDragActive) return;
    const i = this.navNodeIndex(node.id);
    if (i < 0) return;
    this.navDragMoved = true;
    const path = this.getActivePath();
    const lo = Math.min(this.navDragAnchor, i);
    const hi = Math.max(this.navDragAnchor, i);
    const range = new Set(path.slice(lo, hi + 1).map(n => n.id));
    const merged = new Set(this.navDragBase);
    for (const id of range) merged.add(id);
    this.navSelectedIds.set(path.filter(n => merged.has(n.id)).map(n => n.id));
  }

  onNavPointerLeave(): void {
    this.navClipboardTargetId.set(null);
  }

  @HostListener('document:pointerup', ['$event'])
  onNavDocumentPointerUp(_event: PointerEvent): void {
    if (!this.navDragActive) return;
    this.navDragActive = false;
    if (this.navDragMoved) return;
    // Plain Ctrl+click (no drag) → toggle the anchor node.
    const path = this.getActivePath();
    const anchor = path[this.navDragAnchor];
    if (anchor) this.toggleNavSelection(anchor.id);
  }

  toggleNavSelection(id: string): void {
    const cur = this.navSelectedIds();
    this.navSelectedIds.set(cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  }

  clearNavSelection(): void {
    this.navSelectedIds.set([]);
  }

  private selectedNavNodes(): ChatNode[] {
    const byId = new Map(this.chatService.currentNodes().map(n => [n.id, n]));
    const out: ChatNode[] = [];
    for (const id of this.navSelectedIds()) {
      const n = byId.get(id);
      if (n) out.push(n);
    }
    return out;
  }

  copyNavSelection(): void {
    const nodes = this.selectedNavNodes();
    if (!nodes.length) return;
    this.clipboard.copySequence(nodes);
  }

  async cutNavSelection(): Promise<void> {
    const nodes = this.selectedNavNodes();
    if (!nodes.length) return;
    const hasPayload = nodes.some(
      (n) => !!n.content?.trim() || !!(n.attachments && n.attachments.length),
    );
    if (hasPayload) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.cutSelectedAsk', { count: nodes.length }),
        message: this.i18n.t('node.cutSelectedMsg', { count: nodes.length }),
        confirmLabel: this.i18n.t('node.cutSelected'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await this.clipboard.cutSequence(nodes);
      this.clearNavSelection();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.cutFailed', { error: err?.message || err }));
    }
  }

  /** Remove the selected nodes (single nodes only — following text stays). */
  async deleteNavSelection(): Promise<void> {
    const nodes = this.selectedNavNodes();
    if (!nodes.length) return;
    try {
      for (const node of nodes) {
        await this.chatService.deleteNode(node.chatId, node.id, { keepChildren: true });
      }
      this.clearNavSelection();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.deleteSelectedFailed', { error: err?.message || err }));
    }
  }

  /** Paste the clipboard right after the given navbar node. */
  async pasteNavSelectionAfter(nodeId: string): Promise<void> {
    if (!this.clipboard.hasContent()) return;
    try {
      await this.clipboard.paste(null, nodeId);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.pasteFailed', { error: err?.message || err }));
    }
  }

  private readonly router = inject(Router);
  private static readonly LS_SIDEBAR_WIDTH = 'chat-client.sidebar.width';
  private static readonly SIDEBAR_WIDTH_DEFAULT = 290;
  private static readonly SIDEBAR_WIDTH_MIN = 200;
  private static readonly SIDEBAR_WIDTH_MAX = 720;

  /** Per-chat Elaborate continuation state (localStorage). */
  private static readonly LS_ELABORATE = 'chat-client.elaborate.byChatId';

  readonly sidebarWidth = signal(this.loadSidebarWidth());
  readonly isResizing = signal(false);
  readonly showChatParams = signal(false);
  readonly chatParamsOverride = signal(false);
  readonly chatParamsDraft = signal<ChatParametersDraft>(emptyParametersDraft());
  readonly chatParamsInherited = signal<ResolvedChatParameters | null>(null);
  readonly chatParamsSummary = signal('defaults');
  readonly isGeneratingStructure = signal(false);
  readonly pendingStructure = signal<string | null>(null);

  /** Trash panel for soft-deleted branches of the current chat. */
  readonly showTrash = signal(false);
  readonly trashLoading = signal(false);

  /** Elaborate-dialog state: first/last chapter + comma-separated characters
   *  + optional hints guiding the elaborations. */
  readonly showElaborateDialog = signal(false);
  readonly isElaborating = signal(false);
  readonly elaborateFirst = signal(1);
  readonly elaborateLast = signal(1);
  readonly elaborateNames = signal('');
  readonly elaborateHints = signal('');
  /** When checked, the dialog ignores First/Last and re-elaborates the chapter
   *  that was last elaborated, chaining onto its already generated text. */
  readonly elaborateStickLast = signal(false);
  /** Model used for every elaboration. Initialised to the model of the most
   *  recent assistant answer; can be overridden in the dialog. */
  readonly elaborateModelId = signal<string>('');

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
    // Leaving the chat page must not leave a stale edit session behind —
    // otherwise re-entering a node editor later would start out "dirty" even
    // though nothing was changed.
    this.editSession.abandon();
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
      // While Elaborate chains nodes sequentially (and an illustration
      // storyboard versions the chapter as pictures arrive), draft
      // housekeeping is deferred so it cannot re-point the active path
      // between the work's steps.
      const busy = this.isElaborating() || this.chatService.isIllustrating();
      this.chatService.currentNodes();
      this.chatService.getActivePath();
      if (!chatId || generating || busy) return;
      queueMicrotask(async () => {
        await this.chatService.ensureDraftAtLeaf(chatId);
        this.restoreOpenedChatPosition(chatId);
        this.syncVisibleNode();
      });
    });
    effect(() => {
      // Navbar selection only ever refers to the currently open chat.
      const chatId = this.chatService.currentChatId();
      if (chatId !== this.navSelectionChatId) {
        this.navSelectionChatId = chatId;
        this.navSelectedIds.set([]);
        this.navClipboardTargetId.set(null);
      }
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


  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent) {
    // Escape closes the elaborate dialog (same as its Cancel button).
    if (event.key === 'Escape' && this.showElaborateDialog()) {
      event.preventDefault();
      this.cancelElaborate();
      return;
    }

    if (this.isTyping(event)) return;
    const ctrl = event.ctrlKey || event.metaKey;

    // Navbar multi-selection shortcuts (only when something is selected).
    if (this.navSelectedIds().length > 0) {
      if (ctrl && (event.key === 'c' || event.key === 'C')) {
        event.preventDefault();
        this.copyNavSelection();
        return;
      }
      if (ctrl && (event.key === 'x' || event.key === 'X')) {
        event.preventDefault();
        this.cutNavSelection();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        this.deleteNavSelection();
        return;
      }
    }

    // Paste behind the navbar node under the pointer.
    if (ctrl && (event.key === 'v' || event.key === 'V')) {
      const targetId = this.navClipboardTargetId();
      if (this.clipboard.hasContent() && targetId) {
        event.preventDefault();
        void this.pasteNavSelectionAfter(targetId);
        return;
      }
    }

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

  async toggleTrash() {
    const open = !this.showTrash();
    this.showTrash.set(open);
    if (open) {
      const chatId = this.currentChatId();
      if (!chatId) return;
      this.trashLoading.set(true);
      try {
        await this.chatService.loadDeletedNodes(chatId);
      } finally {
        this.trashLoading.set(false);
      }
    }
  }

  /** Paste the internal node clipboard as a new top-level branch (parent null). */
  async pasteAtTop(): Promise<void> {
    try {
      await this.clipboard.paste(null);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.pasteFailed', { error: err?.message || err }));
    }
  }

  trashCount(): number {
    return this.chatService.deletedNodes().length;
  }

  trashPreview(node: ChatNode): string {
    return node.content?.trim() || this.i18n.t('chat.trashEmptyContent');
  }

  trashDate(node: ChatNode): string {
    const t = node.deletedAt || node.updatedAt || node.createdAt;
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
  }

  async restoreBranch(nodeId: string): Promise<void> {
    const chatId = this.currentChatId();
    if (!chatId) return;
    try {
      await this.chatService.restoreBranch(chatId, nodeId);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('chat.trashRestoreFailed', { error: err?.message || err }));
    }
  }

  async purgeBranch(nodeId: string): Promise<void> {
    const chatId = this.currentChatId();
    if (!chatId) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('chat.trashPurgeAsk'),
      message: this.i18n.t('chat.trashPurgeMsg'),
      confirmLabel: this.i18n.t('chat.trashPurge'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;
    try {
      await this.chatService.purgeBranch(chatId, nodeId);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('chat.trashPurgeFailed', { error: err?.message || err }));
    }
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

  /** Abort the current generation AND any running multi-call operation
   *  (headings / elaborate / title / summary). */
  stopGeneration(): void {
    this.chatService.stopGeneration();
  }

  /** Generate a title for the whole story (context = all assistant nodes). */
  async generateTitle(): Promise<void> {
    await this.runStructureGeneration('title');
  }

  /** Generate an introduction for the whole story (context = all assistant nodes).
   *  The resulting structure node wraps the story and sits right after an
   *  existing structure node (e.g. a generated title), or becomes the very
   *  first node of the story when none exists yet. */
  async generateIntroduction(): Promise<void> {
    await this.runStructureGeneration('overview');
  }

  /** Shared generation for the chat-level Title / Introduction buttons. */
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
    // The whole process (LLM call + node wiring) is cancelled by one Stop press.
    const opSignal = this.chatService.beginOperation(task);
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
      // Any anchor node works — the `structure-title` / `structure-overview`
      // use case reads the whole chat state to build its own context.
      const node = this.chatService.getActiveChild(null);
      const usecase = task === 'title' ? 'structure-title' : 'structure-overview';
      const slots = await this.llmRunner.run({
        chat,
        node,
        usecase,
        vars: { modelId: model.modelId, providerId: model.providerId }
      }, { signal: opSignal });
      if (this.chatService.isOperationCancelled()) return;
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.structureEmpty'));
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      alert(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      this.isGeneratingStructure.set(false);
      this.pendingStructure.set(null);
      this.chatService.endOperation();
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
    // The whole multi-call process is cancelled by one Stop press.
    const opSignal = this.chatService.beginOperation('headings');
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
      // Any anchor node works — the `structure-headings` use case walks the
      // active path itself and stops between chapters when aborted.
      const node = this.getCurrentLeaf() ?? this.chatService.getActiveChild(null);
      const slots = await this.llmRunner.run({
        chat,
        node,
        usecase: 'structure-headings',
        vars: { modelId: model.modelId, providerId: model.providerId }
      }, { signal: opSignal });
      if (this.chatService.isOperationCancelled()) return;
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.structureEmpty'));
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      alert(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      this.isGeneratingStructure.set(false);
      this.pendingStructure.set(null);
      this.chatService.endOperation();
    }
  }

  // ------------------------------------------------------------------
  // Elaborate — extend the chat with per-chapter elaborations
  // ------------------------------------------------------------------

  /** Per-chat continuation state for the Elaborate dialog. */
  private loadElaborateState(chatId: string): { lastChapter: number; characters: string; hints: string } {
    try {
      const raw = localStorage.getItem(ChatComponent.LS_ELABORATE);
      const map = raw ? JSON.parse(raw) : {};
      const entry = map?.[chatId];
      if (entry && typeof entry.lastChapter === 'number' && Number.isFinite(entry.lastChapter)) {
        return {
          lastChapter: Math.max(0, Math.floor(entry.lastChapter)),
          characters: typeof entry.characters === 'string' ? entry.characters : '',
          hints: typeof entry.hints === 'string' ? entry.hints : '',
        };
      }
    } catch {
      /* corrupted / blocked storage — start fresh */
    }
    return { lastChapter: 0, characters: '', hints: '' };
  }

  private saveElaborateState(chatId: string, state: { lastChapter: number; characters: string; hints: string }): void {
    try {
      const raw = localStorage.getItem(ChatComponent.LS_ELABORATE);
      const map = raw ? JSON.parse(raw) : {};
      map[chatId] = state;
      localStorage.setItem(ChatComponent.LS_ELABORATE, JSON.stringify(map));
    } catch {
      /* best-effort; never block elaboration on storage failure */
    }
  }

  /** The dialog hints formatted for the `{{hints}}` template placeholder
   *  (empty string when no hints were given, so empty templates stay clean). */
  private elaborateHintsText(): string {
    const hints = this.elaborateHints().trim();
    return hints ? `\nFollow these hints from the user: ${hints}` : '';
  }

  /** Most recent current assistant answer of this chat (model source + attach point). */
  private mostRecentAssistantNode(): ChatNode | null {
    const nodes = this.chatService.currentNodes()
      .filter(n => n.role === 'assistant' && n.isCurrent && n.content?.trim())
      .sort((a, b) =>
        (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)
      );
    return nodes[0] ?? null;
  }

  /** Model of the most recent assistant answer, resolvable to a ModelEntry. */
  private resolveElaborateModel(node: ChatNode): ModelEntry | null {
    const models = this.enabledModels();
    return models.find(m => !!node.modelId && (m.modelId === node.modelId || m.id === node.modelId))
      ?? models.find(m =>
        m.modelId === this.lastModelService.selectedModelId() ||
        m.id === this.lastModelService.selectedModelId())
      ?? models[0]
      ?? null;
  }

  /** Resolve the selected (overrideable) elaborate model to entry + provider. */
  private resolveSelectedElaborateModel(): { model: ModelEntry; provider: ProviderConfig } | null {
    const models = this.enabledModels();
    const model = models.find(m =>
      !!this.elaborateModelId() &&
      (m.modelId === this.elaborateModelId() || m.id === this.elaborateModelId())
    )
      ?? models.find(m =>
        m.modelId === this.lastModelService.selectedModelId() ||
        m.id === this.lastModelService.selectedModelId())
      ?? models[0];
    if (!model) return null;
    const provider = this.settings.providers().find(p => p.id === model.providerId);
    return provider ? { model, provider } : null;
  }

  openElaborateDialog(): void {
    const chatId = this.currentChatId();
    if (!chatId || this.isGeneratingStructure() || this.isElaborating()) return;
    const anchor = this.mostRecentAssistantNode();
    if (!anchor) {
      alert(this.i18n.t('chat.elaborateNoAnchor'));
      return;
    }

    // Continue where the last elaboration for THIS chat left off:
    //   First chapter = previous Last chapter + 1, characters = last used.
    // Each chat keeps its own state (not a global default).
    const state = this.loadElaborateState(chatId);
    const next = state.lastChapter + 1;
    this.elaborateFirst.set(next);
    this.elaborateLast.set(next);
    this.elaborateNames.set(state.characters);
    this.elaborateHints.set(state.hints);
    this.elaborateStickLast.set(false);

    // initial model = the one that created the most recent assistant answer
    const model = this.resolveElaborateModel(anchor);
    this.elaborateModelId.set(model?.modelId ?? '');
    this.showElaborateDialog.set(true);
  }

  cancelElaborate(): void {
    this.showElaborateDialog.set(false);
  }

  /** Toggle "stick to last chapter". While checked the First/Last fields are
   *  disabled and shown as the single chapter last elaborated for this chat;
   *  unchecking restores the default continuation (= last elaborated + 1). */
  onStickLastToggle(checked: boolean): void {
    this.elaborateStickLast.set(!!checked);
    const chatId = this.currentChatId();
    if (!chatId) return;
    const state = this.loadElaborateState(chatId);
    if (checked) {
      const stick = state.lastChapter > 0
        ? state.lastChapter
        : Math.max(this.elaborateLast(), 1);
      this.elaborateFirst.set(stick);
      this.elaborateLast.set(stick);
    } else {
      const next = Math.max(state.lastChapter + 1, 1);
      this.elaborateFirst.set(next);
      this.elaborateLast.set(next);
    }
  }

  /** Confirm the dialog and run the sequential elaborations. */
  async confirmElaborate(): Promise<void> {
    const chatId = this.currentChatId();
    this.showElaborateDialog.set(false);
    if (!chatId) return;

    const firstRaw = this.elaborateFirst();
    let first = Math.max(firstRaw, 1);
    let last = this.elaborateLast();

    // "Stick to last chapter": ignore the First/Last values and re-elaborate
    // the chapter that was last elaborated for THIS chat. The new question is
    // chained under the most recent assistant answer (which holds the already
    // generated text of that chapter), so the model continues it in context.
    if (this.elaborateStickLast()) {
      const state = this.loadElaborateState(chatId);
      last = state.lastChapter > 0 ? state.lastChapter : Math.max(last, 1);
      first = last;
    }
    if (last < first) return;

    const names = this.elaborateNames()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const hints = this.elaborateHintsText();

    const anchor = this.mostRecentAssistantNode();
    if (!anchor) return;

    const resolved = this.resolveSelectedElaborateModel();
    if (!resolved) {
      alert(this.i18n.t('chat.elaborateNoModel'));
      return;
    }
    const { model, provider } = resolved;

    // Remember what was used, per chat, for the next dialog opening.
    this.saveElaborateState(chatId, {
      lastChapter: last,
      characters: this.elaborateNames(),
      hints: this.elaborateHints()
    });

    this.isElaborating.set(true);
    this.chatService.elaborating = true;
    // One Stop press cancels the whole chain (all chapters / views).
    this.chatService.beginOperation('elaborate');
    try {
      let parentId: string | null = anchor.id;
      for (let chapter = first; chapter <= last; chapter++) {
        if (this.chatService.isOperationCancelled()) break;
        // No names → one generic elaboration per chapter.
        // With names → one elaboration per name, in first person.
        const prompts = names.length > 0
          ? names.map(name => this.promptDefaults.render('structure.elaborate-view', {
              chapter,
              name,
              hints
            }))
          : [this.promptDefaults.render('structure.elaborate', { chapter, hints })];

        for (const prompt of prompts) {
          if (this.chatService.isOperationCancelled()) break;
          // The anchor for each step is the answer node of the previous one
          // (the first anchor is the most recent assistant answer).
          const parentNode = parentId
            ? this.chatService.currentNodes().find(n => n.id === parentId) ?? anchor
            : anchor;
          const slots = await this.llmRunner.run({
            chat: this.chatService.chats().find(c => c.id === chatId) ?? null,
            node: parentNode,
            usecase: 'send-elaborate',
            vars: {
              content: prompt,
              modelId: model.modelId,
              providerId: model.providerId
            }
          });
          parentId = slots.flow?.value?.answerNodeId ?? parentId;
        }
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      alert(this.i18n.t('chat.elaborateFailed', { error: err?.message || err }));
    } finally {
      this.isElaborating.set(false);
      this.chatService.elaborating = false;
      this.chatService.endOperation();
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
