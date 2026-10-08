import {
  Component, HostListener, OnDestroy, inject, input, output, signal, effect, afterRenderEffect,
  viewChild, ElementRef, Provider, computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { SettingsService } from '../../core/settings.service';
import { ChatNode, NodeAttachment, ChatMessage, Chat } from '../../models/chat';
import { MarkdownService } from '../../core/markdown.service';
import { NodeEditSession} from '../../core/node-edit-session';
import {ConfirmService} from '../../core/confirm.service';
import { ChatParametersService } from '../../core/chat-parameters.service';
import {
  inferMimeType,
  isImageMime,
  isTextualMime,
  resolvedMime,
  nodeToMessageContent,
  decodeDataUrlToText,
  estimateContentTokens,
  PREPEND_MAX_TOKENS
} from '../../core/llm/llm-message';
import { formatParametersSummary } from '../../models/chat-parameters';
import {ProjectService} from '../../core/project.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { newId } from '../../core/common/helpers';
import { GenerationSettingsService } from '../../core/generation-settings.service';
import { PromptDefaultsService } from '../../core/prompt-defaults.service';
import { ModelEntry, ProviderConfig, canGenerateImages } from '../../models/chat-config';
import { IllustrateDialogService } from '../../core/illustrate-dialog.service';
import { PrependDialogService } from '../../core/prepend-dialog.service';
import { RewriteDialogService } from '../../core/rewrite-dialog.service';
import { IllustrateOptions } from '../../models/illustrate-options';
import { LightboxService } from '../../core/lightbox.service';
import { LlmUseCaseRunner } from '../../core/llm/orchestration';
import { LlmFlowRunner } from '../../core/llm/orchestration';
import { LlmPostprocessorService, pickUsecase, buildIllustrationAttachments, generatedImageAttachments } from '../../core/llm/orchestration';
import { type ImageScene } from '../../core/llm/orchestration';
import { parseSuggestionVariants } from '../../core/llm/orchestration/evaluators';
import { type LlmImagePart } from '../../core/llm/llm-message';

/**
 * Locate a DOM-selected fragment inside the markdown source. Rendering
 * collapses whitespace (newlines → space, multiple spaces → one), so a plain
 * indexOf can miss a selection that spans a line break. Fall back to a
 * whitespace-tolerant regex. Returns the flat index/length of the first match,
 * or null when the fragment cannot be found.
 */
function locateFragmentInSource(source: string, fragment: string): { index: number; length: number } | null {
  if (!fragment.trim()) return null;
  const plain = source.indexOf(fragment);
  if (plain >= 0) return { index: plain, length: fragment.length };
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped.replace(/\s+/g, '\\s+'));
  const m = source.match(re);
  if (m && m.index != null && m[0].length > 0) return { index: m.index, length: m[0].length };
  return null;
}

/** A single command shown in the node right-click (context) menu. */
interface CtxMenuItem {
  /** Translated display text. */
  label: string;
  /** Invoked when the item is chosen (the menu closes first). */
  action: () => void;
  /** Destructive styling (remove / delete). */
  danger?: boolean;
  /** Shown greyed-out and not clickable. */
  disabled?: boolean;
  /** Separator row, not an action. */
  divider?: boolean;
}

@Component({
  selector: 'app-chat-node',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-node.component.html',
  styleUrl: './chat-node.component.css'
})
export class ChatNodeComponent implements OnDestroy {
  private readonly settings = inject(SettingsService);
  public readonly markdownService = inject(MarkdownService);
  readonly chatService = inject(ChatService);
  readonly projectService = inject(ProjectService);
  private readonly runner = inject(LlmUseCaseRunner);
  private readonly flowRunner = inject(LlmFlowRunner);
  private readonly postprocessor = inject(LlmPostprocessorService);
  private readonly parameters = inject(ChatParametersService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly illustrateDialog = inject(IllustrateDialogService);
  private readonly lightbox = inject(LightboxService);
  private readonly rewriteDialog = inject(RewriteDialogService);

  private readonly confirm = inject(ConfirmService);
  readonly i18n = inject(I18nService);

  readonly node = input.required<ChatNode>();
  readonly activeChildId = input<string | null>(null);
  readonly activate = output<string>();

  readonly editAttachments = signal<NodeAttachment[]>([]);
  readonly isEditorDragOver = signal(false);
  private readonly MAX_ATTACHMENT_BYTES = 4_000_000;

  readonly contentDraft = signal('');
  readonly branchModelId = signal('');
  readonly isLoading = signal(false);
  readonly pendingAction = signal<'version' | 'branch' | 'insert' | 'send' | 'continue' | 'structure' | 'prepend' | 'image' | null>(null);
  /** Check-my-English (direction) feature state. */
  readonly checkingEnglish = signal(false);
  readonly englishSuggestions = signal<string[] | null>(null);
  readonly showPreview = signal(false);
  /** Set by Cancel so auto-open does not immediately re-enter edit. */
  readonly editDismissed = signal(false);
  readonly enabledModels = this.settings.enabledModels;
  private readonly editSession = inject(NodeEditSession);
  readonly showPriorVersions = signal(false);
  readonly thinkingClosed = signal(true);
  private static readonly LS_PREPEND = 'chat.prependByNodeId';
  readonly prependEnabled = signal(false);
  /** The stored director text for the current node (custom prefix). */
  readonly prependText = signal('');
  private readonly prependDialog = inject(PrependDialogService);

  private readonly editArea = viewChild<ElementRef<HTMLTextAreaElement>>('editArea');
  private readonly streamEnd = viewChild<ElementRef<HTMLElement>>('streamEnd');
  private readonly readContent = viewChild<ElementRef<HTMLElement>>('readContent');
  private readonly ctxMenuEl = viewChild<ElementRef<HTMLElement>>('ctxMenu');

  /** Viewport coordinates of the open right-click menu, or null when closed. */
  readonly ctxMenu = signal<{ x: number; y: number } | null>(null);
  /** Measured size of the open menu, used to clamp it into the viewport. */
  private readonly ctxSize = signal<{ w: number; h: number } | null>(null);
  /**
   * The chat-node whose context menu is currently open. Only one menu is open
   * at a time — opening a new one closes the previous (keeps the DOM clean).
   */
  private static openMenu: ChatNodeComponent | null = null;

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


  priorVersions(): ChatNode[] {
    return this.chatService.getPriorVersions(this.node());
  }

  priorVersionHtml(n: ChatNode): string {
    return this.markdownService.toHtml(n.content ?? '');
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
    return this.node().role === 'user';
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
        title: this.i18n.t('node.discardTitle'),
        message: this.i18n.t('node.discardMsg'),
        confirmLabel: this.i18n.t('common.discard'),
        cancelLabel: this.i18n.t('common.keepEditing'),
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
    this.editSession.commit(id);
  }


  /**
   * OK — persist as a new version of this node. Does not call the LLM.
   * Answers use /edit-assistant. Questions use /edit-question (see patches).
   * For a question the model selected in the editor is ALSO persisted onto the
   * new version, so the model choice sticks to the node (Send / Branch /
   * Insert read it from there the next time).
   */
  async saveAsVersion(): Promise<void> {
    const node = this.node();
    const newContent = this.contentDraft().trim();
    const attachments = this.editAttachments();

    const attachmentsUnchanged =
      JSON.stringify(attachments) === JSON.stringify(node.attachments || []);

    // Nothing was changed (empty draft w/o attachments, or identical text +
    // attachments) → keep the node untouched and just close the editor. Use
    // closeEditor() (NOT cancelEdit()): cancelEdit would ask for a discard
    // confirmation when the edit session is dirty (e.g. the user typed and
    // then reverted), which blocked saving. No new version node is created.
    if ((!newContent && attachments.length === 0) ||
      (newContent === node.content && attachmentsUnchanged)) {
      this.closeEditor();
      return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    this.isLoading.set(true);
    this.pendingAction.set('version');
    try {
      let saved: ChatNode;
      if (node.role === 'assistant' || node.role === 'system' || node.role === 'structural') {
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
      // The model selector is only shown while editing a user node. Versioning
      // copies the OLD model, so persist the freshly selected model (when it
      // actually changed) onto the new version.
      if (node.role === 'user' && this.branchModelId()) {
        const selected = this.enabledModels().find(
          m => m.modelId === this.branchModelId() || m.id === this.branchModelId()
        );
        if (selected && selected.modelId !== node.modelId && selected.providerId) {
          saved = await this.chatService.patchNode(chatId, saved.id, {
            modelId: selected.modelId,
            providerId: selected.providerId
          });
        }
      }
      this.activate.emit(saved.id);
      this.closeEditor();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.saveFailed', { error: err?.message || err }));
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
      alert(this.i18n.t('node.modelMissing'));
      return null;
    }

    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      alert(this.i18n.t('node.providerMissing'));
      return null;
    }

    return { node, content, attachments, chatId, model, provider };
  }

  private async runSend(
    pending: 'send' | 'branch' | 'insert' | 'continue',
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
      alert(this.i18n.t('node.failed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  // ------------------------------------------------------------------
  // Illustrate — generate a picture for this beat from the chat so far
  // ------------------------------------------------------------------

  /**
   * Whether the user-facing "Illustrate" action is available for this node.
   * Chapters can be illustrated directly. Directions need the chapter that
   * responded to them (the picture is attached to that chapter).
   */
  canIllustrate(): boolean {
    const n = this.node();
    if (n.role === 'assistant') return !!n.content?.trim();
    if (n.role === 'user') {
      return !!n.content?.trim()
        && this.hasCurrentChapter(n);
    }
    return false;
  }

  /** True while editing a direction that has a draft and a chapter to attach to. */
  canIllustrateDraft(): boolean {
    const n = this.node();
    return n.role === 'user'
      && !!this.contentDraft().trim()
      && this.hasCurrentChapter(n);
  }

  /** Progress of a storyboard run (done/total), set while `pendingAction === 'image'`. */
  readonly imageProgress = signal<{ done: number; total: number } | null>(null);

  /** Which recorded prompt attachment is expanded inline (by attachment id). */
  readonly expandedPromptId = signal<string | null>(null);
  /** Which refused prompt attachment is being edited for re-render. */
  readonly editingPromptId = signal<string | null>(null);
  /** Live draft of the adapted prompt while editing a refused prompt. */
  readonly promptEditDraft = signal('');

  /** Button label while generating — "Creating…" or "Creating 3/12…" in storyboard mode. */
  imageProgressLabel(): string {
    const p = this.imageProgress();
    return p && p.total > 1
      ? this.i18n.t('node.generatingImageCount', { done: p.done, total: p.total })
      : this.i18n.t('node.generatingImage');
  }

  // ------------------------------------------------------------------
  // Recorded prompt attachments — show the text inline; adapt + re-render
  // the ones that were refused.
  // ------------------------------------------------------------------

  /** A text attachment recording an image prompt (`prompt-N.txt`, `refused-prompt-N.txt`). */
  isPromptAttachment(a: NodeAttachment): boolean {
    return isTextualMime(resolvedMime(a))
      && /^(?:refused-)?prompt(?:-\d+)?\.txt$/i.test(a.name);
  }

  /** A prompt attachment that records a REFUSED / empty image generation. */
  isRefusedPromptAttachment(a: NodeAttachment): boolean {
    return isTextualMime(resolvedMime(a))
      && /^refused-prompt(?:-\d+)?\.txt$/i.test(a.name);
  }

  /** Decoded text of a (prompt) attachment, or ''. */
  attachmentText(a: NodeAttachment): string {
    return typeof a.dataUrl === 'string' ? (decodeDataUrlToText(a.dataUrl) ?? '') : '';
  }

  /**
   * The actual prompt portion of a recorded prompt attachment. For refused
   * records the body is "Prompt used:\n…\n\nModel reply:\n…" — this returns
   * only the prompt part so an adapted edit starts from the prompt alone.
   */
  promptAttachmentPrompt(a: NodeAttachment): string {
    const text = this.attachmentText(a);
    if (this.isRefusedPromptAttachment(a)) {
      // Body: "Prompt used:\n<prompt>\n\nModel reply:\n<reply>"
      const m = text.match(/^Prompt used\s*:\n([\s\S]*?)\n\s*\n\s*Model reply:/i);
      if (m && (m[1] ?? '').trim()) return m[1].trim();
    }
    return text.trim();
  }

  /** The scene number recorded in a `prompt-N.txt` / `refused-prompt-N.txt` name (or null). */
  private promptRecordScene(a: NodeAttachment): number | null {
    const m = a.name.match(/^(?:refused-)?prompt-(\d+)\.txt$/i);
    return m ? Number(m[1]) : null;
  }

  /** True when `a` is an illustration paired with the given scene number. */
  private isIllustrationForScene(a: NodeAttachment, scene: number): boolean {
    return isImageMime(resolvedMime(a)) &&
      new RegExp(`^illustration-${scene}\.`, 'i').test(a.name);
  }

  togglePrompt(a: NodeAttachment): void {
    const same = this.expandedPromptId() === a.id;
    this.editingPromptId.set(null);
    this.promptEditDraft.set('');
    this.expandedPromptId.set(same ? null : a.id);
  }

  /** Open the inline editor for a refused prompt, pre-filled with the prompt used. */
  startPromptEdit(a: NodeAttachment): void {
    this.expandedPromptId.set(a.id);
    this.editingPromptId.set(a.id);
    this.promptEditDraft.set(this.promptAttachmentPrompt(a));
  }

  cancelPromptEdit(): void {
    this.editingPromptId.set(null);
    this.promptEditDraft.set('');
  }

  /**
   * Delete a recorded prompt attachment from the chapter (with confirmation).
   * Only the prompt trace/record is removed — a paired illustration, if any,
   * is kept. `editAssistant` versions the change, so the record stays
   * recoverable from prior versions.
   */
  async deletePromptAttachment(a: NodeAttachment): Promise<void> {
    const node = this.node();
    if (node.role !== 'assistant') return;
    if (this.isLoading() || this.chatService.isGenerating(node.id)) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const ok = await this.confirm.ask({
      title: this.i18n.t('node.promptDeleteTitle'),
      message: this.i18n.t('node.promptDeleteMsg', { name: a.name }),
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;

    try {
      const rest = (node.attachments || []).filter(x => x.id !== a.id);
      const saved = await this.chatService.editAssistant(
        chatId,
        node.id,
        node.content || '',
        rest,
        node.thinking ?? undefined
      );
      // Close any open inline editor for this attachment.
      if (this.expandedPromptId() === a.id) this.expandedPromptId.set(null);
      if (this.editingPromptId() === a.id) {
        this.editingPromptId.set(null);
        this.promptEditDraft.set('');
      }
      this.activate.emit(saved.id);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.deleteFailed', { error: err?.message || err }));
    }
  }

  /**
   * Re-render ONE refused picture with the adapted prompt. The fresh image
   * (and its prompt file) replace the refused prompt record on the same
   * chapter; every other attachment stays. Runs the orchestration
   * `image-generation` use case: a single picture (no storyboard planning) —
   * the adapted prompt IS the concrete scene.
   */
  async rerenderPrompt(a: NodeAttachment): Promise<void> {
    const prompt = this.promptEditDraft().trim();
    const node = this.node();
    const chatId = this.chatService.currentChatId();
    if (!prompt || !chatId) return;
    if (node.role !== 'assistant') return;
    if (this.isLoading() || this.chatService.isGenerating(node.id)) return;

    this.isLoading.set(true);
    this.pendingAction.set('image');
    this.imageProgress.set(null);
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId);
      if (!chat) return;

      // The orchestration `image-generation` use case resolves the image
      // model itself (image-create task → first enabled image-capable model),
      // grounds the picture in the context up to the chapter, forwards prior
      // illustrations as reference when the model can read images, and
      // renders the ADAPTED prompt as a single concrete scene — no storyboard
      // planning.
      const promptText = `${this.i18n.t('node.imageAnchor', {
        role: this.i18n.t('node.roleAssistant')
      })}:\n${prompt}`;
      const result = await this.runner.run({
        chat,
        node,
        usecase: 'image-generation',
        vars: { promptText, count: 1 }
      });

      // A hard failure (e.g. no image model enabled) with no scene to fall
      // back on surfaces as an alert instead of silently doing nothing.
      const scenes = result.storyboard?.value ?? [];
      const images = result.images?.value ?? [];
      if (scenes.length === 0 && images.length > 0) {
        // No per-scene records but images came back (defensive — the
        // image-generation controller always emits a storyboard slot).
        scenes.push({ scene: 1, prompt: promptText, images, refused: false });
      }
      const imageCount = images.length;
      if (result.error?.status === 'error' && scenes.length === 0) {
        const reason = result.error.reason ?? '';
        if (/image model/i.test(reason)) {
          alert(this.i18n.t('node.imageModelMissing'));
          return;
        }
        throw new Error(reason || this.i18n.t('node.imageEmpty'));
      }

      const generated = buildIllustrationAttachments(scenes, promptText)
        .map(x => ({ ...x, id: x.id || newId() }));

      if (generated.length === 0) {
        const reply = (scenes[0]?.content ?? '').trim()
          || (result.text?.value ?? '').trim();
        throw new Error(
          reply
            ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
            : this.i18n.t('node.imageEmpty')
        );
      }

      // Replace the adapted record with the fresh result, renumbered to the
      // recorded scene number so it slots in next to the other storyboard
      // images instead of colliding with an existing `illustration-N`.
      const recordedScene = this.promptRecordScene(a);
      let rest = (node.attachments || []).filter(x => x.id !== a.id);
      if (recordedScene != null) {
        // For a SUCCESSFUL prompt (paired with an illustration), also drop the
        // old illustration of the same scene so the re-render REPLACES it
        // instead of duplicating the picture. A refused record has no image.
        rest = rest.filter(x => !this.isIllustrationForScene(x, recordedScene));
      }
      const placed = this.placeRerenderResult(generated, rest, recordedScene);
      const merged = [...rest, ...placed];

      const saved = await this.chatService.editAssistant(
        chatId,
        node.id,
        node.content || '',
        merged,
        node.thinking ?? undefined
      );

      this.editingPromptId.set(null);
      this.promptEditDraft.set('');
      this.expandedPromptId.set(null);
      this.activate.emit(saved.id);

      if (imageCount === 0) {
        // The model refused again (or returned nothing parseable): the updated
        // refused-prompt record was saved above so the adapted prompt stays
        // findable and pre-fills the next attempt — but there is STILL no
        // picture. Surface the model's reply instead of silently "succeeding"
        // (same as `illustrate`).
        const reply = (scenes[0]?.content ?? '').trim()
          || (result.text?.value ?? '').trim();
        alert(reply
          ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
          : this.i18n.t('node.imageEmpty'));
      }
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.imageFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
      this.imageProgress.set(null);
    }
  }

  /**
   * Renumber the result of a refused-prompt re-render: illustration + prompt
   * files get the refused scene number when it is still free, otherwise the
   * next free number — so the re-rendered scene does not collide with other
   * storyboard attachments.
   */
  private placeRerenderResult(
    attachments: NodeAttachment[],
    existing: NodeAttachment[],
    preferredScene: number | null
  ): NodeAttachment[] {
    const used = new Set<number>();
    for (const a of existing) {
      const m = a.name.match(/^(?:illustration|(?:refused-)?prompt)-(\d+)(\.\w+)?$/i);
      if (m) used.add(Number(m[1]));
    }
    let scene = preferredScene && !used.has(preferredScene) ? preferredScene : 0;
    if (!scene) {
      scene = 1;
      while (used.has(scene)) scene++;
      used.add(scene);
    }
    return attachments.map(a => {
      const ill = a.name.match(/^illustration-(\d+)(\.\w+)?$/i);
      if (ill) {
        used.add(scene);
        return { ...a, name: `illustration-${scene}${ill[2] ?? ''}` };
      }
      // Keep a re-refused attempt REFUSED (do not demote it to a success
      // "prompt" file — the model returned no picture for it).
      const re = a.name.match(/^refused-prompt-(\d+)(\.\w+)?$/i);
      if (re) return { ...a, name: `refused-prompt-${scene}${re[2] ?? '.txt'}` };
      const pr = a.name.match(/^prompt-(\d+)(\.\w+)?$/i);
      if (pr) return { ...a, name: `prompt-${scene}${pr[2] ?? '.txt'}` };
      return a;
    });
  }

  private hasCurrentChapter(n: ChatNode): boolean {
    return this.chatService.getChildren(n.id).some(c => c.role === 'assistant' && c.isCurrent);
  }

  /**
   * Generate a picture from the direction text being edited in the composer.
   * Uses the current draft (not yet saved) as the prompt, so you can tweak the
   * direction and immediately preview it as an illustration.
   */
  async illustrateWithDraft(): Promise<void> {
    const text = this.contentDraft().trim();
    if (!text) return;
    await this.illustrate(text);
  }

  /**
   * Generate one or more pictures for the current beat with the configured
   * "image-create" generation task model (fallback: any enabled model that
   * can generate images). Opens the Illustrate dialog first to collect how
   * many scenes, the style, and (for word: >1 scenes) a storyboard prompt.
   * The prompt is grounded in the active path up to this point, so earlier
   * chapters stay established context; on a direction node the direction text
   * is the scene to depict. Prior illustrations are forwarded as visual
   * reference when the chosen model can also read images. The result is
   * attached to the chapter node.
   *
   * @param promptOverride when given (e.g. an edited direction draft),
   *   use it as the scene description instead of the node's saved content.
   */
  async illustrate(promptOverride?: string | null): Promise<void> {
    const node = this.node();
    if (node.role !== 'user' && node.role !== 'assistant') return;
    if (this.isLoading() || this.chatService.isGenerating(node.id)) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    // Where the resulting picture is stored, and what it should depict.
    let chapter: ChatNode;
    let anchorText: string;
    if (node.role === 'assistant') {
      chapter = node;
      anchorText = promptOverride ?? node.content ?? '';
    } else {
      const answers = this.chatService.getChildren(node.id)
        .filter(c => c.role === 'assistant' && c.isCurrent);
      const candidate = answers[0] ?? this.chatService.getChildren(node.id)
        .find(c => c.role === 'assistant');
      if (!candidate) {
        alert(this.i18n.t('node.imageNoChapter'));
        return;
      }
      chapter = candidate;
      anchorText = promptOverride ?? node.content ?? '';
    }

    // 1. Prefer the configured image-create task model.
    let defaultModel = this.generation.modelFor('image-create');
    let defaultProvider = this.generation.providerFor('image-create');
    // 2. Fall back to any enabled model that can generate images.
    if (!defaultModel || !defaultProvider) {
      const fallback = this.enabledModels().find(canGenerateImages);
      if (fallback) {
        defaultModel = fallback;
        defaultProvider = this.settings.providers().find(p => p.id === fallback.providerId) ?? null;
      }
    }
    if (!defaultModel || !defaultProvider) {
      alert(this.i18n.t('node.imageModelMissing'));
      return;
    }

    // Ask the user how many scenes, in which style, the storyboard prompt,
    // and which image model should render the picture(s). The dialog is
    // seeded with the default rendering model, but its own last-used
    // selection (persisted in localStorage) wins when still valid.
    const options = await this.illustrateDialog.open({
      modelId: defaultModel.modelId,
      providerId: defaultModel.providerId
    });
    if (!options) return; // cancelled
    const { count, style, storyboardPrompt, purePictures, historyMode, planDescriptions } = options;

    // The dialog's options CHOOSE the orchestration use case:
    //   count > 1 || assistant chapter || pure mode → planning-based
    //   storyboards; single direction → render-node (current) / render-full
    //   (± full chat). `content` overrides the node text so an edited draft
    //   (promptOverride) is used as the scene.
    const vars = {
      count,
      style,
      storyboardPrompt,
      purePictures,
      historyMode,
      planDescriptions,
      content: anchorText,
      modelId: options.modelId || defaultModel.modelId,
      providerId: (options.modelId && options.providerId)
        ? options.providerId
        : defaultModel.providerId
    };
    const usecase = pickUsecase(vars);

    // Storyboard use cases (count > 1, the user-choice driving the planner)
    // render several pictures in stages: they take long enough to warrant a
    // Stop button, and each picture can be attached to the chapter AS SOON AS
    // it is ready (instead of waiting for the whole use case to finish).
    const isStoryboard =
      usecase === 'planned-enblock' || usecase === 'planned-scenes' || usecase === 'storyboard-direct';

    this.isLoading.set(true);
    this.pendingAction.set('image');
    this.imageProgress.set(null);

    // Where the pictures live DURING a storyboard run. Progressive writes
    // version the chapter node, so every write re-targets the LATEST version
    // and the final write replaces the interim attachments with the
    // authoritative placement plan (base attachments are captured once, at
    // start, and authoritative end state = base + final plan).
    let currentTargetId = chapter.id;
    const baseAttachments = [...(chapter.attachments ?? [])];
    const baseThinking = chapter.thinking ?? undefined;
    let interimChain: Promise<void> = Promise.resolve();
    let applySignal: AbortSignal | null = null;
    const onImages = isStoryboard
      ? (scenes: ImageScene[]): void => {
          const interim = buildIllustrationAttachments(scenes, anchorText)
            .map(a => ({ ...a, id: a.id || newId() }));
          // Serialize the progressive writes so they never race (each one
          // targets the node version returned by the previous write).
          interimChain = interimChain.then(async () => {
            try {
              const cur = this.chatService.nodes().find(n => n.id === currentTargetId) ?? chapter;
              const saved = await this.chatService.editAssistant(
                chatId,
                currentTargetId,
                cur.content || '',
                [...baseAttachments, ...interim],
                cur.thinking ?? baseThinking
              );
              currentTargetId = saved.id;
            } catch (err: any) {
              console.error(err);
            }
          });
        }
      : undefined;

    try {
      const chat = this.chatService.chats().find(c => c.id === chatId)!;
      if (isStoryboard) {
        // One Stop press cancels the whole illustrate use case: the returned
        // signal propagates into the orchestration runner so in-flight LLM
        // calls abort and no further scenes are rendered.
        applySignal = this.chatService.beginOperation('illustrate');
        this.chatService.isIllustrating.set(true);
      }
      const build = { chat, node, usecase, vars };
      const result = await this.runner.run(build, {
        signal: applySignal ?? undefined,
        ...(onImages ? { onImages } : {})
      });
      await interimChain; // flush any pending progressive writes

      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error

      // Place the pictures on the chapter node (illustration-N + prompt-N /
      // refused-prompt-N attachments), consistent with the app.
      const plan = this.postprocessor.plan(result, build);
      if (!plan) {
        throw new Error(this.i18n.t('node.imageNoChapter'));
      }

      let saved: ChatNode;
      if (isStoryboard) {
        // Replace the interim (progressively attached) pictures with the
        // authoritative final plan — the progressive writes above are
        // supersets of the start state, so this never duplicates.
        const cur = this.chatService.nodes().find(n => n.id === currentTargetId) ?? chapter;
        saved = await this.chatService.editAssistant(
          chatId,
          currentTargetId,
          cur.content || '',
          [...baseAttachments, ...plan.attachments],
          cur.thinking ?? baseThinking
        );
      } else {
        saved = await this.postprocessor.apply(plan, build);
      }
      this.activate.emit(saved.id);

      const imagesTotal = plan.summary.imagesTotal;
      if (imagesTotal === 0) {
        // Everything was refused — the refused-prompt attachments were saved
        // above so the prompts stay findable; still inform the user.
        const reply = result.text?.value?.trim() ?? '';
        alert(reply
          ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
          : this.i18n.t('node.imageEmpty'));
      } else if (count > 1 && imagesTotal < count) {
        // Storyboard partially completed — keep what was generated, tell the
        // user how many scenes came back.
        alert(this.i18n.t('node.imagePartial', {
          got: imagesTotal,
          want: count
        }));
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      alert(this.i18n.t('node.imageFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
      this.imageProgress.set(null);
      if (isStoryboard) {
        this.chatService.isIllustrating.set(false);
        this.chatService.endOperation();
      }
    }
  }

  /**
   * Send an unsent question (the in-thread composer).
   * Writes the draft onto this same node, then streams the answer.
   *
   * Text-only sends go through the LLM-orchestration `append` use case (full
   * chat history + topic system prompt via the request builder). Directions
   * carrying image attachments use `append-with-images`: the images are
   * described first by the image-interpret model and the description is
   * merged into the direction text (no binary images reach the writing
   * model).
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

      const hasImages = attachments.some(
        a => isImageMime(resolvedMime(a)) && a.dataUrl?.startsWith('data:')
      );
      if (hasImages) {
        await this.streamAppendOrchestrated(chatId, saved, content, model, provider, {
          usecase: 'append-with-images',
          attachments
        });
        return;
      }

      await this.streamAppendOrchestrated(chatId, saved, content, model, provider);
    });
  }

  /**
   * Stream one answer through the LLM-orchestration text-send use cases:
   * the request builder sends the FULL chat up to this node (+ topic system
   * prompt), the transport streams, and the evaluator folds the chunks into
   * the text slot — while `onChunk` paints the answer node LIVE during the
   * SSE stream. Placement (versioned editAssistant) goes through ChatService
   * so the chat stays consistent with the rest of the app.
   */
  private async streamAppendOrchestrated(
    chatId: string,
    question: ChatNode,
    content: string,
    model: ModelEntry,
    provider: { baseUrl: string; apiKey: string },
    opts: { usecase?: 'append' | 'append-with-images'; attachments?: NodeAttachment[] } = {}
  ): Promise<void> {
    // Close the inline editor NOW (commit the session + clear the draft),
    // mirroring the legacy streamForQuestion timing — the editor does not
    // stay in edit mode after Send.
    this.closeEditor();

    // Placeholder answer bubble so the user sees it (and can Stop) streaming.
    const answerNode = await this.chatService.addNode(chatId, {
      parentId: question.id,
      role: 'assistant',
      content: '',
      thinking: '',
      modelId: model.modelId,
      providerId: model.providerId
    });
    this.chatService.setActiveChild(question.id, answerNode.id);
    const signal = this.chatService.startGeneration(answerNode.id);
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;

    const usecase = opts.usecase ?? 'append';
    const vars = {
      content,
      ...(usecase === 'append-with-images'
        ? { attachments: opts.attachments }
        : {})
    };

    let accContent = '';
    let accThinking = '';
    let accImages: LlmImagePart[] = [];
    try {
      const slots = await this.runner.run(
        { chat, node: question, usecase, vars },
        {
          signal,
          onChunk: chunk => {
            if (chunk.content) accContent += chunk.content;
            if (chunk.thinking) accThinking += chunk.thinking;
            if (chunk.images?.length) accImages.push(...chunk.images);
            this.paintAnswer(answerNode.id, accContent, accThinking);
          }
        }
      );

      // append-with-images: persist the merged direction text (direction +
      // image description) ONTO the user node for real, so the description
      // stays available in the history. The interpretation RECORD is stored
      // too — it marks "the description is already part of this node's text",
      // so the same images are NOT interpreted again on a later send.
      // The attachments themselves remain on the node but are never sent to
      // the LLM (history is text-only).
      const interpretation = slots.interpretation?.value;
      const mergedDirection = interpretation?.content?.trim()
        ?? slots.direction?.value?.trim();
      if (mergedDirection && mergedDirection !== question.content?.trim()) {
        const attachments = interpretation
          ? [...(question.attachments ?? []), interpretation.record as NodeAttachment]
          : question.attachments;
        await this.chatService.patchNode(chatId, question.id, {
          content: mergedDirection,
          ...(interpretation ? { attachments } : {})
        });
      } else if (interpretation) {
        // Content already matches — only store the record so re-sends skip.
        const attachments = [...(question.attachments ?? []), interpretation.record as NodeAttachment];
        await this.chatService.patchNode(chatId, question.id, { attachments });
      }

      // Prefer the evaluator's settled slots.
      const finalContent = slots.text?.value ?? accContent;
      const finalThinking = slots.thinking?.value ?? accThinking;
      const finalImages = slots.images?.value ?? accImages;
      this.paintAnswer(answerNode.id, finalContent, finalThinking);

      // An image-only answer (image-capable model streamed pictures, no text)
      // must STILL be finalized with its attachments — otherwise it stays an
      // empty placeholder that renders as "Generation stopped".
      if (finalContent.trim() || finalThinking.trim() || finalImages.length > 0) {
        const attachments = finalImages.length
          ? generatedImageAttachments(finalImages)
          : undefined;
        const versioned = await this.chatService.editAssistant(
          chatId, answerNode.id, finalContent, attachments, finalThinking
        );
        this.chatService.setActiveChild(question.id, versioned.id);
        this.activate.emit(versioned.id);
      }
    } finally {
      this.chatService.clearGeneration();
    }
  }

  /** Paint streamed text incrementally onto the in-flux assistant node. */
  private paintAnswer(nodeId: string, content: string, thinking: string): void {
    this.chatService.updateNodes(list =>
      list.map(n => (n.id === nodeId ? { ...n, content, thinking } : n))
    );
  }

  /**
   * Run a structural flow through the orchestration `LlmFlowRunner` (branch /
   * insert / regenerate / rewrite / prepend) with loading + pending-action
   * tracking. After the flow, activates the flow's target node and surfaces
   * the outcome. `builder` supplies the flow vars (content, director text,
   * …); `pending` is the UI spinner label.
   */
  private async runFlow(
    usecase: 'send-branch' | 'send-insert' | 'send-regenerate' | 'send-rewrite' | 'send-prepend',
    pending: 'branch' | 'insert' | 'send' | 'prepend',
    builder?: (build: { vars: Record<string, unknown> }) => void
  ): Promise<boolean> {
    const node = this.node();
    const chatId = this.chatService.currentChatId();
    if (!chatId) return false;
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;

    this.isLoading.set(true);
    this.pendingAction.set(pending);
    try {
      const build: { chat: Chat; node: ChatNode; usecase: typeof usecase; vars: Record<string, unknown> } = {
        chat: chat as Chat,
        node,
        usecase,
        vars: {}
      };
      builder?.(build);
      const slots = await this.flowRunner.run(build as never);
      const flow = slots.flow?.value;
      if (flow?.activateId) this.activate.emit(flow.activateId);
      return true;
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.failed', { error: err?.message || err }));
      return false;
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
    const target = await this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, model } = target;

    const ok = await this.runFlow('send-branch', 'branch', build => {
      build.vars['content'] = content;
      build.vars['attachments'] = attachments;
      // The model selected in the editor wins — the flow writer (and the new
      // question node) must use the freshly chosen model, not the node's.
      build.vars['modelId'] = model.modelId;
      build.vars['providerId'] = model.providerId;
    });
    // The draft was consumed to create the branch — close the editor so the
    // edit session is not left dangling (otherwise the next edit on this node
    // reopens a stale, dirty session).
    if (ok) this.closeEditor();
  }

/**
   * Insert — like Branch (new sibling question + LLM answer with the same
   * prior-message context), then hang the previous question and its siblings
   * under that new assistant answer.
   */
  async saveAsInsertAndSend(): Promise<void> {
    const target = await this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, model } = target;
    if (node.role !== 'user') return;

    const ok = await this.runFlow('send-insert', 'insert', build => {
      build.vars['content'] = content;
      build.vars['attachments'] = attachments;
      // The model selected in the editor wins — the flow writer (and the new
      // question node) must use the freshly chosen model, not the node's.
      build.vars['modelId'] = model.modelId;
      build.vars['providerId'] = model.providerId;
    });
    // Same as Branch: the draft was consumed by the insert — close the editor
    // (and the edit session) so a later edit does not start out dirty.
    if (ok) this.closeEditor();
  }

  /** Generate a chapter heading for THIS assistant answer; only its text is used as context. */
  async generateHeading(): Promise<void> {
    if (this.isLoading()) return;
    const node = this.node();
    if (node.role !== 'assistant') return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const configuredModel = this.generation.modelFor('headings');
    const model = configuredModel
      ?? this.enabledModels().find(m => m.modelId === this.resolvePreferredModelId(node));
    const provider = model
      ? this.settings.providers().find(p => p.id === model.providerId)
      : null;
    if (!model || !provider) {
      alert(this.i18n.t('node.structureModelMissing'));
      return;
    }

    this.isLoading.set(true);
    this.pendingAction.set('structure');
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
      // The `structure-heading` use case resolves the task prompt, runs the
      // non-streaming completion and creates/patches the structural heading
      // (activating it via the flow result).
      const slots = await this.runner.run({
        chat,
        node,
        usecase: 'structure-heading',
        vars: { modelId: model.modelId, providerId: model.providerId }
      });
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.structureEmpty'));
      }
      const structureNodeId = slots.flow?.value?.structureNodeId;
      if (structureNodeId) this.activate.emit(structureNodeId);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  /**
   * "Check my English" — asks the LLM to review the current direction and
   * return three improved variants. The main goal is NOT style: directions are
   * not part of the finished story, so the focus is grammar / orthography /
   * unambiguous wording that helps the writing model understand the intent.
   * One variant ("minimal") stays as close to the original as possible.
   *
   * Model/provider come from the "language-check" generation task (Settings →
   * Generation tasks); when the task is unset it falls back to the model
   * selected in the editor (the one that will read the direction).
   */
  async checkMyEnglish(): Promise<void> {
    if (this.node().role !== 'user' || !this.isEditing()) return;
    if (this.checkingEnglish() || this.isLoading()) return;

    const text = this.contentDraft().trim();
    if (!text) {
      alert(this.i18n.t('node.englishEmpty'));
      return;
    }

    // 1. Prefer the model configured for the language-check task.
    let model = this.generation.modelFor('language-check');
    let provider = this.generation.providerFor('language-check');
    if (!model || !provider) {
      // 2. Fall back to the model selected in the editor / the preferred model.
      const modelId = this.branchModelId() || this.resolvePreferredModelId(this.node());
      const fallback = this.enabledModels().find(
        m => m.modelId === modelId || m.id === modelId
      );
      model = fallback ?? null;
      provider = fallback
        ? this.settings.providers().find(p => p.id === fallback.providerId) ?? null
        : null;
    }
    if (!model || !provider) {
      alert(this.i18n.t('node.englishModelMissing'));
      return;
    }

    this.checkingEnglish.set(true);
    this.englishSuggestions.set(null);
    try {
      const chatId = this.chatService.currentChatId();
      const chat = chatId
        ? this.chatService.chats().find(c => c.id === chatId) ?? null
        : null;
      // The `language-check` use case resolves the task prompt + model, runs
      // the non-streaming completion and returns the RAW model text — the
      // variants are parsed here for the suggestion panel.
      const slots = await this.runner.run({
        chat,
        node: this.node(),
        usecase: 'language-check',
        vars: { content: text, modelId: model.modelId, providerId: model.providerId }
      });
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.englishFailed'));
      }
      const variants = this.parseEnglishVariants(slots.text?.value ?? '');
      if (variants.length === 0) {
        alert(this.i18n.t('node.englishFailed', {
          error: this.i18n.t('node.englishNoVariants')
        }));
        return;
      }
      this.englishSuggestions.set(variants);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.englishFailed', { error: err?.message || err }));
    } finally {
      this.checkingEnglish.set(false);
    }
  }

  /** Replace the draft with a chosen variant and close the panel. */
  applyEnglishSuggestion(text: string): void {
    this.contentDraft.set(text);
    this.editSession.patch(this.node().id, text, this.editAttachments());
    this.englishSuggestions.set(null);
    this.scheduleResize();
  }

  dismissEnglishCheck(): void {
    this.englishSuggestions.set(null);
  }

  /**
   * Rewrite the MARKED text of the editor: capture the current textarea
   * selection, open the rewrite dialog (editable fragment + directions +
   * context scope + model), and when the dialog returns a text, replace the
   * marked range in the draft with it. Works for both directions (user) and
   * chapters (assistant) while editing.
   */
  async openRewriteDialog(): Promise<void> {
    if (!this.isEditing() || this.isLoading() || this.checkingEnglish()) return;
    const ta = this.editArea()?.nativeElement;
    if (!ta) return;

    const s = Math.min(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
    const e = Math.max(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
    const draft = this.contentDraft();
    const fragment = draft.slice(s, e);
    if (!fragment.trim()) {
      alert(this.i18n.t('node.rewriteNoSelection'));
      return;
    }

    const node = this.node();
    const chatId = this.chatService.currentChatId();
    const chat = chatId
      ? this.chatService.chats().find(c => c.id === chatId) ?? null
      : null;
    const result = await this.rewriteDialog.open({
      fragment,
      // The whole node content is the most useful default context; the user
      // can narrow it (none / up to the marked part / whole thread) in the dialog.
      contextMode: 'node',
      selectionEnd: e,
      node,
      chat,
      modelId: node.modelId || this.resolvePreferredModelId(node),
      providerId: node.providerId ?? ''
    });
    if (result == null) return; // cancelled

    const next = draft.slice(0, s) + result + draft.slice(e);
    this.contentDraft.set(next);
    this.editSession.patch(node.id, next, this.editAttachments());
    this.scheduleResize();
    // Restore focus and place the cursor around the inserted replacement.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s, s + result.length);
    });
  }

  /** Parse the LLM answer into up to 3 suggestion strings. */
  private parseEnglishVariants(content: string): string[] {
    return parseSuggestionVariants(content);
  }

  /**
   * Rewrite a piece of text MARKED in the rendered (non-edit) content.
   * Captures the current DOM selection inside the node, opens the rewrite
   * dialog (editable fragment + directions + context scope + model), and when
   * the dialog returns a text, persists a new version of the node with the
   * marked range replaced. The marked text is located in the markdown source
   * whitespace-tolerantly (rendering collapses whitespace), so the rest of the
   * source — including surrounding markdown formatting — is preserved.
   */
  async openReadRewriteDialog(): Promise<void> {
    if (this.isEditing() || this.isLoading()) return;
    const contentEl = this.readContent()?.nativeElement;
    const selection = window.getSelection();
    if (!contentEl || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      alert(this.i18n.t('node.rewriteNoSelection'));
      return;
    }
    if (!contentEl.contains(selection.anchorNode) || !contentEl.contains(selection.focusNode)) {
      alert(this.i18n.t('node.rewriteNoSelection'));
      return;
    }
    const fragment = selection.toString();
    if (!fragment.trim()) {
      alert(this.i18n.t('node.rewriteNoSelection'));
      return;
    }

    const node = this.node();
    const source = node.content || '';
    const loc = locateFragmentInSource(source, fragment);
    const chatId = this.chatService.currentChatId();
    const chat = chatId
      ? this.chatService.chats().find(c => c.id === chatId) ?? null
      : null;
    const result = await this.rewriteDialog.open({
      fragment,
      // The whole node content is the most useful default context; the user
      // can narrow it (none / up to the marked part / whole thread) in the dialog.
      contextMode: 'node',
      selectionEnd: loc ? loc.index + loc.length : source.length,
      node,
      chat,
      modelId: node.modelId || this.resolvePreferredModelId(node),
      providerId: node.providerId ?? ''
    });
    if (result == null) return; // cancelled

    if (!loc) {
      alert(this.i18n.t('node.rewriteNoSourceMatch'));
      return;
    }
    const newContent = source.slice(0, loc.index) + result + source.slice(loc.index + loc.length);

    this.isLoading.set(true);
    this.pendingAction.set('version');
    try {
      let saved: ChatNode;
      if (node.role === 'assistant' || node.role === 'system' || node.role === 'structural') {
        saved = await this.chatService.editAssistant(
          chatId!,
          node.id,
          newContent,
          node.attachments || []
        );
      } else {
        saved = await this.chatService.editUser(
          chatId!,
          node.id,
          newContent,
          node.attachments || []
        );
      }
      this.activate.emit(saved.id);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.saveFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
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
        title: this.i18n.t('node.regenerateTitleAsk'),
        message: extra > 0
          ? this.i18n.t('node.regenerateMsgExtra', { count: extra })
          : this.i18n.t('node.regenerateMsg'),
        confirmLabel: this.i18n.t('node.regenerate'),
        cancelLabel: this.i18n.t('common.cancel'),
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
      alert(this.i18n.t('node.regenerateNoParent'));
      return;
    }

    await this.runFlow('send-regenerate', 'send', build => {
      // The flow deletes the ANSWER (this.node) and re-streams under its
      // parent question — no extra vars needed.
    });
  }

  /**
   * Re-generate THIS answer in place: same LLM call / context as regenerate,
   * but the following text (this node's subtree) is preserved — only this
   * answer's content is replaced. Works by removing just this node
   * ({@link ChatService.deleteNode keepChildren}) and re-hanging the
   * preserved following text under the freshly generated answer.
   */
  async regenerateInPlace(): Promise<void> {
    const node = this.node();
    if (node.role !== 'assistant' || this.isLoading() || this.chatService.isGenerating(node.id)) {
      return;
    }

    const children = this.chatService.getChildren(node.id);
    if (children.length > 0) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.regenerateInPlaceTitleAsk'),
        message: this.i18n.t('node.regenerateInPlaceMsgExtra', { count: children.length }),
        confirmLabel: this.i18n.t('node.regenerateInPlace'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true
      });
      if (!ok) return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    await this.runFlow('send-rewrite', 'send', build => {
      // The flow deletes only THIS answer (keeping children) and re-streams
      // under its parent question, re-adopting the preserved children.
      build.vars['keepChildren'] = true;
    });
  }

  async deleteNodeOnly(): Promise<void> {
    const node = this.node();
    if (this.isLoading() || this.chatService.isGenerating(node.id)) return;
    const hasPayload = !!node.content?.trim() || !!(node.attachments && node.attachments.length);
    if (hasPayload) {
      const childCount = this.chatService.getChildren(node.id).length;
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.removeTitleAsk'),
        message: childCount > 0
          ? this.i18n.t('node.removeMsgChildren', { role: node.role === 'user' ? this.i18n.t('node.roleUser') : node.role === 'assistant' ? this.i18n.t('node.roleAssistant') : this.i18n.t('node.roleSystem'), count: childCount })
          : this.i18n.t('node.removeMsg', { role: node.role === 'user' ? this.i18n.t('node.roleUser') : node.role === 'assistant' ? this.i18n.t('node.roleAssistant') : this.i18n.t('node.roleSystem') }),
        confirmLabel: this.i18n.t('node.remove'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true
      });
      if (!ok) return;
    }
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    const parentId = node.parentId;
    try {
      await this.chatService.deleteNode(chatId, node.id, { keepChildren: true });
      const remaining = this.chatService.getChildren(parentId);
      if (remaining.length > 0) {
        const newest = remaining.reduce((a, b) =>
          this.nodeTimestamp(a) >= this.nodeTimestamp(b) ? a : b
        );
        this.activate.emit(newest.id);
      }
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.removeFailed', { error: err?.message || err }));
    }
  }

  async deleteNode(): Promise<void> {
    const node = this.node();
    const subtree = this.collectSubtree(node.id);
    const nonTrivial = subtree.filter(n => !this.isTrivialNode(n));

    if (nonTrivial.length > 0) {
      const extra = subtree.length - 1;
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.deleteTitleAsk'),
        message: extra > 0
          ? this.i18n.t('node.deleteMsgExtra', { role: node.role === 'user' ? this.i18n.t('node.roleUser') : node.role === 'assistant' ? this.i18n.t('node.roleAssistant') : this.i18n.t('node.roleSystem'), count: extra, filled: nonTrivial.length })
          : this.i18n.t('node.deleteMsg', { role: node.role === 'user' ? this.i18n.t('node.roleUser') : node.role === 'assistant' ? this.i18n.t('node.roleAssistant') : this.i18n.t('node.roleSystem') }),
        confirmLabel: this.i18n.t('common.delete'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true
      });
      if (!ok) return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const parentId = node.parentId;

    try {
      await this.chatService.deleteNode(chatId, node.id);
      const remaining = parentId ? this.chatService.getChildren(parentId) : [];
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
      alert(this.i18n.t('node.deleteFailed', { error: err?.message || err }));
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

  // ------------------------------------------------------------------
  // Right-click context menu (browser right-click)
  // ------------------------------------------------------------------

  /**
   * Open the in-app context menu at the pointer position. The browser native
   * menu is suppressed for the node; right-clicking inside the editor
   * (cut/copy/paste) or on rendered links/images keeps the native menu.
   */
  openNodeMenu(event: MouseEvent): void {
    if (this.isNativeContextTarget(event.target as HTMLElement | null)) return;
    event.preventDefault();
    event.stopPropagation();
    // Only one node menu at a time: close the previously open one (if any)
    // before opening this node's menu.
    if (ChatNodeComponent.openMenu && ChatNodeComponent.openMenu !== this) {
      ChatNodeComponent.openMenu.closeCtxMenu();
    }
    ChatNodeComponent.openMenu = this;
    this.ctxMenu.set({ x: event.clientX, y: event.clientY });
    this.ctxSize.set(null); // re-measure once the menu renders
  }

  /** Suppress the native menu on the custom menu itself. */
  preventCtxDefault(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  closeCtxMenu(): void {
    if (ChatNodeComponent.openMenu === this) {
      ChatNodeComponent.openMenu = null;
    }
    this.ctxMenu.set(null);
    this.ctxSize.set(null);
  }

  private isNativeContextTarget(el: HTMLElement | null): boolean {
    if (!el) return false;
    // Editor internals (cut/copy/paste) and rendered links / images have no
    // equivalent in the custom menu — keep the browser menu for them.
    return !!el.closest('textarea, input, select, a, img, .file-link');
  }

  /** Position the menu at the pointer (left), clamped inside the viewport. */
  ctxMenuLeftPx(): number {
    const menu = this.ctxMenu();
    if (!menu) return 0;
    const w = this.ctxSize()?.w ?? 220;
    return Math.max(8, Math.min(menu.x, window.innerWidth - w - 8));
  }

  /** Position the menu at the pointer (top), clamped inside the viewport. */
  ctxMenuTopPx(): number {
    const menu = this.ctxMenu();
    if (!menu) return 0;
    const h = this.ctxSize()?.h ?? 320;
    return Math.max(8, Math.min(menu.y, window.innerHeight - h - 8));
  }

  /** Build the menu rows for the current node (role- and state-aware). */
  ctxMenuItems(): CtxMenuItem[] {
    const n = this.node();
    const busy = this.isLoading() || this.chatService.isGenerating(n.id);

    // Common: every node can be copied / edited.
    const common: CtxMenuItem[] = [
      { label: this.i18n.t('node.ctxCopy'), action: () => void this.copyContent() },
      { label: this.i18n.t('node.ctxEdit'), action: () => void this.startEdit() }
    ];
    if (n.content?.trim()) {
      common.push({
        label: this.i18n.t('node.ctxRewriteSelection'),
        action: () => void this.openReadRewriteDialog()
      });
    }
    if (this.priorVersions().length) {
      common.push({
        label: this.i18n.t('node.ctxPriorVersions'),
        action: () => this.showPriorVersions.set(!this.showPriorVersions())
      });
    }

    // Role-specific actions — mirror the toolbar buttons' availability.
    const roleItems: CtxMenuItem[] = [];
    if (n.role === 'assistant') {
      roleItems.push(
        { label: this.i18n.t('node.ctxHeading'), action: () => void this.generateHeading(), disabled: busy },
        { label: this.i18n.t('node.ctxRegenerate'), action: () => void this.regenerateAnswer(), disabled: busy },
        { label: this.i18n.t('node.ctxRegenerateInPlace'), action: () => void this.regenerateInPlace(), disabled: busy },
        { label: this.i18n.t('node.ctxIllustrate'), action: () => void this.illustrate(), disabled: busy || !this.canIllustrate() }
      );
    } else if (n.role === 'user') {
      if (this.showClosedContinue()) {
        roleItems.push({
          label: this.i18n.t('node.ctxContinue'),
          action: () => void this.continueDraft(),
          disabled: this.isLoading()
        });
      }
      if (!this.isUnsentQuestion()) {
        roleItems.push({
          label: this.i18n.t('node.ctxPrepend'),
          action: () => void this.openPrependDialog(),
          disabled: this.isLoading()
        });
      }
      roleItems.push({
        label: this.i18n.t('node.ctxIllustrate'),
        action: () => void this.illustrate(),
        disabled: busy || !this.canIllustrate()
      });
    }

    // Destructive actions, always last.
    const dangerItems: CtxMenuItem[] = [
      { label: this.i18n.t('node.ctxRemove'), action: () => void this.deleteNodeOnly(), danger: true, disabled: busy },
      { label: this.i18n.t('node.ctxDelete'), action: () => void this.deleteNode(), danger: true, disabled: busy }
    ];

    const result: CtxMenuItem[] = [];
    const pushGroup = (items: CtxMenuItem[]) => {
      if (!items.length) return;
      if (result.length) {
        result.push({ label: '', action: () => undefined, divider: true });
      }
      result.push(...items);
    };
    pushGroup(common);
    pushGroup(roleItems);
    pushGroup(dangerItems);
    return result;
  }

  /** Close the menu, then run the chosen action (if it is enabled). */
  runCtxAction(item: CtxMenuItem): void {
    if (item.divider || item.disabled) return;
    this.closeCtxMenu();
    item.action();
  }

  @HostListener('document:keydown.escape')
  onCtxEscape(): void {
    this.closeCtxMenu();
  }

  @HostListener('window:resize')
  onCtxResize(): void {
    this.closeCtxMenu();
  }

  // The page scrolled under the open menu (wheel, keyboard, live scroll) — close it.
  @HostListener('document:scroll')
  onCtxScroll(): void {
    this.closeCtxMenu();
  }


  private buildContextMessagesUpTo(parentId: string | null): ChatMessage[] {
    if (!parentId) return [];

    if (typeof (this.chatService as any).getPathToNode === 'function') {
      const path: ChatNode[] = (this.chatService as any).getPathToNode(parentId);
      const messages: ChatMessage[] = [];

      for (const n of path) {
        if (n.role !== 'structural') {
          messages.push({ role: n.role, content: nodeToMessageContent(n) });
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
    effect(() => {
      const id = this.node().id;
      this.prependEnabled.set(this.isPrependStored(id));
      this.prependText.set(this.storedPrependText(id));
    });

    afterRenderEffect(() => {
      const n = this.node();
      this.renderedHtml();
      const generating = this.chatService.isGenerating(n.id)
        || this.chatService.generatingNodeId() === n.id;
      if (!generating) return;
      if (this.chatService.followThinking() && n.thinking?.trim()) {
        this.thinkingClosed.set(false);
      }
      if (this.chatService.followStreaming() || (this.chatService.followThinking() && !n.content?.trim())) {
        this.followLive();
      }
    });

    // Measure the open context menu so it can be clamped into the viewport.
    afterRenderEffect(() => {
      const menu = this.ctxMenu();
      const el = this.ctxMenuEl()?.nativeElement;
      if (menu && el) {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const size = this.ctxSize();
        if (!size || size.w !== w || size.h !== h) {
          this.ctxSize.set({ w, h });
        }
      }
    });
  }

  ngOnDestroy(): void {
    // Release the shared open-menu handle when this node unmounts.
    if (ChatNodeComponent.openMenu === this) {
      ChatNodeComponent.openMenu = null;
    }
  }

  /**
   * Stored director texts per node id (a `{ [nodeId]: string }` map).
   * The value is the edited director instruction; presence ⇒ prepend enabled.
   */
  private readPrependMap(): Record<string, string> {
    try {
      const raw = localStorage.getItem(ChatNodeComponent.LS_PREPEND);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writePrependMap(map: Record<string, string>): void {
    try {
      localStorage.setItem(ChatNodeComponent.LS_PREPEND, JSON.stringify(map));
    } catch { /* best-effort */ }
  }

  private isPrependStored(nodeId: string): boolean {
    const map = this.readPrependMap();
    return Object.prototype.hasOwnProperty.call(map, nodeId);
  }

  private storedPrependText(nodeId: string): string {
    const map = this.readPrependMap();
    return Object.prototype.hasOwnProperty.call(map, nodeId) ? (map[nodeId] ?? '') : '';
  }

  /**
   * Open the "Prepend director" dialog, prefilled with the existing editor
   * text or a newly-proposed instruction (from `prependInstruction`). On
   * confirm, the edited text is stored AND the LLM is called with the
   * director instruction + the following assistant chapters (≤5000 tokens);
   * the result is inserted as TWO new nodes BEFORE the current
   * direction/user/question node: the prompt-prefix (director) node and the
   * LLM result node. An empty confirmed text clears the director.
   */
  async openPrependDialog(): Promise<void> {
    const node = this.node();
    if (node.role !== 'user') return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const nodeId = node.id;
    const existing = this.storedPrependText(nodeId);
    const proposed = existing.trim() || this.prependInstruction();
    const text = await this.prependDialog.open(proposed, this.isPrependStored(nodeId));
    // Cancel resolves null — keep the current state.
    if (text == null) return;
    const cleaned = text.trim();
    const map = this.readPrependMap();
    if (cleaned) {
      map[nodeId] = cleaned;
    } else {
      delete map[nodeId];
    }
    this.writePrependMap(map);
    this.prependEnabled.set(this.isPrependStored(nodeId));
    this.prependText.set(this.storedPrependText(nodeId));
    if (!cleaned) return; // cleared — no generation

    await this.generatePrependNodes(node, cleaned);
  }

  /**
   * Insert the director (user) node + a streamed result (assistant) BEFORE
   * the current direction, adopting the current node under the result — via
   * the orchestration `send-prepend` flow. On failure the stored flag is
   * rolled back.
   */
  private async generatePrependNodes(
    node: ChatNode,
    directorText: string
  ): Promise<void> {
    const following = this.followingAssistantContent(node.id);
    const hasHistory = this.buildContextMessagesUpTo(node.parentId).length > 0
      || following.trim().length > 0;
    // Nothing to narrate — no assistant chapter anywhere in the thread.
    if (!hasHistory) return;

    const ok = await this.runFlow('send-prepend', 'prepend', build => {
      build.vars['directorText'] = directorText;
      build.vars['followingText'] = following;
    });
    // On failure the flow runner alerted; roll back the stored flag so the UI
    // reflects "not active".
    if (!ok && this.prependEnabled()) {
      const map = this.readPrependMap();
      delete map[node.id];
      this.writePrependMap(map);
      this.prependEnabled.set(false);
      this.prependText.set('');
    }
  }

  private followLive(): void {
    const anchor = this.streamEnd()?.nativeElement;
    if (!anchor) return;
    const scroller = this.nearestScrollParent(anchor);
    if (!scroller) {
      anchor.scrollIntoView({ block: 'end', inline: 'nearest' });
      return;
    }
    const a = anchor.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    if (a.bottom > s.bottom - 12 || a.top < s.top + 12) {
      const nextTop = scroller.scrollTop + (a.bottom - s.bottom) + 16;
      scroller.scrollTop = Math.max(0, nextTop);
    }
  }

  private nearestScrollParent(el: HTMLElement): HTMLElement | null {
    let cur: HTMLElement | null = el.parentElement;
    while (cur) {
      const style = getComputedStyle(cur);
      const oy = style.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return document.scrollingElement as HTMLElement | null;
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
        alert(this.i18n.t('node.copyFailed'));
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
        alert(this.i18n.t('node.fileTooLarge', { name: file.name }));
        continue;
      }
      const dataUrl = await this.readAsDataURL(file);
      result.push({
        id: newId(),
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
    // Open in the in-app lightbox instead of `window.open(dataUrl,'_blank')`:
    // Chromium (Chrome + Electron) blocks top-level navigation to data: URLs,
    // which is why a plain window.open only worked in Firefox.
    const urls = (this.node().attachments || [])
      .filter(a => isImageMime(resolvedMime(a)) && /^(data:|https?:\/\/)/i.test(a.dataUrl || ''))
      .map(a => a.dataUrl);
    const start = urls.indexOf(dataUrl);
    this.lightbox.open(urls, start >= 0 ? start : 0);
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
  private elaborateCharacters(): string {
    try {
      const chatId = this.chatService.currentChatId();
      if (!chatId) return '';
      const raw = localStorage.getItem('chat-client.elaborate.byChatId');
      const map = raw ? JSON.parse(raw) : {};
      const entry = map?.[chatId];
      return typeof entry?.characters === 'string' ? entry.characters.trim() : '';
    } catch {
      return '';
    }
  }

  private prependInstruction(): string {
    // The stored (user-edited) director text wins when present.
    const stored = this.prependText().trim();
    if (stored) return stored;
    const characters = this.elaborateCharacters();
    return characters
      ? this.promptDefaults.render('structure.prepend', { characters })
      : this.promptDefaults.render('structure.prepend-basic', {});
  }



  /**
   * The concatenated FULL text of the assistant nodes that FOLLOW the current
   * node on the active path (the chapters after the direction being prepended).
   * Whole chapters are kept (never split); walking from the current node
   * forward, chapters are appended until the aggregate token estimate exceeds
   * `PREPEND_MAX_TOKENS` — the remaining (newest) chapters are left out.
   * Returns '' when there is nothing following.
   */
  private followingAssistantContent(nodeId: string): string {
    const path: ChatNode[] = this.chatService.getActivePath();
    const start = path.findIndex(n => n.id === nodeId);
    if (start < 0) return '';

    const parts: string[] = [];
    let tokens = 0;
    // Walk the active path AFTER the node; keep only complete assistant
    // chapters, newest-first append until the cap is exceeded.
    for (let i = start + 1; i < path.length; i++) {
      const n = path[i];
      if (n.role !== 'assistant') continue;
      const text = (n.content || '').trim();
      if (!text) continue;
      const t = estimateContentTokens(text);
      if (parts.length > 0 && tokens + t > PREPEND_MAX_TOKENS) break;
      parts.push(text);
      tokens += t;
    }
    return parts.join('\n\n');
  }
}
