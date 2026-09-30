import {
  Component, inject, input, output, signal, effect, afterRenderEffect,
  viewChild, ElementRef, Provider, computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { SettingsService } from '../../core/settings.service';
import { ChatNode, NodeAttachment, ChatMessage } from '../../models/chat';
import { MarkdownService } from '../../core/markdown.service';
import { NodeEditSession} from '../../core/node-edit-session';
import {ConfirmService} from '../../core/confirm.service';
import {LlmService} from '../../core/llm/llm.service';
import { ChatParametersService } from '../../core/chat-parameters.service';
import {
  inferMimeType,
  isImageMime,
  isTextualMime,
  resolvedMime,
  nodeToMessageContent,
  imagePartToAttachment,
  textPromptAttachment,
  decodeDataUrlToText,
  type MessagePart
} from '../../core/llm/llm-message';
import { GenerateImagesResult, GeneratedImageScene } from '../../core/llm/llm.service';
import { formatParametersSummary } from '../../models/chat-parameters';
import {ProjectService} from '../../core/project.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { newId } from '../../core/common/helpers';
import { GenerationSettingsService } from '../../core/generation-settings.service';
import { GenerationTaskKind } from '../../models/generation-task';
import { ModelEntry, canInterpretImages, canGenerateImages } from '../../models/chat-config';
import { IllustrateDialogService } from '../../core/illustrate-dialog.service';
import { IllustrateOptions } from '../../models/illustrate-options';
import { LightboxService } from '../../core/lightbox.service';

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
  private readonly generation = inject(GenerationSettingsService);
  private readonly illustrateDialog = inject(IllustrateDialogService);
  private readonly lightbox = inject(LightboxService);

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
  readonly pendingAction = signal<'version' | 'branch' | 'insert' | 'send' | 'continue' | 'structure' | 'image' | null>(null);
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
   */
  async saveAsVersion(): Promise<void> {
    const node = this.node();
    const newContent = this.contentDraft().trim();
    const attachments = this.editAttachments();

    const attachmentsUnchanged =
      JSON.stringify(attachments) === JSON.stringify(node.attachments || []);

    if ((!newContent && attachments.length === 0) ||
      (newContent === node.content && attachmentsUnchanged)) {
      await this.cancelEdit();
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

  private async streamForQuestion(
    chatId: string,
    question: ChatNode,
    contextParentId: string | null,
    provider: { baseUrl: string; apiKey: string },
    model: ModelEntry,
    extra?: { content?: string; attachments?: NodeAttachment[]; adoptNodeIds?: string[] }
  ): Promise<ChatNode> {
    const effective: ChatNode = extra
      ? { ...question, content: extra.content ?? question.content, attachments: extra.attachments ?? question.attachments }
      : question;

    const contextMessages = this.buildContextMessagesUpTo(contextParentId);

    // Automatic image interpretation: when a direction carries image
    // attachments, describe them via the image-interpret task model so the
    // writing model understands what it is looking at.
    if (effective.role === 'user') {
      const images = (effective.attachments || []).filter(
        a => isImageMime(resolvedMime(a)) && a.dataUrl?.startsWith('data:')
      );
      if (images.length > 0) {
        const interpretation = await this.interpretDirectionImages(images);
        const directionText = (effective.content || '').trim();
        if (interpretation) {
          contextMessages.push({
            role: 'user',
            content: directionText
              ? this.i18n.t('node.imageInterpretPrefix') + '\n\n' + interpretation
              : interpretation
          });
          this.closeEditor();
          return this.streamAnswerWithoutImages(chatId, effective, provider, model, contextMessages, extra);
        }
      }
    }

    contextMessages.push({
      role: 'user',
      content: nodeToMessageContent(effective)
    });
    this.closeEditor();
    return this.llmService.streamAnswer(
      chatId, question.id, provider, model, contextMessages, undefined,
      extra?.adoptNodeIds?.length ? { adoptNodeIds: extra.adoptNodeIds } : undefined
    );
  }

  /**
   * After images were interpreted into text, stream the answer for the
   * direction text without re-sending the binary image payload.
   */
  private streamAnswerWithoutImages(
    chatId: string,
    question: ChatNode,
    provider: { baseUrl: string; apiKey: string },
    model: ModelEntry,
    contextMessages: ChatMessage[],
    extra?: { content?: string; attachments?: NodeAttachment[]; adoptNodeIds?: string[] }
  ): Promise<ChatNode> {
    const textOnly: ChatNode = {
      ...question,
      content: extra?.content ?? question.content ?? '',
      attachments: (extra?.attachments ?? question.attachments ?? []).filter(
        a => !isImageMime(resolvedMime(a))
      )
    };
    contextMessages.push({ role: 'user', content: nodeToMessageContent(textOnly) });
    return this.llmService.streamAnswer(
      chatId, question.id, provider, model, contextMessages, undefined,
      extra?.adoptNodeIds?.length ? { adoptNodeIds: extra.adoptNodeIds } : undefined
    );
  }

  /**
   * Describe the attached images with the image-interpret generation task
   * model, falling back to any enabled model that supports image input.
   * Returns a combined textual description, or null when no capable model is
   * available / the call failed.
   */
  private async interpretDirectionImages(images: NodeAttachment[]): Promise<string | null> {
    // 1. Prefer the configured image-interpret task.
    let model = this.generation.modelFor('image-interpret');
    let provider = this.generation.providerFor('image-interpret');
    // 2. Fall back to any enabled model that can interpret images.
    if (!model || !provider) {
      const fallback = this.enabledModels().find(canInterpretImages);
      if (fallback) {
        model = fallback;
        provider = this.settings.providers().find(p => p.id === fallback.providerId) ?? null;
      }
    }
    if (!model || !provider) return null;

    const prompt = ChatNodeComponent.IMAGE_INTERPRET_PROMPT;
    const imageParts = nodeToMessageContent({ content: prompt, attachments: images } as ChatNode);
    try {
      const resolved = await this.llmService.resolveForCurrentChat(model);
      const result = await this.llmService.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        [{ role: 'user', content: imageParts }],
        false,
        undefined,
        undefined,
        { ...this.llmService.toLlmExtras(resolved), stream: false },
        model.providerId
      );
      const desc = result.content.trim();
      return desc || null;
    } catch (err) {
      console.error('Image interpretation failed', err);
      return null;
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

  /** The scene number recorded in a `refused-prompt-N.txt` name (or null). */
  private refusalScene(a: NodeAttachment): number | null {
    const m = a.name.match(/^refused-prompt-(\d+)\.txt$/i);
    return m ? Number(m[1]) : null;
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
   * Re-render ONE refused picture with the adapted prompt. The fresh image
   * (and its prompt file) replace the refused prompt record on the same
   * chapter; every other attachment stays. Runs as a single picture (no
   * storyboard planning) — the adapted prompt IS the concrete scene.
   */
  async rerenderPrompt(a: NodeAttachment): Promise<void> {
    const prompt = this.promptEditDraft().trim();
    const node = this.node();
    const chatId = this.chatService.currentChatId();
    if (!prompt || !chatId) return;
    if (node.role !== 'assistant') return;
    if (this.isLoading() || this.chatService.isGenerating(node.id)) return;

    // 1. Prefer the configured image-create task model.
    let model = this.generation.modelFor('image-create');
    let provider = this.generation.providerFor('image-create');
    // 2. Fall back to any enabled model that can generate images.
    if (!model || !provider) {
      const fallback = this.enabledModels().find(canGenerateImages);
      if (fallback) {
        model = fallback;
        provider = this.settings.providers().find(p => p.id === fallback.providerId) ?? null;
      }
    }
    if (!model || !provider) {
      alert(this.i18n.t('node.imageModelMissing'));
      return;
    }

    this.isLoading.set(true);
    this.pendingAction.set('image');
    this.imageProgress.set(null);
    try {
      // Ground the picture in the previous content along the active path.
      const contextMessages = this.buildContextMessagesUpTo(node.parentId);
      const messages: ChatMessage[] = this.textOnlyMessages(contextMessages);
      const instruction = this.generation.get('image-create').prompt.trim()
        || this.defaultImagePrompt();
      const anchor = `${instruction}\n\n` +
        this.i18n.t('node.imageAnchor', {
          role: this.i18n.t('node.roleAssistant')
        }) + `:\n${prompt}`;

      // Forward prior illustrations as reference when the chosen model can
      // read images (same rule as `illustrate`).
      const priorImages = this.priorChapterImages(node.parentId);
      if (canInterpretImages(model) && priorImages.length > 0) {
        const parts: MessagePart[] = [
          { type: 'text', text: anchor + '\n\n' + this.i18n.t('node.imageReference') }
        ];
        for (const img of priorImages) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
        }
        messages.push({ role: 'user', content: parts });
      } else {
        messages.push({ role: 'user', content: anchor });
      }

      const result = await this.llmService.generateImage(
        provider, model, messages, undefined,
        {
          count: 1,
          planDescriptions: false,
          onProgress: (done, total) => this.imageProgress.set({ done, total })
        }
      );
      const imageCount = result.images.length;

      const generated = this.buildIllustrationAttachments(result, anchor)
        .map(x => ({ ...x, id: x.id || newId() }));

      if (generated.length === 0) {
        const reply = (result.content || '').trim();
        throw new Error(
          reply
            ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
            : this.i18n.t('node.imageEmpty')
        );
      }

      // Replace the refused record with the fresh result, renumbered to the
      // refused scene number so it slots in next to the other storyboard
      // images instead of colliding with an existing `illustration-N`.
      const rest = (node.attachments || []).filter(x => x.id !== a.id);
      const placed = this.placeRerenderResult(generated, rest, this.refusalScene(a));
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
        const reply = (result.content || '').trim();
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

  /**
   * Build the attachments to persist for an image-generation result.
   *
   * For every scene it keeps a text attachment with the exact prompt that was
   * sent:
   * - successful scene → `prompt-N.txt` next to the `illustration-N.*` image(s);
   * - refused / empty scene → `refused-prompt-N.txt` (with the model's reply,
   *   e.g. the refusal text), so the prompt of a refused picture stays findable.
   */
  private buildIllustrationAttachments(
    result: GenerateImagesResult,
    fallbackPrompt: string
  ): NodeAttachment[] {
    const scenes: GeneratedImageScene[] = Array.isArray(result.scenes) && result.scenes.length > 0
      ? result.scenes
      : [{
          scene: 1,
          prompt: fallbackPrompt,
          images: result.images,
          refused: result.images.length === 0,
          ...(result.content ? { content: result.content } : {})
        }];

    const out: NodeAttachment[] = [];
    let imageIndex = 0;
    for (const scene of scenes) {
      const prompt = (scene.prompt || '').trim() || fallbackPrompt;
      for (const img of scene.images ?? []) {
        out.push(imagePartToAttachment(img, imageIndex));
        imageIndex += 1;
      }
      if (!prompt) continue;

      if (scene.refused) {
        const reply = (scene.content || '').trim();
        out.push(textPromptAttachment(
          `refused-prompt-${scene.scene}.txt`,
          [
            'Prompt used:',
            prompt,
            '',
            reply ? `Model reply:\n${reply}` : 'Model reply: (none — image was not created)'
          ].join('\n')
        ));
      } else {
        out.push(textPromptAttachment(`prompt-${scene.scene}.txt`, prompt));
      }
    }
    return out;
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
    let contextParentId: string | null;
    if (node.role === 'assistant') {
      chapter = node;
      anchorText = promptOverride ?? node.content ?? '';
      contextParentId = node.parentId; // the direction (and everything before) is context
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
      contextParentId = node.parentId; // previous chapters only; the direction is added below
    }

    // 1. Prefer the configured image-create task model.
    let model = this.generation.modelFor('image-create');
    let provider = this.generation.providerFor('image-create');
    // 2. Fall back to any enabled model that can generate images.
    if (!model || !provider) {
      const fallback = this.enabledModels().find(canGenerateImages);
      if (fallback) {
        model = fallback;
        provider = this.settings.providers().find(p => p.id === fallback.providerId) ?? null;
      }
    }
    if (!model || !provider) {
      alert(this.i18n.t('node.imageModelMissing'));
      return;
    }

    // Ask the user how many scenes, in which style, and the storyboard prompt.
    const options = await this.illustrateDialog.open();
    if (!options) return; // cancelled
    const { count, style, storyboardPrompt } = options;

    this.isLoading.set(true);
    this.pendingAction.set('image');
    this.imageProgress.set(null);
    try {
      // Ground the picture in the previous content along the active path.
      const contextMessages = this.buildContextMessagesUpTo(contextParentId);
      const messages: ChatMessage[] = this.textOnlyMessages(contextMessages);
      const instruction = this.generation.get('image-create').prompt.trim()
        || this.defaultImagePrompt();
      const styledInstruction = style
        ? `${instruction}\n\nStyle: ${style}`
        : instruction;

      const anchor = `${styledInstruction}\n\n` +
        this.i18n.t('node.imageAnchor', {
          role: this.i18n.t(node.role === 'user' ? 'node.roleUser' : 'node.roleAssistant')
        }) + `:\n${anchorText.trim() ? anchorText.trim() : '(no text)'}`;

      // Forward prior illustrations as reference only when the chosen model
      // can take images (otherwise providers may reject image_url parts).
      const priorImages = this.priorChapterImages(contextParentId);
      if (canInterpretImages(model) && priorImages.length > 0) {
        const parts: MessagePart[] = [
          { type: 'text', text: anchor + '\n\n' + this.i18n.t('node.imageReference') }
        ];
        for (const img of priorImages) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
        }
        messages.push({ role: 'user', content: parts });
      } else {
        messages.push({ role: 'user', content: anchor });
      }

      // Storyboard planning runs on a capable TEXT model when available
      // (image models are unreliable at following the strict JSON / still-frame
      // planning instructions); falls back to the image model.
      const planner = this.resolvePlanner(model, provider);
      const result = await this.llmService.generateImage(
        provider, model, messages, undefined,
        {
          count,
          storyboardPrompt: count > 1 ? storyboardPrompt : undefined,
          // Storyboard: first derive concrete picture descriptions from the
          // story, then render each image from its description (instead of
          // letting the model pick scenes from the raw prose).
          planDescriptions: count > 1,
          // Storyboard: render the whole storyboard in ONE completion so
          // characters/faces/environment stay consistent across all images
          // (falls back to per-scene automatically when the model returns
          // fewer than requested).
          singleCall: count > 1,
          planner,
          onProgress: (done, total) => this.imageProgress.set({ done, total })
        }
      );

      // Store, for every scene, a text attachment with the exact prompt used:
      // a `prompt-N.txt` next to each generated illustration, and a
      // `refused-prompt-N.txt` for scenes that were refused — so the prompt
      // behind every image (or every failed attempt) stays findable.
      const attachments = this.buildIllustrationAttachments(result, anchor)
        .map(a => ({ ...a, id: a.id || newId() }));

      if (attachments.length === 0) {
        // Surface what the model actually replied so a "no picture" case can
        // be diagnosed (e.g. a model that only describes the image, or a URL
        // shape the parser did not recognize).
        const reply = (result.content || '').trim();
        throw new Error(
          reply
            ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
            : this.i18n.t('node.imageEmpty')
        );
      }

      const merged = [...(chapter.attachments || []), ...attachments];
      const saved = await this.chatService.editAssistant(
        chatId,
        chapter.id,
        chapter.content || '',
        merged,
        chapter.thinking ?? undefined
      );
      this.activate.emit(saved.id);

      const imageCount = result.images.length;
      if (imageCount === 0) {
        // Everything was refused — the refused-prompt attachments were saved
        // above so the prompts stay findable; still inform the user.
        const reply = (result.content || '').trim();
        alert(reply
          ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
          : this.i18n.t('node.imageEmpty'));
      } else if (count > 1 && imageCount < count) {
        // Storyboard partially completed — keep what was generated, tell the
        // user how many scenes came back.
        alert(this.i18n.t('node.imagePartial', {
          got: imageCount,
          want: count
        }));
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

  /** Reduce a list of chat messages to their text, dropping image/file parts. */
  private textOnlyMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return m;
      const text = m.content
        .map(part => (part.type === 'text' && part.text ? part.text : ''))
        .filter(Boolean)
        .join('\n');
      return { role: m.role, content: text };
    });
  }

  /**
   * Collect images already present on chapters before `parentId` along the
   * active path (used as visual reference for the next illustration).
   */
  private priorChapterImages(parentId: string | null): NodeAttachment[] {
    if (!parentId) return [];
    const path = this.chatService.getPathToNode(parentId);
    const out: NodeAttachment[] = [];
    for (const n of path) {
      if (n.role !== 'assistant') continue;
      for (const a of n.attachments || []) {
        const mime = resolvedMime(a);
        const url = a.dataUrl || '';
        if (isImageMime(mime) && /^(data:|https?:\/\/)/i.test(url)) out.push(a);
      }
    }
    return out.slice(-4);
  }

  /**
   * Model/provider for the picture-description planning pass used by
   * storyboard generation. Image models are unreliable at following the
   * strict JSON / still-frame planning instructions, so prefer a capable
   * text model: the "image-interpret" task (it reasons about visual scenes),
   * then "language-check". Falls back to the rendering model/provider.
   */
  private resolvePlanner(
    imageModel: ModelEntry,
    imageProvider: { baseUrl: string; apiKey: string }
  ): { model: ModelEntry; provider: { baseUrl: string; apiKey: string } } {
    for (const kind of ['image-interpret', 'language-check'] as GenerationTaskKind[]) {
      const model = this.generation.modelFor(kind);
      const provider = this.generation.providerFor(kind);
      if (model && provider) return { model, provider };
    }
    return { model: imageModel, provider: imageProvider };
  }

  private defaultImagePrompt(): string {
    return `Illustrate this beat of the story as a single coherent picture.

The earlier chapters are the established context; the cue below is the scene to depict.

Rules:
- Stay faithful to the characters, setting, objects, mood and style already established in the earlier chapters.
- Keep character appearance, setting and style consistent with any previous illustrations.
- Prefer a painterly, atmospheric composition. No text, captions or speech bubbles inside the image unless the cue explicitly asks for a sign.
- Return the image only — no commentary.`;
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
   * Insert — like Branch (new sibling question + LLM answer with the same
   * prior-message context), then hang the previous question and its siblings
   * under that new assistant answer.
   */
  async saveAsInsertAndSend(): Promise<void> {
    const target = await this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, chatId, model, provider } = target;
    if (node.role !== 'user') return;

    await this.runSend('insert', async () => {
      const parentId = node.parentId ?? null;
      const newQuestion = await this.chatService.branchQuestion(
        chatId,
        node.id,
        content,
        model.modelId,
        model.providerId,
        attachments
      );

      this.activate.emit(newQuestion.id);

      // Previous question + siblings (including retired versions at this level).
      const adoptNodeIds = this.chatService.nodes()
        .filter(n =>
          n.chatId === chatId
          && (n.parentId ?? null) === parentId
          && n.id !== newQuestion.id
        )
        .map(n => n.id);

      const answer = await this.streamForQuestion(
        chatId, newQuestion, parentId, provider, model,
        { content, attachments, adoptNodeIds }
      );

      this.chatService.setActiveChild(parentId, newQuestion.id);
      this.chatService.setActiveChild(newQuestion.id, answer.id);
      if (adoptNodeIds.includes(node.id)) {
        this.chatService.setActiveChild(answer.id, node.id);
      } else if (adoptNodeIds.length > 0) {
        this.chatService.setActiveChild(answer.id, adoptNodeIds[0]);
      }
    });
  }

  /** Generate a chapter heading for THIS assistant answer; only its text is used as context. */
  async generateHeading(): Promise<void> {
    if (this.isLoading()) return;
    const node = this.node();
    if (node.role !== 'assistant') return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const task: GenerationTaskKind = 'headings';
    const configuredModel = this.generation.modelFor(task);
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
      const resolved = await this.llmService.resolveForCurrentChat(model);
      const config = this.generation.get(task);
      const instruction = config.prompt.trim() || this.defaultStructurePrompt(task);

      // The current chapter heading is derived from this single answer.
      const context = node.content.trim();

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

      const existingHeading = node.parentId
        ? this.chatService.nodes().find(n => n.id === node.parentId && n.role === 'structural')
        : undefined;

      if (existingHeading) {
        await this.chatService.patchNode(chatId, existingHeading.id, {
          content,
          modelId: model.modelId,
          providerId: model.providerId
        });
        this.activate.emit(existingHeading.id);
        return;
      }

      // The heading wraps this answer: it becomes the new parent (prepend placement).
      const created = await this.chatService.addNode(chatId, {
        parentId: node.parentId,
        role: 'structural',
        content,
        modelId: model.modelId,
        providerId: model.providerId,
        chatParametersId: this.chatService.chats().find(c => c.id === chatId)?.chatParametersId
          || model.chatParametersId
          || undefined
      });

      await this.chatService.reparentNodes(chatId, [node.id], created.id);
      this.chatService.setActiveChild(node.parentId, created.id);
      this.chatService.setActiveChild(created.id, node.id);
      this.activate.emit(created.id);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  private defaultStructurePrompt(task: GenerationTaskKind): string {
    if (task === 'title') return 'Generate a concise title for this story.';
    if (task === 'overview') return 'Write an engaging introduction to this story.';
    return 'Generate a concise chapter or section heading for this point in the story.';
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

    // Optional per-task prompt override; otherwise use the built-in default.
    const config = this.generation.get('language-check');
    const instruction = config.prompt.trim() || this.defaultEnglishCheckPrompt();

    this.checkingEnglish.set(true);
    this.englishSuggestions.set(null);
    try {
      const resolved = await this.llmService.resolveForCurrentChat(model);
      const extras = { ...this.llmService.toLlmExtras(resolved), stream: false };
      const result = await this.llmService.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        [{
          role: 'user',
          content: `${instruction}\n\nOriginal direction:\n${text}`
        }],
        false,
        undefined,
        undefined,
        extras,
        model.providerId
      );

      const variants = this.parseEnglishVariants(result.content);
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

  /** Parse the LLM answer into up to 3 suggestion strings. */
  private parseEnglishVariants(content: string): string[] {
    const trimmed = content.trim();
    const fenced = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '');

    const asStrings = (v: unknown): string[] | null => {
      if (Array.isArray(v)) {
        const arr = v.map(x => String(x).trim()).filter(Boolean);
        return arr.length ? arr : null;
      }
      if (v && typeof v === 'object' && Array.isArray((v as { variants?: unknown }).variants)) {
        return asStrings((v as { variants: unknown[] }).variants);
      }
      return null;
    };
    const parse = (raw: string): string[] | null => {
      try {
        return asStrings(JSON.parse(raw));
      } catch {
        return null;
      }
    };

    let arr = parse(fenced) ?? parse(trimmed);
    if (!arr) {
      const match = trimmed.match(/\[[\s\S]*\]/);
      if (match) arr = parse(match[0]);
    }
    if (!arr) {
      arr = fenced
        .split(/\r?\n/)
        .map(s => s.replace(/^[\s\-•·*\d.)]+/, '').trim())
        .filter(Boolean);
    }
    return (arr ?? []).slice(0, 3);
  }

  private defaultEnglishCheckPrompt(): string {
    return `You are a careful copy-editor for writing directions that a user sends to a creative-writing model.

The direction is NOT part of the final story — it is guidance for the model. Your ONLY goal is to make the model understand the user's intent correctly and unambiguously.

Rules:
- Do NOT beautify, embellish or restyle. Keep the author's voice and intent exactly.
- Change only what can cause misunderstanding: grammar, spelling, punctuation, ambiguous wording, unclear referents.
- Keep the direction as short as necessary. Never lengthen it for style.
- Deliberate creative phrasing is fine as long as it is not ambiguous.

Produce EXACTLY 3 variants of the corrected direction:
1. "minimal": closest to the original wording — fix only clear errors (spelling, grammar, punctuation), change as little as possible.
2. "clearer": same intent, reworded for unambiguity, still close to the original.
3. "rewritten": fully restated so it cannot be misunderstood — explicit and clear, preserving the intent.

Return ONLY a JSON array of exactly 3 strings in this order: [minimal, clearer, rewritten].
No text before or after the JSON, no markdown fences.`;
  }

  private static readonly IMAGE_INTERPRET_PROMPT =
`Describe every attached image in detail so a writing model that cannot see images can continue the story correctly. For each image state: what is shown, the setting, characters (appearance, expression, pose), objects, text or signs, mood, colors and composition, and any detail that matters for the next paragraph. Be factual, do not invent plot. If several images are attached, describe them one by one.`;

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

    const modelId = node.modelId || question.modelId || this.resolvePreferredModelId(question);
    const model = this.enabledModels().find(m => m.modelId === modelId || m.id === modelId);
    if (!model) {
      alert(this.i18n.t('node.modelMissing'));
      return;
    }

    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      alert(this.i18n.t('node.providerMissing'));
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
      alert(this.i18n.t('node.regenerateFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
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

    const question = node.parentId
      ? this.chatService.nodes().find(n => n.id === node.parentId)
      : undefined;
    if (!question || question.role !== 'user') {
      alert(this.i18n.t('node.regenerateNoParent'));
      return;
    }

    const modelId = node.modelId || question.modelId || this.resolvePreferredModelId(question);
    const model = this.enabledModels().find(m => m.modelId === modelId || m.id === modelId);
    if (!model) {
      alert(this.i18n.t('node.modelMissing'));
      return;
    }

    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      alert(this.i18n.t('node.providerMissing'));
      return;
    }

    // Following text stays: remember the direct children (roots of the
    // preserved subtree) so they can be hung under the new answer.
    const adoptNodeIds = children.map(c => c.id);

    this.isLoading.set(true);
    this.pendingAction.set('send');
    try {
      await this.chatService.deleteNode(chatId, node.id, { keepChildren: true });
      this.activate.emit(question.id);
      await this.streamForQuestion(
        chatId, question, question.parentId, provider, model,
        adoptNodeIds.length ? { adoptNodeIds } : undefined
      );
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.regenerateFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
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
}
