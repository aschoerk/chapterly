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
import { LlmLogService } from './llm-log.service';

export type { LlmChunk };

/**
 * Hard timeout for ONE image-generation attempt (and the optional
 * picture-description planning call) — a provider that hangs must never leave
 * the "Illustrate" button stuck in "Creating…".
 */
const TIMEOUT_MS = 120_000_000;

/**
 * Per-scene result of an image-generation call. `prompt` is the exact text
 * that was sent for that scene, so it can be stored next to the produced
 * image — and preserved for refused/empty scenes too.
 */
export interface GeneratedImageScene {
  /** 1-based scene number (used for the companion prompt file name). */
  scene: number;
  /** The exact prompt text sent for this scene. */
  prompt: string;
  /** Images produced by this scene (empty when refused/errored). */
  images: LlmImagePart[];
  /** Text reply (e.g. a refusal) when no image came back. */
  content?: string;
  /** True when this scene produced no image. */
  refused: boolean;
}

/** Result of `LlmService.generateImage` (flat convenience + per-scene detail). */
export interface GenerateImagesResult {
  content: string;
  images: LlmImagePart[];
  scenes: GeneratedImageScene[];
}

@Injectable({ providedIn: 'root' })
export class LlmService {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly parameters = inject(ChatParametersService);
  private readonly llmLog = inject(LlmLogService);

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

    // The EXACT payload that will be sent to the provider — reconstructed
    // once, used for fetch AND stored verbatim in the log so the full last
    // message and the rest of the JSON are never lost.
    const payload = {
      model: modelId,
      messages: payloadMessages,
      temperature: restExtras['temperature'] ?? 0.7,
      ...restExtras,
      stream: useStream
    };

    // Log full request (message count + first/last preview on console; the
    // FULL request body including every message is kept in the log buffer).
    const logEntry = this.llmLog.record({
      kind: 'chat',
      modelId,
      provider: providerBaseUrl,
      endpoint: 'chat/completions',
      messages: payloadMessages.map(m => ({ role: m.role, content: m.content })),
      body: payload,
      extras: restExtras
    });

    const body = JSON.stringify(payload);

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
      this.llmLog.complete(logEntry, { error: { status: response.status, text: errText } });
      throw new Error(`LLM request failed: ${response.status} ${errText}`);
    }
    if (!response.body) {
      throw new Error('No response body');
    }

    try {
      const read = await this.readCompletion(response, useStream, onChunk);
      this.llmLog.complete(logEntry, { response: read });
      return read;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.llmLog.complete(logEntry, {
          error: { status: 0, text: 'aborted' }
        });
        return { content: '', thinking: '' };
      }
      this.llmLog.complete(logEntry, {
        error: { status: 0, text: String(err?.message ?? err) }
      });
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

    const payload = {
      model: modelId,
      messages: payloadMessages,
      ...extras,
      stream: false
    };

    const logEntry = this.llmLog.record({
      kind: 'chat',
      modelId,
      provider: providerBaseUrl,
      endpoint: 'chat/completions',
      messages: payloadMessages.map(m => ({ role: m.role, content: m.content })),
      body: payload,
      extras
    });

    const body = JSON.stringify(payload);
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
      this.llmLog.complete(logEntry, { error: { status: response.status, text: errText } });
      throw new Error(`LLM request failed: ${response.status} ${errText}`);
    }
    const json = await response.json();
    this.llmLog.complete(logEntry, { response: json });
    return json;
  }

  /**
   * Generate pictures through the OpenAI-style IMAGES endpoint
   * (`POST {base}/images`) instead of chat/completions.
   *
   * OpenRouter serves image-generation-only models (e.g. qwen-image-3,
   * some flux/grok variants) EXCLUSIVELY on `/images` — they reject
   * chat/completions with 404 "…cannot be used with the chat/completions
   * endpoint. Use the /api/v1/images endpoint instead." When generateImage
   * meets that, it retries the same scene here.
   *
   * Request is `{ model, prompt, n }`; the response is the OpenAI Images
   * shape (`data[]` with `b64_json`/`url`), which `extractLlmImages` already
   * parses. Prior multi-modal context / reference images cannot be forwarded
   * to this endpoint — only the single scene prompt goes.
   */
  private async askImages(
    providerBaseUrl: string,
    apiKey: string,
    modelId: string,
    prompt: string,
    n?: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const config = getServerConfig();
    const payload = {
      model: modelId,
      prompt,
      ...(n && n > 1 ? { n } : {})
    };
    const body = JSON.stringify(payload);

    const logEntry = this.llmLog.record({
      kind: 'image',
      modelId,
      provider: providerBaseUrl,
      endpoint: 'images',
      prompt,
      body: payload,
      extras: n && n > 1 ? { n } : {}
    });

    const response = await fetch(`${config.proxyBase}/images`, {
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
      this.llmLog.complete(logEntry, { error: { status: response.status, text: errText } });
      throw new Error(`Image generation failed: ${response.status} ${errText}`);
    }
    const json = await response.json();
    this.llmLog.complete(logEntry, { response: json });
    return json;
  }

  /**
   * Generate one or more pictures with an image-output model (text → image).
   * The request goes through the normal /chat/completions proxy so previous
   * chat chapters can be sent as context.
   *
   * `count` > 1 switches to "storyboard" mode: the model is called per scene
   * (each call gets a distinct-scene instruction plus the shared style/context
   * messages and the optional `storyboardPrompt`) until `count` images have
   * been collected. Some providers return several image parts in a single
   * completion, in which case we stop early.
   *
   * Each attempted scene is returned in `scenes` with the EXACT prompt that
   * was sent for it, the images it produced (possibly empty), and whether it
   * was refused — so the caller can attach the prompt next to each image and
   * preserve the prompt of refused images too.
   *
   * Partial results: if the last scene(s) fail after at least one image was
   * produced, the collected images are returned (the caller decides how to
   * surface that). If nothing was produced the error is rethrown.
   */
  async generateImage(
    provider: { baseUrl: string; apiKey: string },
    model: ModelEntry,
    messages: ChatMessage[],
    signal?: AbortSignal,
    opts?: {
      count?: number;
      /** Extra instruction appended in storyboard mode (count>1). */
      storyboardPrompt?: string;
      /**
       * Storyboard mode: run a planning pass first that turns the story into
       * `count` concrete picture descriptions, then render each image from its
       * description instead of making the model pick a scene from the prose.
       * Best-effort — falls back to the generic scene instruction per scene
       * when the planning call fails or returns nothing usable.
       */
      planDescriptions?: boolean;
      /**
       * The "how to draw" instruction (image-create task prompt + optional
       * style) that heads every scene prompt. When the planning pass has
       * produced a concrete scene description, the actual prompt sent and
       * recorded is this instruction + the description — NOT the raw story
       * anchor text (which, for an assistant chapter, is the whole chapter
       * verbatim and makes a terrible picture cue). Falls back to the anchor
       * text when no sceneInstruction is given.
       */
      sceneInstruction?: string;
      /**
       * Model/provider used for the optional picture-description planning
       * pass. Defaults to the rendering (image) model — pass a capable TEXT
       * model here: image models are unreliable at following the strict JSON
       * / still-frame planning instructions.
       */
      planner?: { model: ModelEntry; provider: { baseUrl: string; apiKey: string } } | null;
      /**
       * Storyboard mode: generate ALL pictures in a SINGLE completion instead
       * of one call per scene. Keeping every image in one request lets the
       * model keep characters/faces/figures/environment/style consistent
       * across the whole storyboard (per-scene calls make each image start
       * from scratch). Only works when the model returns multiple image parts
       * per response (OpenAI gpt-image-1, some OpenRouter/Gemini image
       * models); when it returns fewer than `count` images, generateImage
       * automatically falls back to per-scene calls.
       */
      singleCall?: boolean;
      /**
       * Pure picture mode: only the derived, temporal-free picture
       * descriptions (plus the consistency rules) are sent to the image model
       * — never the raw story prose. Image models are less tolerant of
       * sensitive story content than text models, so stripping the temporal
       * context lowers moderation rejects. The descriptions are requested
       * EN-BLOCK first so the image model itself keeps characters / setting /
       * style consistent across all pictures; if it returns fewer than
       * `count` images, generateImage falls back to per-scene calls (each
       * scene driven by its description). Best-effort — if the planning pass
       * yields no usable descriptions it degrades to the anchor text.
       */
      purePictures?: boolean;
      onProgress?: (done: number, total: number) => void;
    }
  ): Promise<GenerateImagesResult> {
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
    //
    // IMPORTANT (OpenRouter): the requested output modalities are used to
    // FILTER routes — OpenRouter fails with 404 "No endpoints found that
    // support the requested output modalities: text, image" when the model's
    // endpoints can't serve the whole requested set. Image-only models fetched
    // from the Image API catalog (e.g. x-ai/grok-imagine-image-2.0,
    // output_modalities: ['image']) have NO text output, so asking for
    // ['text','image'] finds no endpoint. Request 'text' as well only when the
    // model actually declares text output — otherwise ask for ['image'] only.
    const declaredOutput = model.architecture?.output_modalities ?? [];
    const requestModalities =
      declaredOutput.includes('text') ? ['text', 'image'] : ['image'];
    const wantsModalities = canGenerateImages(model);

    /** One completion attempt (with modalities + graceful fallback). */
    const callOnce = async (msgs: ChatMessage[], signal_: AbortSignal): Promise<unknown> => {
      try {
        return await this.askLlmJson(
          provider.baseUrl,
          provider.apiKey,
          model.modelId,
          msgs,
          signal_,
          wantsModalities
            ? { ...extras, modalities: requestModalities }
            : extras
        );
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        // Some providers reject the modalities field with a 400. When that is
        // the cause, retry once without it instead of failing the whole action.
        const unsupportedModalities = /modalities/i.test(msg) &&
          /unsupported|invalid|parameter|recognized|unknown/i.test(msg);
        if (unsupportedModalities && wantsModalities) {
          return await this.askLlmJson(
            provider.baseUrl,
            provider.apiKey,
            model.modelId,
            msgs,
            signal_,
            extras
          );
        }
        // OpenRouter filters routes by the requested output modalities and
        // returns 404 "No endpoints found …" when the model's endpoints can't
        // serve the requested set (e.g. text+image when only image is served).
        // When we over-requested (asked for text), retry once with image only.
        const routingModalFail = wantsModalities &&
          requestModalities.includes('text') &&
          /No endpoints found that support the requested output modalit/i.test(msg);
        if (routingModalFail) {
          return await this.askLlmJson(
            provider.baseUrl,
            provider.apiKey,
            model.modelId,
            msgs,
            signal_,
            { ...extras, modalities: ['image'] }
          );
        }
        // Some image-generation models (OpenRouter: e.g. qwen-image-3) are
        // served ONLY by the `/images` endpoint and reject chat/completions
        // with a 404 telling us exactly that. Retry the same scene/prompt
        // through the images endpoint (returns OpenAI-Images data[] shape).
        const imagesOnlyModel = wantsModalities &&
          /cannot be used with the chat\/completions endpoint|use the \/api\/v1\/images endpoint|images endpoint instead/i.test(msg);
        if (imagesOnlyModel) {
          const prompt = lastUserPromptText(msgs);
          if (prompt.trim()) {
            return await this.askImages(
              provider.baseUrl,
              provider.apiKey,
              model.modelId,
              prompt,
              undefined,
              signal_
            );
          }
        }
        throw err;
      }
    };

    // A provider that hangs must never leave the "Illustrate" button stuck in
    // "Creating…" — each scene gets a hard timeout (combined with any caller
    // signal).
    const total = Math.max(1, Math.min(64, Math.floor(opts?.count ?? 1)));
    // The exact prompt for a scene = the base prompt the caller already put in
    // `messages` (the last user message, the anchor/direction) + the per-scene
    // storyboard instruction when count > 1. This is what we record next to
    // each image (or in a refused-prompt file).
    const basePrompt = lastUserPromptText(messages);
    // Optional planning pass: derive a concrete picture description per scene
    // first, so each image is rendered from a visual description rather than
    // from the raw story prose (an assistant chapter is a long prose block —
    // not a picture cue). Best-effort — a `null` entry (or a short array)
    // makes `scenePrompt` fall back to the anchor text for that scene.
    const scenePrompts = opts?.planDescriptions
      ? await this.planStoryboardDescriptions(
          provider, model, messages, total, signal, opts?.storyboardPrompt, opts?.planner)
      : [];
    const scenePrompt = (i: number): string => {
      const planned = i < scenePrompts.length ? scenePrompts[i] : null;
      if (planned?.trim()) {
        const desc = planned.trim();
        // Drive the prompt from the derived scene description + the drawing
        // instruction. Do NOT re-dump the raw anchor text: when illustrating
        // an assistant chapter the anchor IS the full chapter.
        const base = (opts?.sceneInstruction ?? '').trim() || basePrompt;
        return base
          ? `${base}\n\nRender exactly this picture description (it overrides any scene cue above):\n${desc}`
          : desc;
      }
      const instruction = total > 1
        ? storyboardInstruction(i, total, opts?.storyboardPrompt)
        : '';
      // In pure picture mode never fall back to the raw anchor (it can carry
      // moderation-triggering prose) — use the drawing instruction alone when
      // no description was derived.
      const fallbackBase = opts?.purePictures
        ? (opts?.sceneInstruction ?? '').trim() || ''
        : basePrompt;
      return instruction
        ? `${fallbackBase ? fallbackBase + '\n\n' : ''}${instruction}`
        : fallbackBase || basePrompt;
    };

    // ------------------------------------------------------------------
    // One-shot storyboard: ask for ALL pictures in a SINGLE completion so
    // characters / faces / figures / environment / lighting / style stay
    // consistent across the whole storyboard. Only useful when the model
    // returns several image parts in one response (OpenAI gpt-image-1,
    // some OpenRouter / Gemini image models); otherwise we silently fall
    // back to the per-scene loop below. Skipped in pure picture mode — the
    // pure en-block path below replaces it (and never exposes raw prose).
    // ------------------------------------------------------------------
    if (!opts?.purePictures && opts?.singleCall && total > 1) {
      const oneShotPrompt = oneShotStoryboardPrompt(
        basePrompt, scenePrompts, total, opts?.storyboardPrompt
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const forwardAbort = (): void => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', forwardAbort, { once: true });
      }
      try {
        const json = await callOnce(
          [...messages, { role: 'user' as const, content: oneShotPrompt }],
          controller.signal
        );
        const imgs = extractLlmImages(json);
        if (imgs.length >= total) {
          // The full storyboard came back in one go — record it as a single
          // scene (one prompt file + illustration-1..N) and stop.
          const content = extractLlmDelta(json).content.trim() || extractLlmRefusal(json);
          opts?.onProgress?.(total, total);
          return {
            content,
            images: imgs,
            scenes: [{
              scene: 1,
              prompt: oneShotPrompt,
              images: imgs,
              content: content || undefined,
              refused: false
            }]
          };
        }
        // Fewer (or no) images than requested — do not keep a partial set
        // (mixing would break consistency); fall back to per-scene calls.
        console.warn(
          `[image-create] one-shot storyboard returned ${imgs.length}/${total} images — falling back to per-scene calls`,
          summarizeCompletion(json)
        );
      } catch (err: any) {
        if (controller.signal.aborted) {
          // Timeout or caller abort — do not fall back (per-scene would hit
          // the same wall and double the wait); surface immediately.
          throw err;
        }
        const moderation = contentModerationReason(err);
        if (moderation) {
          // The ONE request for the whole storyboard was rejected by content
          // moderation — the per-scene fallback would be moderated too.
          // Treat every scene as refused so their prompts stay findable and
          // the user can adapt the wording.
          const scenes: GeneratedImageScene[] = Array.from(
            { length: total },
            (_, s) => ({
              scene: s + 1,
              prompt: scenePrompt(s),
              images: [],
              content: moderation,
              refused: true
            })
          );
          return { content: moderation, images: [], scenes };
        }
        console.warn(
          `[image-create] one-shot storyboard failed — falling back to per-scene calls: ${String(err?.message ?? err)}`
        );
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', forwardAbort);
      }
    }

    // ------------------------------------------------------------------
    // Pure picture mode: request ALL pictures EN-BLOCK from the pure,
    // temporal-free picture descriptions + consistency rules. The image model
    // sees only sanitized descriptions (never the raw story prose) and
    // controls character / setting / style consistency across all pictures.
    // Best-effort: if it returns fewer than `total` images (or fails), fall
    // back to the per-scene loop below — each scene driven by its own pure
    // description.
    // ------------------------------------------------------------------
    const pureDescriptions = (opts?.purePictures
      ? scenePrompts.map(s => (s ?? '').trim()).filter(s => s.length > 0)
      : []);
    if (opts?.purePictures && pureDescriptions.length > 0) {
      const purePrompt = purePicturesPrompt(
        (opts?.sceneInstruction ?? '').trim() || basePrompt,
        pureDescriptions,
        total,
        opts?.storyboardPrompt
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const forwardAbort = (): void => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', forwardAbort, { once: true });
      }
      try {
        const json = await callOnce(
          [...messages, { role: 'user' as const, content: purePrompt }],
          controller.signal
        );
        const imgs = extractLlmImages(json);
        if (imgs.length >= total) {
          // All pictures came back in one go — record as a single scene (one
          // prompt file + illustration-1..N) and stop.
          const content = extractLlmDelta(json).content.trim() || extractLlmRefusal(json);
          opts?.onProgress?.(total, total);
          return {
            content,
            images: imgs,
            scenes: [{
              scene: 1,
              prompt: purePrompt,
              images: imgs,
              content: content || undefined,
              refused: false
            }]
          };
        }
        // Fewer images than requested — do not keep a partial set; the
        // per-scene loop below re-renders each description separately.
        console.warn(
          `[image-create] pure-picture en-block returned ${imgs.length}/${total} images — falling back to per-scene calls`,
          summarizeCompletion(json)
        );
      } catch (err: any) {
        if (controller.signal.aborted) {
          // Timeout or caller abort — surface immediately (no fallback that
          // would double the wait).
          throw err;
        }
        const moderation = contentModerationReason(err);
        if (moderation) {
          // The en-block request was moderated — per-scene requests would be
          // moderated too (same descriptions). Mark every scene refused.
          const scenes: GeneratedImageScene[] = Array.from(
            { length: total },
            (_, s) => ({
              scene: s + 1,
              prompt: pureDescriptions[s] ?? scenePrompt(s),
              images: [],
              content: moderation,
              refused: true
            })
          );
          return { content: moderation, images: [], scenes };
        }
        console.warn(
          `[image-create] pure-picture en-block failed — falling back to per-scene calls: ${String(err?.message ?? err)}`
        );
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', forwardAbort);
      }
    }

    const sceneRecords: GeneratedImageScene[] = [];
    const collected: LlmImagePart[] = [];
    let firstContent = '';
    let failures = 0;
    let stopped = false;

    for (let i = 0; i < total; i++) {
      if (collected.length >= total) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const forwardAbort = (): void => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', forwardAbort, { once: true });
      }

      const prompt = scenePrompt(i);
      let json: unknown;
      try {
        const hasPlannedScene = (scenePrompts[i] ?? '').trim().length > 0;
        let msgs: ChatMessage[];
        if (total > 1) {
          msgs = [...messages, { role: 'user' as const, content: prompt }];
        } else if (hasPlannedScene) {
          // count=1 with a derived scene description: the final cue becomes
          // that description (the raw anchor text is already in `messages`
          // as context and must not be re-sent verbatim).
          msgs = [...messages, { role: 'user' as const, content: prompt }];
        } else {
          msgs = messages;
        }
        json = await callOnce(msgs, controller.signal);
      } catch (err: any) {
        const moderation = contentModerationReason(err);
        if (moderation) {
          // Provider rejected the request on content-moderation grounds
          // (e.g. xAI's imagine:content-moderated). This is a per-prompt
          // decision, not a transport failure — the same scene may pass with
          // different wording. Treat it like a refusal: keep every scene's
          // prompt findable and stop (the remaining scenes would be rejected
          // too).
          firstContent = moderation;
          for (let s = i; s < total; s++) {
            sceneRecords.push({
              scene: s + 1,
              prompt: scenePrompt(s),
              images: [],
              content: moderation,
              refused: true
            });
          }
          failures += 1;
          stopped = true;
          break;
        }
        const timedOut = controller.signal.aborted;
        if (timedOut && collected.length === 0) {
          throw new Error(`Image generation timed out after ${TIMEOUT_MS / 1000}s`);
        }
        if (collected.length > 0) {
          // Partial storyboard — keep what we have and continue (or bail).
          failures += 1;
          stopped = true;
          break;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', forwardAbort);
      }

      const imgs = extractLlmImages(json);
      const refused = imgs.length === 0;
      const content = extractLlmDelta(json).content.trim() || extractLlmRefusal(json);
      sceneRecords.push({
        scene: i + 1,
        prompt,
        images: imgs,
        content: content || undefined,
        refused
      });
      for (const im of imgs) collected.push(im);
      if (!firstContent) firstContent = content;
      const have = Math.min(collected.length, total);
      opts?.onProgress?.(have, total);
      if (refused) {
        // A 200 with no parseable image is usually an unexpected response
        // shape or a refusal — log once; the caller keeps the prompt record.
        console.warn(
          `[image-create] scene ${i + 1} returned no image —`,
          summarizeCompletion(json)
        );
      }
    }

    // Scenes that were skipped because the storyboard stopped early are
    // recorded as refused so their prompts are still preserved.
    if (stopped) {
      for (let i = sceneRecords.length; i < total; i++) {
        sceneRecords.push({
          scene: i + 1,
          prompt: scenePrompt(i),
          images: [],
          content: 'Generation stopped early (previous scene failed).',
          refused: true
        });
      }
    }

    if (collected.length > 0 && failures > 0) {
      console.warn(`[image-create] storyboard partial: got ${collected.length}/${total} images`);
    }
    return { content: firstContent, images: collected, scenes: sceneRecords };
  }

  /**
   * Best-effort planning pass for storyboard mode. Asks the model (a TEXT
   * completion — no image requested) to expand the story so far into `total`
   * concrete, distinct picture descriptions. Returns an array of length
   * `total` where each entry is the description that renders that scene, or
   * `null` when the planning call failed / returned nothing usable for that
   * scene (the caller then falls back to the generic storyboard instruction).
   */
  private async planStoryboardDescriptions(
    provider: { baseUrl: string; apiKey: string },
    model: ModelEntry,
    messages: ChatMessage[],
    total: number,
    signal: AbortSignal | undefined,
    storyboardPrompt?: string,
    planner?: { model: ModelEntry; provider: { baseUrl: string; apiKey: string } } | null
  ): Promise<(string | null)[]> {
    const empty = (): (string | null)[] => Array<(string | null)>(total).fill(null);
    if (total < 1) return empty();

    // Plan on a capable TEXT model when one was provided — image models are
    // unreliable at following the strict JSON / still-frame instructions.
    const planModel = planner?.model ?? model;
    const planProvider = planner?.provider ?? provider;
    const resolved = await this.resolveForCurrentChat(planModel);
    const extras = this.toLlmExtras(resolved);
    // Text-only planning — image models reject the generic chat sampling
    // params and never take reasoning/thinking columns; strip them all.
    delete extras['temperature'];
    delete extras['top_k'];
    delete extras['top_p'];
    delete extras['include_reasoning'];
    delete extras['reasoning'];

    // The story context for planning = the text of the messages that will be
    // rendered, without image/file parts (irrelevant for a text call, and some
    // providers reject them mid-conversation).
    const textOnly: ChatMessage[] = [];
    for (const m of messages) {
      let text: string | null = null;
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content
          .map(p => (typeof p === 'object' && p && 'text' in p && p.text) ? String(p.text) : '')
          .filter(Boolean)
          .join('\n');
      }
      if (text && text.trim()) textOnly.push({ role: m.role, content: text });
    }
    if (textOnly.length === 0) return empty();

    const instruction = picturePlanningInstruction(total, storyboardPrompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const forwardAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const json = await this.askLlmJson(
        planProvider.baseUrl,
        planProvider.apiKey,
        planModel.modelId,
        [...textOnly, { role: 'user' as const, content: instruction }],
        controller.signal,
        extras
      );
      const content = extractLlmDelta(json).content || extractLlmRefusal(json);
      const parsed = parsePictureDescriptions(content);
      const out = empty();
      for (let i = 0; i < total; i++) out[i] = parsed[i] ?? null;
      return out;
    } catch (err: any) {
      if (!controller.signal.aborted) {
        console.warn(
          `[image-create] picture-description planning failed — falling back to generic scenes: ${String(err?.message ?? err)}`
        );
      }
      return empty();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
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
 * Per-scene instruction appended in storyboard mode (count > 1). Tells the
 * model to render a →new← scene from the story context each iteration.
 * `extra` is the user's storyboard prompt (a standing constraint for all
 * scenes), e.g. "no explicit images — hide behind bystanders, shadows…".
 */
function storyboardInstruction(index: number, total: number, extra?: string): string {
  const base = `Storyboard: render picture ${index + 1} of ${total}. Choose a DISTINCT scene from the story above (do not repeat a scene you already rendered) and draw it. Keep characters, setting and style consistent across all ${total} pictures.`;
  return extra?.trim() ? `${base}\n\nRules for every picture:\n${extra.trim()}` : base;
}

/**
 * Prompt for pure picture mode: requests ALL `total` pictures EN-BLOCK from
 * only the derived, temporal-free picture descriptions plus the consistency
 * rules. The image model never sees the raw story prose (which can trigger
 * moderation on sensitive story content) — only sanitized, isolated picture
 * descriptions, and it is told to keep characters / setting / style identical
 * across all pictures.
 */
function purePicturesPrompt(
  sceneInstruction: string,
  descriptions: string[],
  total: number,
  extra?: string
): string {
  let text = sceneInstruction ? `${sceneInstruction}\n\n` : '';
  text += `Below are EXACTLY ${total} pure picture descriptions — isolated moments of a scene, free of story or temporal context. Render ALL ${total} pictures in ONE single response.

The exact pictures to render (one picture per description, in this order):
`;
  descriptions.forEach((d, i) => { text += `${i + 1}. ${d.trim()}\n`; });
  text += `
Rules for every picture:
- Render each picture EXACTLY as described; do not add plot, dialogue or time progression.
- Keep the SAME characters (identical face, build, costume), the SAME setting/environment and the SAME art style across ALL ${total} pictures — never change appearance or environment between images.
- Use only what the description states; avoid any sensitive or explicit content.`;
  if (extra?.trim()) text += `\n\nAdditional rules for every picture:\n${extra.trim()}`;
  return text;
}

/**
 * Prompt for one-shot storyboard mode: asks for ALL `total` pictures in a
 * SINGLE completion response, with explicit instructions to keep characters,
 * faces, figures, the environment and the style identical across every image.
 * When `scenePrompts` (from the picture-description planning pass) is present
 * it lists those concrete scenes so each image renders exactly its scene.
 */
function oneShotStoryboardPrompt(
  basePrompt: string,
  scenePrompts: (string | null)[],
  total: number,
  extra?: string
): string {
  let text = basePrompt ? `${basePrompt}\n\n` : '';
  text += `Storyboard one-shot: create EXACTLY ${total} pictures in ONE single response — all ${total} images together in this same completion.

Produce all ${total} images in the same response so that characters, faces, figures, costumes, the environment/setting, lighting and art style are perfectly consistent across every image.

Rules:
- One DIFFERENT scene per image, covering the key moments of the story beat above, in story order.
- The SAME characters (identical face, build, costume), the SAME setting/environment and the SAME style in every image — never change appearance or environment between images.
- Stay consistent with characters, setting and style established earlier.
- Return all ${total} images now.`;
  const planned = scenePrompts
    .map(s => (s ?? '').trim())
    .filter(s => s.length > 0);
  if (planned.length > 0) {
    text += `\n\nThe exact scenes to render (one image per scene, in this order):\n`;
    planned.forEach((p, i) => { text += `${i + 1}. ${p}\n`; });
  }
  if (extra?.trim()) {
    text += `\n\nAdditional storyboard rules for every picture:\n${extra.trim()}`;
  }
  return text;
}

/**
 * Planning instruction used before generating a storyboard (when
 * `planDescriptions` is on): instead of letting the render model pick "a
 * scene" from prose, first expand the story into concrete, self-contained
 * picture descriptions. `extra` is the user's storyboard rules (a standing
 * constraint for every picture).
 */
function picturePlanningInstruction(total: number, extra?: string): string {
  const base = `You are a storyboard artist who converts narrative prose into STATIC still images.

Below is the story so far and the illustration request (the last text is the beat to depict; the earlier text is the established context).

Produce EXACTLY ${total} distinct still images in story order.

EACH image is ONE single frozen instant — a photograph, not a film clip. Show only what is visible at exactly ONE point in time. Do NOT narrate a sequence of actions and do NOT compress several moments into one image:
- BAD: "Amanda walks into the office where Dr. Harvey waits; she sits down, crosses her legs, and he watches her."
- GOOD: "Medium shot from the doorway: Amanda stands just inside Dr. Harvey's half-open door, one stiletto heel lifted, hand resting on the polished door edge; warm lamplight falls across the black leather skirt; the doctor sits at his desk looking up, pen mid-air."

For EVERY image write ONE self-contained prose description of that single frozen frame, so a painter can draw it without reading the story:
- shot size / camera angle (wide, medium, close-up, ...)
- the EXACT pose and position of every character in the frame, frozen at that instant
- costume and appearance
- setting, lighting, time of day, weather
- key objects and their exact placement
- mood, dominant colors, composition
- any visible text/sign, or explicitly "no text"

RULES:
- Static, descriptive language only — no motion sequences, no "then/next/after".
- No dialogue, no inner monologue, no speech bubbles.
- Keep characters, setting and style consistent across all ${total} images.
- Never repeat an image.

Return ONLY a JSON object with a single key "pictures": an array of exactly ${total} plain strings:
{"pictures": ["<description 1>", "<description 2>", ...]}
No markdown fences, no text before or after the JSON.`;
  return extra?.trim() ? `${base}\n\nRules that apply to every picture:\n${extra.trim()}` : base;
}

/**
 * Keys where a picture-description object may store its text.
 */
const DESCRIPTION_KEYS = ['description', 'text', 'prompt', 'scene', 'caption', 'desc', 'image', 'picture', 'frame'];

/**
 * Extract a usable picture-description string from one element of the
 * planning answer. Accepts a plain string or an object carrying the
 * description in a known field. Rejects empties and artifacts such as the
 * literal "[object Object]" produced by String(object).
 */
function descriptionFromEntry(x: unknown): string | null {
  if (x == null) return null;
  if (typeof x === 'string') {
    const t = x.trim();
    return t && t !== '[object Object]' ? t : null;
  }
  if (typeof x === 'object') {
    const obj = x as Record<string, unknown>;
    for (const k of DESCRIPTION_KEYS) {
      const v = obj[k];
      if (typeof v === 'string') {
        const t = v.trim();
        if (t && t !== '[object Object]') return t;
      } else if (v && typeof v === 'object') {
        const inner = descriptionFromEntry(v);
        if (inner) return inner;
      }
    }
  }
  return null;
}

/**
 * Robustly parse the planning answer into picture-description strings.
 * Accepts a plain JSON array, an object with `pictures`/`descriptions`/
 * `scenes` arrays, a fenced array, and (last resort) numbered/bulleted lines.
 * Never throws.
 */
function parsePictureDescriptions(content: string): (string | null)[] {
  const trimmed = (content || '').trim();
  if (!trimmed) return [];

  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');

  const asStrings = (v: unknown): string[] | null => {
    if (Array.isArray(v)) {
      const arr = v.map(descriptionFromEntry).filter((s): s is string => !!s);
      return arr.length ? arr : null;
    }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      for (const k of ['pictures', 'descriptions', 'scenes', 'images']) {
        const inner = asStrings(obj[k]);
        if (inner) return inner;
      }
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
      .map((s) => s.replace(/^\s*(?:\d+[.)]?|[-•*])\s*/, '').trim())
      .filter((s) => s.length > 0);
    if (!arr.length) return [];
  }
  return arr.map((s) => (s && s.trim()) ? s.trim() : null);
}

/**
 * The exact prompt already placed in `messages` by the caller (the last user
 * message: the instruction/anchor + direction text). Used as the "prompt used"
 * record for each generated image. Reduces multimodal content to its text.
 */
function lastUserPromptText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map(p => (typeof p === 'object' && p && 'text' in p && p.text ? p.text : ''))
        .filter(Boolean)
        .join('\n\n');
      if (text.trim()) return text;
    }
  }
  return '';
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

/**
 * Extract a short, human-readable reason from a provider error that rejected a
 * picture request on CONTENT MODERATION grounds.
 *
 * OpenRouter wraps upstream rejections in a 400 "Provider returned error" and
 * nests the real detail under `error.metadata.raw` — but each provider shapes
 * that detail differently:
 *   - xAI:              {"code":"imagine:content-moderated","error":"Generated image rejected by content moderation.", ...}
 *   - Black Forest Labs: {"status":"Request Moderated","details":{"Moderation Reasons":["Content Policy Violation"]}, ...}
 *   - OpenAI:           {"error":{"message":"Content policy violation", ...}}
 * Content moderation is a per-prompt decision, not a transport failure — the
 * same scene can pass with different wording — so `generateImage` treats any
 * of these like a refusal (keep the prompt findable, let the user adapt)
 * instead of a hard error.
 *
 * Returns null when the error is NOT a content-moderation rejection.
 */
function contentModerationReason(raw: unknown): string | null {
  // Errors are passed here as Error objects (and sometimes the raw string):
  // JSON.stringify(Error) is "{}" and would lose the message, so read the
  // message text explicitly.
  let rawText: string;
  if (typeof raw === 'string') rawText = raw;
  else if (raw instanceof Error) rawText = String(raw.message ?? raw);
  else rawText = JSON.stringify(raw ?? '');

  // Recognize the wording variations across providers (case-insensitive):
  // "content-moderated" / "content_moderated" / "content moderation", a bare
  // "moderated"/"moderation" ("Request Moderated", "Moderation Reasons"),
  // "content policy violation", "inappropriate/unsafe content".
  if (!MODERATION_HINT_PATTERNS.some((re) => re.test(rawText))) return null;

  const candidates: unknown[] = [];
  if (raw && typeof raw === 'object') candidates.push(raw);
  // askLlmJson wraps errors as "LLM request failed: 400 <json>"; peel the JSON.
  const brace = rawText.indexOf('{');
  if (brace >= 0) {
    try {
      candidates.push(JSON.parse(rawText.slice(brace)));
    } catch { /* keep going */ }
  }
  for (const candidate of candidates) {
    const reason = moderationReasonFromPayload(candidate);
    if (reason) return reason;
  }
  return 'Content policy: the provider rejected the picture request.';
}

/** Wordings that mark an image error as a content-moderation rejection. */
const MODERATION_HINT_PATTERNS = [
  /content[\s_-]*m[oö]derat/i,              // content-moderated / content_moderated / content moderation
  /\bmoderat(?:ed|ion)?\b/i,                // moderated / moderation / "Request Moderated" / "Moderation Reasons"
  /content[\s_-]*policy[\s_-]*violation/i,  // "Content Policy Violation" / content_policy_violation
  /inappropriate\s+content/i,
  /unsafe\s+content/i,
];

/**
 * Walk an OpenRouter-shaped error payload and pull out the provider's own,
 * human-readable moderation reason. Handles the known provider shapes by
 * looking for an explicit error/message first, then `details`-style reason
 * lists, then a "moderated" status.
 */
function moderationReasonFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, any>;
  const error = (p['error'] && typeof p['error'] === 'object') ? p['error'] : undefined;
  const plainError = typeof p['error'] === 'string' ? p['error'] : undefined;

  // OpenRouter nests the provider rejection in error.metadata.raw (a JSON
  // string for most gateways, or a raw object).
  const rawMeta = error?.['metadata']?.['raw'];
  let provider: unknown;
  if (typeof rawMeta === 'string') {
    try { provider = JSON.parse(rawMeta); } catch { provider = undefined; }
  } else if (rawMeta && typeof rawMeta === 'object') {
    provider = rawMeta;
  }

  for (const candidate of [provider, error, p]) {
    const reason = moderationTextFrom(candidate);
    if (reason) return reason;
  }
  if (plainError && !/Provider returned error/i.test(plainError)) return plainError.trim();
  return null;
}

/** Pull readable text out of one candidate layer of a moderation payload. */
function moderationTextFrom(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const o = candidate as Record<string, any>;

  // Explicit provider message — skip the generic OpenRouter wrapper text.
  for (const key of ['error', 'message']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim() && !/Provider returned error/i.test(v)) {
      return v.trim();
    }
  }

  // Provider "details" objects: "Moderation Reasons" (Black Forest Labs),
  // "reason(s)", "labels", boolean category maps ({violence:true, ...}).
  const details = o['details'];
  if (details && typeof details === 'object') {
    const reasons = moderationDetailsText(details);
    if (reasons) return reasons;
  }

  // Flat reason fields.
  for (const key of ['reason', 'moderation_reasons', 'Moderation Reasons', 'labels', 'categories']) {
    const v = o[key];
    if (Array.isArray(v) && v.length) return v.map(String).join(', ');
    if (typeof v === 'string' && v.trim()) return v.trim();
  }

  // A "moderated" status, e.g. "Request Moderated".
  if (typeof o['status'] === 'string' && /moderat/i.test(o['status'])) {
    return o['status'].trim();
  }

  return null;
}

/** Join a provider's moderation `details` object into readable text. */
function moderationDetailsText(details: Record<string, any>): string | null {
  for (const key of [
    'Moderation Reasons', 'moderation_reasons', 'reasons', 'reason',
    'labels', 'classified_labels', 'categories'
  ]) {
    const v = details[key];
    if (Array.isArray(v) && v.length) return v.map(String).join(', ');
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      // Boolean category map, e.g. {"violence":true,"harassment":true}.
      const hits: string[] = [];
      for (const [k, val] of Object.entries(v)) {
        if (val === true) hits.push(k);
      }
      if (hits.length) return hits.join(', ');
    }
  }
  return null;
}
