import { ChatMessage, ChatNode } from '../../models/chat';
import { ModelEntry, canGenerateImages } from '../../models/chat-config';
import { getServerConfig } from '../common/server-config';
import { inject, Injectable } from '@angular/core';
import { ChatService } from '../chat.service';
import { ChatParametersService } from '../chat-parameters.service';
import {
  extractLlmImages,
  extractLlmRefusal,
  normalizeChatMessages,
  type LlmImagePart
} from './llm-message';
import { extractLlmDelta, LlmChunk, readSseStream } from './llm-sse';
import {ChatParameters, ResolvedChatParameters} from '../../models/chat-parameters';
import { ProjectService } from '../project.service';

export type { LlmChunk };

@Injectable({ providedIn: 'root' })
export class LlmService {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly parameters = inject(ChatParametersService);

  async askLlm(
    providerBaseUrl: string,
    apiKey: string,
    modelId: string,
    messages: ChatMessage[],
    stream: boolean | null,
    onChunk?: (chunk: LlmChunk) => void,
    signal?: AbortSignal,
    extras: Record<string, unknown> = {},
    providerId?: string | null
  ): Promise<{ content: string; thinking: string }> {
    const config = getServerConfig();
    const payloadMessages = normalizeChatMessages(messages);
    const useStream = stream !== false && extras['stream'] !== false;
    const { stream: _ignoredStream, ...restExtras } = extras;

    const body =  JSON.stringify({
      model: modelId,
      messages: payloadMessages,
      temperature: restExtras['temperature'] ?? 0.7,
      ...restExtras,
      stream: useStream
    });

    const response =    await fetch(`${config.proxyBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-target-base': providerBaseUrl,
        'HTTP-Referer': 'https://chat-client.local',
        'X-Title': 'Chapterly'
      },
      body: JSON.stringify({
        model: modelId,
        messages: payloadMessages,
        temperature: restExtras['temperature'] ?? 0.7,
        ...restExtras,
        stream: useStream
      }),
      signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${errText}`);
    }
    if (!response.body) {
      throw new Error('No response body');
    }

    try {
      return await this.readCompletion(response, useStream, onChunk);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return { content: '', thinking: '' };
      }
      throw err;
    }
  }

  /**
   * Fire a non-streaming chat-completions call and return the RAW parsed JSON
   * body. Used for image-generation models, whose answer is not plain text but
   * a parts-array (`choices[0].message.content`) carrying `image_url` entries.
   */
  async askLlmJson(
    providerBaseUrl: string,
    apiKey: string,
    modelId: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    extras: Record<string, unknown> = {}
  ): Promise<unknown> {
    const config = getServerConfig();
    const payloadMessages = normalizeChatMessages(messages);
    const body = JSON.stringify({
      model: modelId,
      messages: payloadMessages,
      ...extras,
      stream: false
    });
    const response = await fetch(`${config.proxyBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-target-base': providerBaseUrl,
        'HTTP-Referer': 'https://chat-client.local',
        'X-Title': 'Chapterly'
      },
      body,
      signal
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${errText}`);
    }
    return await response.json();
  }

  /**
   * Generate one or more pictures with an image-output model (text → image).
   * The request goes through the normal /chat/completions proxy so previous
   * chat chapters can be sent as context. Extracts the text reply plus any
   * image parts the model returned.
   */
  async generateImage(
    provider: { baseUrl: string; apiKey: string },
    model: ModelEntry,
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<{ content: string; images: LlmImagePart[] }> {
    const resolved = await this.resolveForCurrentChat(model);
    const extras = this.toLlmExtras(resolved);
    // Image generation is always a single non-streaming completion.
    extras['stream'] = false;
    // Image models reject the generic chat sampling params (OpenAI image
    // models return 400 "Unsupported parameter: 'temperature'") and never take
    // reasoning/thinking columns — strip them all.
    delete extras['temperature'];
    delete extras['top_k'];
    delete extras['top_p'];
    delete extras['include_reasoning'];
    delete extras['reasoning'];

    // OpenAI-style image models (e.g. gpt-image-1) only actually return the
    // picture in chat-completions when the response modality is explicitly
    // requested. Without it they reply 200 with text only (no image). Only
    // add it for models that declare image output; a text-only model must not
    // receive a modalities field it does not understand.
    const wantsModalities = canGenerateImages(model);

    // A provider that hangs must never leave the "Illustrate" button stuck in
    // "Creating…" — combine the optional caller signal with a hard timeout.
    const TIMEOUT_MS = 180_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const forwardAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }

    const call = (withModalities: boolean): Promise<unknown> => {
      if (withModalities) extras['modalities'] = ['text', 'image'];
      else delete extras['modalities'];
      return this.askLlmJson(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        messages,
        controller.signal,
        extras
      );
    };

    let json: unknown;
    try {
      json = await call(wantsModalities);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (controller.signal.aborted) {
        throw new Error(`Image generation timed out after ${TIMEOUT_MS / 1000}s`);
      }
      // Some providers reject the modalities field with a 400. When that is
      // the cause, retry once without it instead of failing the whole action.
      const unsupportedModalities = /modalities/i.test(msg) &&
        /unsupported|invalid|parameter|recognized|unknown/i.test(msg);
      if (unsupportedModalities && extras['modalities']) {
        json = await call(false);
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }

    const images = extractLlmImages(json);
    // A refusal comes back in message.refusal with empty `content` — surface
    // it so the user sees WHY the picture was not drawn.
    let content = extractLlmDelta(json).content.trim();
    if (!content) content = extractLlmRefusal(json);
    if (images.length === 0) {
      // A 200 with no parseable image is usually an unexpected response shape
      // (markdown URL, text-only answer, or a model that didn't generate).
      console.warn(
        '[image-create] model returned no parseable image —',
        summarizeCompletion(json)
      );
    }
    return { content, images };
  }

  private async readCompletion(
    response: Response,
    useStream: boolean,
    onChunk?: (chunk: LlmChunk) => void
  ): Promise<{ content: string; thinking: string }> {
    const contentType = response.headers.get('content-type') || '';
    const looksSse = /text\/event-stream/i.test(contentType);

    if (!useStream && !looksSse) {
      return this.finishNonStream(await response.json(), onChunk);
    }

    if (looksSse || useStream) {
      const assembled = await readSseStream(response.body!, onChunk);
      return {
        content: assembled.content.trim() || (assembled.thinking.trim() ? '' : '(no response)'),
        thinking: assembled.thinking.trim()
      };
    }

    return this.finishNonStream(await response.json(), onChunk);
  }

  private finishNonStream(
    json: unknown,
    onChunk?: (chunk: LlmChunk) => void
  ): { content: string; thinking: string } {
    const assembled = extractLlmDelta(json);
    const content = assembled.content.trim() || (assembled.thinking.trim() ? '' : '(no response)');
    const thinking = assembled.thinking.trim();
    if (onChunk && (content || thinking)) {
      onChunk({ content, thinking });
    }
    return { content, thinking };
  }

  toLlmExtras(resolved: ResolvedChatParameters): Record<string, unknown> {
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


  async streamAnswer(
    chatId: string,
    questionNodeId: string,
    provider: { baseUrl: string; apiKey: string },
    model: ModelEntry,
    messages: ChatMessage[],
    onChunk?: (chunk: LlmChunk) => void,
    opts?: { adoptNodeIds?: string[] }
  ): Promise<ChatNode> {
    const resolved = await this.resolveForCurrentChat(model);
    const extras = {
      ...this.reasoningExtras(model, resolved),
      ...this.toLlmExtras(resolved)
    };

    const payloadMessages = this.withTopicSystemPrompt(chatId, messages);

    const answerNode = await this.chatService.addNode(chatId, {
      parentId: questionNodeId,
      role: 'assistant',
      content: '',
      thinking: '',
      modelId: model.modelId,
      providerId: model.providerId,
      chatParametersId: this.chatService.chats().find(c => c.id === chatId)?.chatParametersId
        || model.chatParametersId
        || undefined
    });

    this.chatService.setActiveChild(questionNodeId, answerNode.id);

    if (opts?.adoptNodeIds?.length) {
      await this.chatService.reparentNodes(chatId, opts.adoptNodeIds, answerNode.id);
      this.chatService.setActiveChild(answerNode.id, opts.adoptNodeIds[0]);
    }

    const signal = this.chatService.startGeneration(answerNode.id);
    let accContent = '';
    let accThinking = '';
    let committed = 0;
    let raf = 0;
    let lastTs = 0;
    let pumpRunning = false;

    const visibleEnd = (): number => {
      const n = accContent.length;
      const rate = this.chatService.streamSpeed();
      if (rate <= 0 || committed >= n) return n;
      if (this.chatService.streamSpeedUnit() === 'char') return committed;
      const tail = accContent.slice(committed).match(/^[ \t\r\n]*[^ \t\r\n]*/);
      return committed + (tail ? tail[0].length : 0);
    };

    const paint = () => {
      const content = accContent.slice(0, visibleEnd());
      this.chatService.updateNodes(list =>
        list.map(n =>
          n.id === answerNode.id
            ? { ...n, content, thinking: accThinking }
            : n
        )
      );
    };

    let llmFinished = false;

    const endOfNextUnit = (from: number): number => {
      if (from >= accContent.length) return from;
      if (this.chatService.streamSpeedUnit() === 'char') return from + 1;
      const m = accContent.slice(from).match(/^[ \t\r\n]*[^ \t\r\n]+[ \t\r\n]+/);
      if (m) return from + m[0].length;
      // Last token has no trailing whitespace until the model is done.
      return llmFinished ? accContent.length : from;
    };

    const flushReveal = () => {
      pumpRunning = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      committed = accContent.length;
      paint();
    };

    let carry = 0;

    const tick = (ts: number) => {
      if (!pumpRunning) return;
      const rate = this.chatService.streamSpeed();
      if (rate <= 0) {
        flushReveal();
        return;
      }

      if (!lastTs) lastTs = ts;
      carry += ((ts - lastTs) / 1000) * rate;
      lastTs = ts;
      if (carry > 8) carry = 8; // tab was in background

      while (carry >= 1 && committed < accContent.length) {
        const next = endOfNextUnit(committed);
        if (next <= committed) break; // partial word; keep carry
        committed = next;
        carry -= 1;
      }

      paint();

      if (committed < accContent.length) {
        raf = requestAnimationFrame(tick);
      } else {
        pumpRunning = false;
        raf = 0;
      }
    };

    const kickPump = () => {
      if (this.chatService.streamSpeed() <= 0) {
        flushReveal();
        return;
      }
      if (pumpRunning) {
        paint();
        return;
      }
      pumpRunning = true;
      lastTs = 0;
      raf = requestAnimationFrame(tick);
    };

    const drainReveal = (): Promise<void> => new Promise(resolve => {
      const finish = () => {
        flushReveal();
        resolve();
      };
      if (
        !this.chatService.paceAfterComplete()
        || this.chatService.streamSpeed() <= 0
        || committed >= accContent.length
        || signal.aborted
      ) {
        finish();
        return;
      }
      const watch = () => {
        if (
          committed >= accContent.length
          || this.chatService.streamSpeed() <= 0
          || !this.chatService.paceAfterComplete()
          || signal.aborted
        ) {
          finish();
          return;
        }
        if (!pumpRunning) kickPump();
        requestAnimationFrame(watch);
      };
      kickPump();
      requestAnimationFrame(watch);
    });

    try {
      const result = await this.askLlm(
        provider.baseUrl,
        provider.apiKey,
        model.modelId,
        payloadMessages,
        resolved.stream,
        chunk => {
          if (chunk.content) accContent += chunk.content;
          if (chunk.thinking) accThinking += chunk.thinking;
          kickPump();
          onChunk?.(chunk);
        },
        signal,
        extras,
        model.providerId
      );

      accContent = result.content;
      accThinking = result.thinking;
      llmFinished = true;
      await drainReveal();

      if (accContent.trim() || accThinking.trim()) {
        const versioned = await this.chatService.editAssistant(
          chatId,
          answerNode.id,
          accContent,
          undefined,
          accThinking
        );
        this.chatService.setActiveChild(questionNodeId, versioned.id);
        return versioned;
      }
      return answerNode;
    } catch {
      flushReveal();
      return answerNode;
    } finally {
      flushReveal();
      // End this single answer without cancelling a running multi-call
      // operation (e.g. the elaborate chain).
      this.chatService.clearGeneration();
      if (this.chatService.alwaysOpenAtLeaf() && (accContent.trim() || accThinking.trim())) {
        const current = this.chatService.getActiveChild(questionNodeId) ?? answerNode;
        await this.chatService.ensureDraftAtLeaf(chatId);
        this.chatService.scrollToNode?.(current.id);
      }
    }
  }

  /**
   * When the thread has no leading system node, inject the topic
   * `defaultSystemPrompt` of the chat's project so ad-hoc chats still
   * inherit the topic voice. Does not persist a system node.
   */
  withTopicSystemPrompt(chatId: string, messages: ChatMessage[]): ChatMessage[] {
    if (messages.some(m => m.role === 'system')) {
      return messages;
    }
    const prompt = this.topicSystemPromptForChat(chatId);
    if (!prompt) return messages;
    return [{ role: 'system', content: prompt }, ...messages];
  }

  private topicSystemPromptForChat(chatId: string): string | null {
    const chat = this.chatService.chats().find(c => c.id === chatId);
    const projectId = chat?.projectId;
    if (!projectId) return null;
    const parts = this.projectService.topics()
      .filter(t => t.projectIds?.includes(projectId) && t.defaultSystemPrompt?.trim())
      .map(t => t.defaultSystemPrompt.trim());
    return parts.length ? parts.join('\n\n') : null;
  }

  private reasoningExtras(
    model: Pick<ModelEntry, 'reasoning' | 'supportedParameters' | 'supported_parameters'>,
    resolved?: ResolvedChatParameters
  ): Record<string, unknown> {
    if (resolved?.thinking === false || resolved?.thinkingLevel === 'none') {
      return {};
    }
    const params = model.supportedParameters ?? model.supported_parameters ?? [];
    const listed = params.some(p => /reasoning|include_reasoning|thinking/i.test(p));
    const meta = model.reasoning;
    if (!listed && !meta && !resolved?.thinking && !resolved?.thinkingLevel) return {};

    const extras: Record<string, unknown> = { include_reasoning: true };
    const effort = resolved?.thinkingLevel
      || meta?.default_effort
      || meta?.supported_efforts?.[0];
    if (effort && effort !== 'none') extras['reasoning'] = { effort };
    else extras['reasoning'] = { enabled: true };
    return extras;
  }

  async resolveForCurrentChat(model: ModelEntry): Promise<ResolvedChatParameters> {
    const chatId = this.chatService.currentChatId();
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
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
}

/**
 * Compact, safe-to-log summary of a chat-completions response, used to
 * diagnose image-generation misses. Never includes full base64 payloads.
 */
function summarizeCompletion(json: unknown): string {
  if (!json || typeof json !== 'object') return String(json);
  const root = json as Record<string, unknown>;
  const keys = Object.keys(root).join(',');
  const choice = Array.isArray(root['choices']) ? root['choices'][0] : undefined;
  const message = (choice && typeof choice === 'object')
    ? (choice as Record<string, unknown>)['message']
    : undefined;
  const content = (message && typeof message === 'object')
    ? (message as Record<string, unknown>)['content']
    : undefined;
  let kind: string;
  if (typeof content === 'string') {
    kind = 'string';
  } else if (Array.isArray(content)) {
    kind = `array[${content.length}](${content.map(p => (p && typeof p === 'object' ? (p as { type?: unknown })['type'] ?? 'part' : typeof p)).join(',')})`;
  } else {
    kind = String(typeof content);
  }
  const snippet = typeof content === 'string' ? JSON.stringify(content.slice(0, 160)) : '';
  return `keys=[${keys}] content=${kind}${snippet ? ` snippet=${snippet}` : ''}`;
}
