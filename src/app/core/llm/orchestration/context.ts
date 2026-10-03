import { inject, Injectable } from '@angular/core';
import { Chat, ChatMessage, ChatNode } from '../../../models/chat';
import { ModelEntry, ProviderConfig } from '../../../models/chat-config';
import { ResolvedChatParameters } from '../../../models/chat-parameters';
import { ChatParametersService } from '../../chat-parameters.service';
import { ChatService } from '../../chat.service';
import { GenerationSettingsService } from '../../generation-settings.service';
import { ProjectService } from '../../project.service';
import { PromptDefaultsService } from '../../prompt-defaults.service';
import { SettingsService } from '../../settings.service';
import { canInterpretImages, canGenerateImages } from '../../../models/chat-config';
import { messageText, nodeToMessageContent, isImageMime, resolvedMime } from '../llm-message';
import type { UsecaseContext, UsecaseVars } from './types';

/**
 * One resolved model + provider pair (rendering or planning role).
 */
export interface ModelRef {
  model: ModelEntry;
  provider: ProviderConfig;
}

export interface BuildContext {
  chat: Chat | null;
  node: ChatNode | null;
  usecase: UsecaseContext['usecase'];
  vars: UsecaseVars;
}

/**
 * LlmUsecaseContextFactory — builds the static use-case context (chat + node
 * + vars), resolves a rendering/planning model and provider, and provides all
 * the MESSAGE / PROMPT building helpers the 5 use cases need. It is the
 * "request builder" of the new layer: it knows templates and context, never
 * the transport or the chat mutation. It reuses existing services only.
 */
@Injectable({ providedIn: 'root' })
export class UsecaseContextFactory {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly parameters = inject(ChatParametersService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly promptDefaults = inject(PromptDefaultsService);

  /** Enabled image-capable models, sorted by display name. */
  private enabledImageModels(): ModelEntry[] {
    return this.settings.enabledModels().filter(canGenerateImages);
  }

  /** Enabled image-INTERPRET models (planner fallback), if any. */
  private enabledInterpretModels(): ModelEntry[] {
    return this.settings.enabledModels().filter(canInterpretImages);
  }

  /** Provider of a model, or null. */
  providerFor(model: ModelEntry | null | undefined): ProviderConfig | null {
    if (!model) return null;
    return this.settings.providers().find(p => p.id === model.providerId) ?? null;
  }

  /**
   * Resolve the WRITING model for a plain text send (`append`): the current
   * node's own model when resolvable, else the first enabled model.
   */
  resolveWriteModel(node: ChatNode | null): ModelRef | null {
    const nodeModelId = node?.modelId;
    let model = nodeModelId
      ? this.settings.enabledModels().find(m => m.modelId === nodeModelId || m.id === nodeModelId)
      : null;
    if (!model) model = this.settings.enabledModels()[0] ?? null;
    if (!model) return null;
    const provider = this.providerFor(model);
    return provider ? { model, provider } : null;
  }

  /**
   * Resolve the RENDERING model: the configured "image-create" task model,
   * falling back to the first enabled image-capable model.
   */
  resolveRenderModel(): ModelRef | null {
    let model = this.generation.modelFor('image-create');
    let provider = this.generation.providerFor('image-create');
    if (!model || !provider) {
      const fallback = this.enabledImageModels()[0] ?? null;
      model = fallback;
      provider = fallback ? this.providerFor(fallback) : null;
    }
    return model && provider ? { model, provider } : null;
  }

  /**
   * Resolve the PLANNING model (text model that derives picture
   * descriptions): 1. the node's own writing model if still resolvable;
   * 2. the image-interpret / language-check task; 3. the rendering model.
   */
  resolvePlanModel(render: ModelRef, node: ChatNode | null): ModelRef {
    const nodeModelId = node?.modelId;
    const nodeModel = nodeModelId
      ? this.settings.enabledModels().find(m => m.modelId === nodeModelId || m.id === nodeModelId)
      : null;
    if (nodeModel && nodeModel.id !== render.model.id) {
      const provider = this.providerFor(nodeModel);
      if (provider) return { model: nodeModel, provider };
    }
    for (const kind of ['image-interpret', 'language-check'] as const) {
      const model = this.generation.modelFor(kind);
      const provider = this.generation.providerFor(kind);
      if (model && provider) return { model, provider };
    }
    return render;
  }

  /** Build a static use-case context from a build request. */
  buildContext(build: BuildContext): UsecaseContext {
    return {
      chat: build.chat as Chat,
      node: build.node as ChatNode,
      usecase: build.usecase,
      vars: build.vars
    };
  }

  /**
   * Resolve the parameters (temperature/thinking/…) + request extras for a
   * model in the CURRENT chat, mirroring the legacy resolution.
   */
  async resolveExtras(model: ModelEntry, chat: Chat | null): Promise<Record<string, unknown>> {
    const resolved = await this.resolveForChat(model, chat);
    const extras = this.toLlmExtras(resolved);
    // Image generation is non-streaming, single completion.
    delete extras['temperature'];
    delete extras['top_k'];
    delete extras['top_p'];
    delete extras['include_reasoning'];
    delete extras['reasoning'];
    return extras;
  }

  /**
   * Resolve FULL text extras (temperature, thinking, stream) for a plain
   * text send (`append`). Keeps everything the legacy text path sends.
   */
  async resolveTextExtras(model: ModelEntry, chat: Chat | null): Promise<Record<string, unknown>> {
    const resolved = await this.resolveForChat(model, chat);
    return this.toLlmExtras(resolved);
  }

  private async resolveForChat(model: ModelEntry, chat: Chat | null): Promise<ResolvedChatParameters> {
    const project = chat?.projectId ? this.projectService.getProject(chat.projectId) ?? null : null;
    const topic = this.projectService.topicForProject(project?.id, this.projectService.topics()) ?? null;
    await this.parameters.loadMany([
      model.chatParametersId,
      topic?.chatParametersId,
      project?.chatParametersId,
      chat?.chatParametersId
    ]);
    return this.parameters.resolveForChat({ model, topic, project, chat });
  }

  /** Port of the legacy toLlmExtras(). */
  private toLlmExtras(resolved: ResolvedChatParameters): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    if (resolved.temperature != null) extras['temperature'] = resolved.temperature;
    if (resolved.topK != null) extras['top_k'] = resolved.topK;
    if (resolved.topM != null) extras['top_p'] = resolved.topM;
    extras['stream'] = resolved.stream ?? true;
    if (resolved.thinking === false) {
      extras['include_reasoning'] = false;
      return extras;
    }
    if (resolved.thinking === true || resolved.thinkingLevel) {
      extras['include_reasoning'] = true;
      if (resolved.thinkingLevel && resolved.thinkingLevel !== 'none') {
        extras['reasoning'] = { effort: resolved.thinkingLevel };
      } else if (resolved.thinkingLevel === 'none') {
        extras['include_reasoning'] = false;
      } else {
        extras['reasoning'] = { enabled: true };
      }
    }
    return extras;
  }

  /** The task prompt (or its built-in default) for the image-create task. */
  drawingInstruction(): string {
    return this.generation.get('image-create').prompt.trim()
      || this.promptDefaults.effective('image.create');
  }

  /** Style-wrapped drawing instruction. */
  styledDrawingInstruction(style: string | undefined): string {
    const base = this.drawingInstruction();
    return style && style.trim()
      ? `${base}\n\nStyle: ${style.trim()}`
      : base;
  }

  /** Topic system prompt for a chat (reuses legacy helper conceptually). */
  topicSystemPrompt(chat: Chat | null): string | null {
    const projectId = chat?.projectId;
    if (!projectId) return null;
    const parts = this.projectService.topics()
      .filter(t => t.projectIds?.includes(projectId) && t.defaultSystemPrompt?.trim())
      .map(t => t.defaultSystemPrompt.trim());
    return parts.length ? parts.join('\n\n') : null;
  }

  /** Context messages up to (and including) the node on the active path. */
  buildContextMessagesUpTo(chatId: string, nodeId: string | null): ChatMessage[] {
    if (!nodeId) return [];
    const path = this.chatService.getPathToNode(nodeId);
    const out: ChatMessage[] = [];
    for (const n of path) {
      if (n.chatId !== chatId) continue;
      if (n.role !== 'system' && n.role !== 'user' && n.role !== 'assistant') continue;
      const content = nodeToMessageContent(n);
      if (!content) continue;
      out.push({ role: n.role, content });
    }
    return out;
  }

  /** Strip media parts → text-only messages (for text planning/rendering). */
  textOnlyMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return m;
      const text = messageText(m).trim();
      return { role: m.role, content: text };
    });
  }

  /**
   * Prior illustrations along the path (used as visual reference when the
   * render model can read images). Keeps only data:/https image URLs.
   */
  priorIllustrations(chatId: string, contextParentId: string | null): NodeAttachmentLike[] {
    if (!contextParentId) return [];
    const path = this.chatService.getPathToNode(contextParentId);
    const out: NodeAttachmentLike[] = [];
    for (const n of path) {
      if (n.chatId !== chatId || n.role !== 'assistant') continue;
      for (const a of n.attachments ?? []) {
        const url = a.dataUrl || '';
        if (isImageMime(resolvedMime(a)) && /^(data:|https?:\/\/)/i.test(url)) out.push(a);
      }
    }
    return out.slice(-4);
  }

  /** The planner instruction (from the image.planning template). */
  picturePlanningInstruction(total: number, extra?: string): string {
    const base = this.promptDefaults.render('image.planning', { total });
    return extra?.trim() ? `${base}\n\nRules that apply to every picture:\n${extra.trim()}` : base;
  }

  /**
   * The FULL chat up to (and including) the current node as normal messages,
   * with the current node's text as the final USER message. Used by the
   * `append` use case (normal send + history). When `contentOverride` is
   * given (e.g. a composer draft), it replaces the current node's content.
   * The final node is ALWAYS included (even when empty, the override or an
   * empty user turn is still the question being answered).
   */
  buildSendMessages(chatId: string, nodeId: string | null, contentOverride?: string): ChatMessage[] {
    if (!nodeId) return [];
    const path = this.chatService.getPathToNode(nodeId);
    const out: ChatMessage[] = [];
    // All nodes EXCEPT the final one — Empties are dropped (they add no
    // signal to the LLM context), mirroring nodeToMessageContent's pruning.
    for (let i = 0; i < path.length - 1; i++) {
      const n = path[i];
      if (n.chatId !== chatId) continue;
      if (n.role !== 'system' && n.role !== 'user' && n.role !== 'assistant') continue;
      const content = nodeToMessageContent(n);
      if (!content) continue;
      out.push({ role: n.role, content });
    }
    // The final node is the question — always included.
    const last = path[path.length - 1];
    if (last && last.chatId === chatId) {
      const finalText = (contentOverride ?? last.content ?? '').trim();
      // An empty director is still a valid user turn (the model sees it and
      // answers from history), but as a bare user message.
      const user: ChatMessage = { role: 'user', content: finalText || '(no text)' };
      out.push(user);
    }
    return out;
  }

  /** The one-shot storyboard prompt (from the image.one-shot template). */
  oneShotStoryboardPrompt(basePrompt: string, descriptions: string[], total: number, extra?: string): string {
    let text = basePrompt ? `${basePrompt}\n\n` : '';
    text += this.promptDefaults.render('image.one-shot', { total });
    if (descriptions.length > 0) {
      text += `\n\nThe exact scenes to render (one image per scene, in this order):\n`;
      descriptions.forEach((p, i) => { text += `${i + 1}. ${p}\n`; });
    }
    if (extra?.trim()) text += `\n\nAdditional storyboard rules for every picture:\n${extra.trim()}`;
    return text;
  }

  /** The pure-picture en-block prompt (from the image.pure template). */
  purePicturesPrompt(sceneInstruction: string, descriptions: string[], total: number, extra?: string): string {
    let text = sceneInstruction ? `${sceneInstruction}\n\n` : '';
    const numbered = descriptions
      .map((d, i) => `${i + 1}. ${d.trim()}`)
      .join('\n') + (descriptions.length ? '\n' : '');
    text += this.promptDefaults.render('image.pure', { total, descriptions: numbered });
    if (extra?.trim()) text += `\n\nAdditional rules for every picture:\n${extra.trim()}`;
    return text;
  }

  /** Per-scene storyboard instruction (from the image.storyboard template). */
  storyboardInstruction(index: number, total: number, extra?: string): string {
    const base = this.promptDefaults.render('image.storyboard', { index: index + 1, total });
    return extra?.trim() ? `${base}\n\nRules for every picture:\n${extra.trim()}` : base;
  }
}

/** Small structural alias so callers don't depend on NodeAttachment directly. */
export type NodeAttachmentLike = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

export type { ChatNode }; // re-export for convenience