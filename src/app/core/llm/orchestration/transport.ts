import { inject, Injectable } from '@angular/core';
import { ChatMessage } from '../../../models/chat';
import { canGenerateImages, ModelEntry } from '../../../models/chat-config';
import { getServerConfig } from '../../common/server-config';
import { LlmLogService } from '../llm-log.service';
import { normalizeChatMessages, type MessagePart } from '../llm-message';
import { readSseStream, type LlmChunk } from '../llm-sse';

/**
 * ONE image-generation attempt hard timeout — a provider that hangs must
 * never leave the UI stuck in "Creating…". (Same safety as the legacy path.)
 */
const TIMEOUT_MS = 120_000_000;

export interface ProviderRef {
  baseUrl: string;
  apiKey: string;
}

export interface CompletionRequest {
  provider: ProviderRef;
  model: ModelEntry;
  messages: ChatMessage[];
  /** Extra request params (temperature, thinking, stream, modalities, …). */
  extras?: Record<string, unknown>;
  /** True for image-generating completions (modalities + fallbacks). */
  imageCapable?: boolean;
  /** When imageCapable, force `modalities: ['image']` (route-fallback). */
  imageOnlyModalities?: boolean;
  signal?: AbortSignal;
  /** Streaming callback — raw chunks, unpaced (pacing is a view concern). */
  onChunk?: (chunk: LlmChunk) => void;
  /** Chat attribution for the log. */
  chat?: { id?: string; title?: string; usecase?: string };
  /** Per-attempt timeout in ms (default TIMEOUT_MS). */
  timeoutMs?: number;
}

export interface ImagesRequest {
  provider: ProviderRef;
  model: ModelEntry;
  prompt: string;
  n?: number;
  signal?: AbortSignal;
  chat?: { id?: string; title?: string; usecase?: string };
  timeoutMs?: number;
}

export interface CompletionResult {
  /** Raw JSON body (for non-stream image calls; for streams a lookalike). */
  raw?: unknown;
  /** Assembled text for streaming calls ('' when non-stream). */
  content: string;
  thinking: string;
}

export interface ImagesResult {
  /** Raw OpenAI-Images JSON body. */
  raw: unknown;
}

/** Typed transport error — the evaluator turns this into slot statuses. */
export interface TransportError {
  status: number;
  text: string;
  aborted?: boolean;
}

function defaultModalities(model: ModelEntry): string[] {
  const declared = model.architecture?.output_modalities ?? [];
  return declared.includes('text') ? ['text', 'image'] : ['image'];
}

/**
 * LlmTransport — PURE transport: sends requests to the completion or images
 * endpoint, maintains the log (LlmLogService), and handles EVERY retry that
 * is a transport concern:
 *   1. `modalities` field rejected          → retry chat completion w/o it
 *   2. OpenRouter modality-route 404        → retry asking for ['image'] only
 *   3. model served ONLY on /images         → retry via the images endpoint
 *   4. context-length overflow              → retry via the images endpoint
 *
 * It knows NOTHING about use cases, slots, or the chat — that is the
 * evaluators'/orchestrator's job. It NEVER throws a generation "result": a
 * failure is thrown as a TransportError for the evaluator to slot-ify.
 */
@Injectable({ providedIn: 'root' })
export class LlmTransportService {
  private readonly llmLog = inject(LlmLogService);

  /**
   * One raw chat-completions call (stream or non-stream). Returns parsed JSON
   * for non-stream, or a `{choices:[{message:{content}}]}` lookalike for
   * stream (an evaluator-friendly shape). Throws TransportError on any
   * failure. Streaming fires `onChunk` per raw SSE chunk.
   */
  private async rawCompletion(req: CompletionRequest): Promise<CompletionResult> {
    const config = getServerConfig();
    const payloadMessages = normalizeChatMessages([...req.messages]);
    const stream = req.extras?.['stream'] !== false;
    const payload: Record<string, unknown> = {
      model: req.model.modelId,
      messages: payloadMessages,
      ...req.extras,
    };
    if (req.imageCapable) payload['modalities'] = req.imageOnlyModalities ? ['image'] : defaultModalities(req.model);
    payload['stream'] = stream;

    const logEntry = this.llmLog.record({
      kind: 'chat',
      modelId: req.model.modelId,
      provider: req.provider.baseUrl,
      chatId: req.chat?.id,
      chatTitle: req.chat?.title,
      usecase: req.chat?.usecase,
      endpoint: 'chat/completions',
      messages: payloadMessages.map(m => ({ role: m.role, content: m.content })),
      body: payload,
      extras: { ...(req.extras ?? {}), ...(req.imageCapable ? { modalities: payload['modalities'] } : {}) }
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? TIMEOUT_MS);
    const forwardAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const response = await fetch(`${config.proxyBase}/chat/completions`, {
        method: 'POST',
        headers: this.headers(req.provider.apiKey, req.provider.baseUrl),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        this.llmLog.complete(logEntry, { error: { status: response.status, text } });
        throw { status: response.status, text, aborted: controller.signal.aborted } as TransportError;
      }

      if (stream) {
        // Only the STREAMING path needs a readable body.
        if (!response.body) {
          const err: TransportError = { status: 0, text: 'No response body', aborted: controller.signal.aborted };
          this.llmLog.complete(logEntry, { error: { status: 0, text: err.text } });
          throw err;
        }
        const assembled = await readSseStream(response.body, req.onChunk).then(r => ({
          content: r.content.trim(),
          thinking: r.thinking.trim()
        }));
        this.llmLog.complete(logEntry, { response: assembled });
        const raw = { choices: [{ message: { role: 'assistant', content: assembled.content } }] };
        return { content: assembled.content, thinking: assembled.thinking, raw };
      }

      const raw = await response.json();
      this.llmLog.complete(logEntry, { response: raw });
      return { content: '', thinking: '', raw };
    } catch (err: any) {
      if ((err as TransportError).status !== undefined) throw err;
      const aborting = controller.signal.aborted;
      const tErr: TransportError = {
        status: 0,
        text: aborting
          ? (req.signal?.aborted ? 'aborted' : `timed out after ${(req.timeoutMs ?? TIMEOUT_MS) / 1000}s`)
          : String(err?.message ?? err),
        aborted: aborting
      };
      if (!logEntry.completed) {
        this.llmLog.complete(logEntry, { error: { status: 0, text: tErr.text } });
      }
      throw tErr;
    } finally {
      clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * One IMAGE-capable completion attempt WITH the graceful fallback tree.
   * Returns the raw JSON body for the evaluator.
   */
  private async imageCallOnce(req: CompletionRequest): Promise<unknown> {
    const run = (r: CompletionRequest): Promise<unknown> => this.rawCompletion(r).then(res => res.raw);
    try {
      return await run({ ...req, imageCapable: true });
    } catch (err: any) {
      const tErr = err as TransportError;
      const msg = String(tErr?.text ?? err?.message ?? err);

      // 1. Some providers reject the modalities field → retry once without it.
      if (/modalities/i.test(msg) && /unsupported|invalid|parameter|recognized|unknown/i.test(msg)) {
        return await run({ ...req, imageCapable: false });
      }
      // 2. OpenRouter route filter: asked text+image but only image is served.
      const wantsText = !!(req.model.architecture?.output_modalities ?? []).includes('text');
      if (wantsText && /No endpoints found that support the requested output modalit/i.test(msg)) {
        return await run({ ...req, imageOnlyModalities: true });
      }
      // 3. Model served ONLY on /images; 4. context overflow.
      if (this.shouldRouteToImages(msg)) {
        const prompt = lastUserPromptText(req.messages);
        if (prompt.trim()) {
          return await this.images({
            provider: req.provider,
            model: req.model,
            prompt,
            signal: req.signal,
            chat: req.chat,
            timeoutMs: req.timeoutMs
          }).then(r => r.raw);
        }
      }
      throw tErr;
    }
  }

  /**
   * IMAGE-GENERATING chat completion (single image / en-block / per-scene):
   * request body with modalities + the transport fallback tree. Returns the
   * raw JSON body so the evaluator can extract images.
   */
  async completeImage(req: Omit<CompletionRequest, 'imageCapable'>): Promise<unknown> {
    return this.imageCallOnce({
      ...req,
      imageCapable: true,
      extras: { ...req.extras, stream: false }
    });
  }

  /**
   * Plain chat completion (text use cases + the planning pass). Streams when
   * `req.extras.stream` is not false, firing `onChunk` live. Returns a
   * CompletionResult (raw + assembled text/thinking).
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    return this.rawCompletion({ ...req, imageCapable: false });
  }

  /** OpenRouter-Images endpoint: `{ model, prompt, n }`. Returns raw JSON. */
  async images(req: ImagesRequest): Promise<ImagesResult> {
    const config = getServerConfig();
    const payload = {
      model: req.model.modelId,
      prompt: req.prompt,
      ...(req.n && req.n > 1 ? { n: req.n } : {})
    };
    const logEntry = this.llmLog.record({
      kind: 'image',
      modelId: req.model.modelId,
      provider: req.provider.baseUrl,
      chatId: req.chat?.id,
      chatTitle: req.chat?.title,
      usecase: req.chat?.usecase,
      endpoint: 'images',
      prompt: req.prompt,
      body: payload,
      extras: req.n && req.n > 1 ? { n: req.n } : {}
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? TIMEOUT_MS);
    const forwardAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const response = await fetch(`${config.proxyBase}/images`, {
        method: 'POST',
        headers: this.headers(req.provider.apiKey, req.provider.baseUrl),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        this.llmLog.complete(logEntry, { error: { status: response.status, text } });
        throw { status: response.status, text, aborted: controller.signal.aborted } as TransportError;
      }
      const raw = await response.json();
      this.llmLog.complete(logEntry, { response: raw });
      return { raw };
    } catch (err: any) {
      if ((err as TransportError).status !== undefined) throw err;
      const aborting = controller.signal.aborted;
      const tErr: TransportError = {
        status: 0,
        text: aborting
          ? (req.signal?.aborted ? 'aborted' : `timed out after ${(req.timeoutMs ?? TIMEOUT_MS) / 1000}s`)
          : String(err?.message ?? err),
        aborted: aborting
      };
      if (!logEntry.completed) {
        this.llmLog.complete(logEntry, { error: { status: 0, text: tErr.text } });
      }
      throw tErr;
    } finally {
      clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener('abort', forwardAbort);
    }
  }

  private headers(apiKey: string, baseUrl: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-target-base': baseUrl,
      'HTTP-Referer': 'https://chat-client.local',
      'X-Title': 'Chapterly'
    };
  }

  private shouldRouteToImages(text: string): boolean {
    return (
      /cannot be used with the chat\/completions endpoint|use the \/api\/v1\/images endpoint|images endpoint instead/i.test(text)
      || /maximum context length|context length is|reduce the length|requested about \d+ tokens|too many tokens/i.test(text)
    );
  }
}

/** The exact last user-prompt text (used to record exact prompts). */
export function lastUserPromptText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = (m.content as MessagePart[])
        .filter(p => p.type === 'text' && p.text)
        .map(p => (p as { text: string }).text)
        .join('\n\n');
      if (text.trim()) return text;
    }
  }
  return '';
}

export const canExtractImage = canGenerateImages;