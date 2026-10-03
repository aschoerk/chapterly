import { inject, Injectable } from '@angular/core';
import type { LlmChunk } from '../llm-sse';
import { evaluateCompletion, evaluateDescriptions, evaluateImagesResponse, foldStreamChunk, finalizeStream } from './evaluators';
import { LlmTransportService, type CompletionRequest, type CompletionResult, type ProviderRef } from './transport';
import { refusedSlot } from './slots';
import type { ChatMessage } from '../../../models/chat';
import type { ModelEntry } from '../../../models/chat-config';
import type { EvalSlots, LlmImagePart, UsecaseContext } from './types';

/** One primitive request (a sub-slice of a RequestIntent). */
export interface PrimitiveRequest {
  readonly model: ModelEntry;
  readonly provider: ProviderRef;
  readonly messages: ChatMessage[];
  readonly extras?: Record<string, unknown>;
  readonly stream?: boolean;
}

/** What one primitive call needs besides the transport request. */
export interface PrimitiveOptions {
  /** Expected slot kind, decides which evaluator runs. */
  expect: 'text' | 'images' | 'descriptions';
  /** The exact prompt sent (kept as provenance on image slots). */
  prompt?: string;
  /** 1-based scene number (kept as provenance on slots). */
  scene?: number;
  /** Streaming callback — raw chunks get folded into partial slots. */
  onChunk?: (chunk: LlmChunk) => void;
  /** Caller signal (abort propagates to the whole tree). */
  signal?: AbortSignal;
}

/**
 * LlmOrchestrator — the SHARED PRIMITIVES class. It has NO use-case logic
 * (no storyboard branches, no fallback decisions). It exposes two low-level
 * operations—`completion()` and `images()`—that call the transport and turn
 * the outcome into EvalSlots. Use cases (plain async functions) use these to
 * script their flow; they read the slots to decide continuations.
 */
@Injectable({ providedIn: 'root' })
export class LlmOrchestratorService {
  private readonly transport = inject(LlmTransportService);

  /** Chat attribution slice for the log. */
  private chatRef(cx: Pick<UsecaseContext, 'chat'>): { id: string; title: string | undefined } | undefined {
    return cx?.chat ? { id: cx.chat.id, title: cx.chat.title } : undefined;
  }

  /**
   * One chat-completion call (text use cases + the planning pass).
   * For streaming (`expect: 'text'`) folds chunks into partial slots and
   * finalizes them; for non-stream fills text/images/descriptions from the
   * raw JSON. NEVER throws a generation result — failures become slots.
   */
  async completion(
    cx: Pick<UsecaseContext, 'chat'>,
    req: PrimitiveRequest,
    opts: PrimitiveOptions
  ): Promise<EvalSlots> {
    const runReq: CompletionRequest = {
      provider: req.provider,
      model: req.model,
      messages: req.messages,
      extras: { ...(req.extras ?? {}), stream: req.stream ?? false },
      onChunk: opts.onChunk,
      signal: opts.signal,
      chat: this.chatRef(cx)
    };

    if (opts.expect === 'text' && (req.stream !== false)) {
      // Streaming: fold chunks, then finalize.
      let running: EvalSlots = {};
      const result: CompletionResult = await this.transport.complete({
        ...runReq,
        onChunk: chunk => {
          running = foldStreamChunk(running, chunk);
          opts.onChunk?.(chunk);
        }
      });
      return finalizeStream(running, { raw: result.raw, prompt: opts.prompt, scene: opts.scene });
    }

    const result = await this.transport.complete(runReq);
    if (opts.expect === 'text') {
      return finalizeStream({}, { raw: result.raw, prompt: opts.prompt, scene: opts.scene });
    }
    if (opts.expect === 'descriptions') {
      return evaluateDescriptions({ raw: result.raw, prompt: opts.prompt, scene: opts.scene });
    }
    return evaluateCompletion({ raw: result.raw, prompt: opts.prompt, scene: opts.scene });
  }

  /**
   * One IMAGE-GENERATING completion call (single image / en-block / per
   * scene). Picks the images-vs-text evaluator by `expect`. NEVER throws —
   * failures become `images` refused / `error` slots.
   */
  async completeImage(
    cx: Pick<UsecaseContext, 'chat'>,
    req: PrimitiveRequest,
    opts: PrimitiveOptions
  ): Promise<EvalSlots> {
    const runReq: CompletionRequest = {
      provider: req.provider,
      model: req.model,
      messages: req.messages,
      extras: req.extras,
      signal: opts.signal,
      chat: this.chatRef(cx)
    };
    try {
      const raw = await this.transport.completeImage(runReq);
      if (opts.expect === 'images') {
        return evaluateImagesResponse({ raw, prompt: opts.prompt, scene: opts.scene });
      }
      return evaluateCompletion({ raw, prompt: opts.prompt, scene: opts.scene });
    } catch (err: any) {
      return {
        images: refusedSlot<LlmImagePart[]>(String(err?.text ?? err?.message ?? err), { prompt: opts.prompt, scene: opts.scene })
      };
    }
  }

  /**
   * One OpenRouter-Images endpoint call. Same slot contract.
   */
  async images(
    cx: Pick<UsecaseContext, 'chat'>,
    req: { model: ModelEntry; provider: ProviderRef; prompt: string; n?: number },
    opts: PrimitiveOptions
  ): Promise<EvalSlots> {
    try {
      const raw = await this.transport.images({
        provider: req.provider,
        model: req.model,
        prompt: req.prompt,
        n: req.n,
        signal: opts.signal,
        chat: this.chatRef(cx)
      });
      return evaluateImagesResponse({ raw: raw.raw, prompt: req.prompt, scene: opts.scene });
    } catch (err: any) {
      return {
        images: refusedSlot<LlmImagePart[]>(String(err?.text ?? err?.message ?? err), { prompt: req.prompt, scene: opts.scene })
      };
    }
  }
}