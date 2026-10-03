import { Injectable, inject } from '@angular/core';
import type { ChatMessage } from '../../../models/chat';
import type { EvalSlots, ImageScene, LlmImagePart, UsecaseContext, UsecaseKind, UsecaseVars } from './types';
import { UsecaseContextFactory, type BuildContext, type ModelRef } from './context';
import { LlmOrchestratorService, type PrimitiveOptions } from './orchestrator';
import { makeSlot, okSlot } from './slots';
import { isFlowUsecase, LlmFlowRunner, prepareTextSend } from './flows';

/**
 * Runtime environment handed to every use-case controller: the static
 * context, the resolved models, the shared primitives, and pre-resolved
 * request extras (a controller should do no parameter resolution itself).
 */
export interface UsecaseEnv {
  readonly cx: UsecaseContext;
  readonly factory: UsecaseContextFactory;
  readonly orch: LlmOrchestratorService;
  readonly render: ModelRef;
  readonly plan: ModelRef;
  /** Drawing instruction with optional style applied. */
  readonly instruction: string;
  /** Context messages up to the current node (text-only for planning). */
  readonly contextMessages: ChatMessage[];
  /** The exact anchor prompt (instruction + node text). */
  readonly anchor: string;
  /** Pre-resolved IMAGE request extras (stream:false, no temp/thinking). */
  readonly imageExtras: Record<string, unknown>;
  /** Writing model for `append` (plain text send). */
  readonly write?: ModelRef;
  /** Pre-resolved TEXT request extras (keeps temp/thinking/stream). */
  readonly textExtras?: Record<string, unknown>;
  /** FULL chat up to (and including) the current node for `append`. */
  readonly sendMessages?: ChatMessage[];
  /** Signals/callbacks forwarded from the caller. */
  readonly signal?: AbortSignal;
  readonly onChunk?: PrimitiveOptions['onChunk'];
}

/** Shared primitives a controller is allowed to call. */
export type UsecaseController = (env: UsecaseEnv) => Promise<EvalSlots>;

/**
 * Build the single user message for an image render call: JUST the prompt
 * text. NO attachments are ever sent to the image model — prior illustrations
 * / hand-attached images are deliberately NOT forwarded as reference `image_url`
 * parts (binaries must never reach the image generation model).
 */
function renderMessages(env: UsecaseEnv, prompt: string): ChatMessage[] {
  return [{ role: 'user', content: prompt }];
}

/** Wrap a single/en-block image result as a one-scene storyboard slot. */
function wrapImagesAsStoryboard(
  slots: EvalSlots,
  prompt: string,
  count: number
): EvalSlots {
  const images = slots.images?.value ?? [];
  const refused = slots.images?.status === 'refused' || images.length === 0;
  const reason = slots.images?.reason;
  const scenes: ImageScene[] = count > 1
    ? Array.from({ length: count }, (_, i) => ({
        scene: i + 1,
        prompt,
        images: (i === 0 ? images : []),
        content: reason ?? (refused ? undefined : undefined),
        refused: i === 0 ? refused : refused
      }))
    : [{
        scene: 1,
        prompt,
        images,
        content: reason ?? undefined,
        refused
      }];
  return {
    ...slots,
    storyboard: makeSlot('ok', scenes, undefined, {})
  };
}

// ---------------------------------------------------------------------------
// 1. storyboard-direct — the chat AS-IS (TEXT only), one render request
// ---------------------------------------------------------------------------
async function storyboardDirect(env: UsecaseEnv): Promise<EvalSlots> {
  const count = env.cx.vars.count ?? 1;
  // One-shot storyboard prompt heads the call; the chat's TEXT is sent as
  // context. The image model only ever receives the prompt + story text — NO
  // attachments: prior illustrations / hand-attached images are never
  // forwarded as reference here (the image model must not see binaries).
  const prompt = env.factory.oneShotStoryboardPrompt(
    env.anchor, [], count, env.cx.vars.storyboardPrompt
  );
  const contextText = env.factory.textOnlyMessages(env.contextMessages);
  const messages = [...contextText, ...renderMessages(env, prompt)];
  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages,
    extras: env.imageExtras
  }, { expect: 'images', prompt, signal: env.signal });
  return wrapImagesAsStoryboard(slots, prompt, count);
}

// ---------------------------------------------------------------------------
// 2. planned-enblock — plan → ONE en-block render
// ---------------------------------------------------------------------------
async function plannedEnblock(env: UsecaseEnv): Promise<EvalSlots> {
  const count = env.cx.vars.count ?? 1;
  const planSlots = await runPlanning(env);
  const descriptions = planSlots.descriptions?.value ?? [];
  const prompt = env.cx.vars.purePictures
    ? env.factory.purePicturesPrompt(
        env.instruction,
        descriptions.map(d => d.text),
        count,
        env.cx.vars.storyboardPrompt)
    : env.factory.oneShotStoryboardPrompt(
        env.anchor,
        descriptions.map(d => d.text),
        count,
        env.cx.vars.storyboardPrompt);

  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages: renderMessages(env, prompt),
    extras: env.imageExtras
  }, { expect: 'images', prompt, signal: env.signal });
  return {
    ...planSlots,
    ...wrapImagesAsStoryboard(slots, prompt, count)
  };
}

// ---------------------------------------------------------------------------
// 3. planned-scenes — plan → per-scene LOOP
// ---------------------------------------------------------------------------
async function plannedScenes(env: UsecaseEnv): Promise<EvalSlots> {
  const count = env.cx.vars.count ?? 1;
  const planSlots = await runPlanning(env);
  const descriptions = planSlots.descriptions?.value ?? [];

  const scenes: ImageScene[] = [];
  const collected: LlmImagePart[] = [];
  let firstContent = '';

  for (let i = 0; i < count; i++) {
    const desc = descriptions[i]?.text;
    const prompt = desc
      ? `${env.anchor}\n\nRender exactly this picture description (it overrides any scene cue above):\n${desc}`
      : env.anchor + (count > 1
        ? `\n\n${env.factory.storyboardInstruction(i, count, env.cx.vars.storyboardPrompt)}`
        : '');

    const slots = await env.orch.completeImage(env.cx, {
      model: env.render.model,
      provider: env.render.provider,
      messages: renderMessages(env, prompt),
      extras: env.imageExtras
    }, { expect: 'images', prompt, scene: i + 1, signal: env.signal });

    const images = slots.images?.value ?? [];
    const refused = slots.images?.status === 'refused' || images.length === 0;
    if (!firstContent && slots.images?.reason) firstContent = slots.images.reason;
    collected.push(...images);
    scenes.push({
      scene: i + 1,
      prompt,
      images,
      content: refused ? (slots.images?.reason) : undefined,
      refused
    });
    if (env.signal?.aborted) break; // abort → stop the whole tree
  }

  return {
    ...planSlots,
    images: okSlot(collected, {}),
    storyboard: makeSlot('ok', scenes, undefined, {})
  };
}

// ---------------------------------------------------------------------------
// 4. render-full — no storyboard, current node + FULL chat context (text only)
// ---------------------------------------------------------------------------
async function renderFull(env: UsecaseEnv): Promise<EvalSlots> {
  // contextMessages = full chat up to (not including) the current node;
  // the anchor (current node text) is appended as the scene to render. The
  // image model only ever receives TEXT: the context is stripped to text and
  // no reference/attachment images are forwarded.
  const contextText = env.factory.textOnlyMessages(env.contextMessages);
  const messages = [...contextText, ...renderMessages(env, env.anchor)];
  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages,
    extras: env.imageExtras
  }, { expect: 'images', prompt: env.anchor, signal: env.signal });
  return wrapImagesAsStoryboard(slots, env.anchor, 1);
}

// ---------------------------------------------------------------------------
// 5. render-node — no storyboard, CURRENT NODE ONLY (text only)
// ---------------------------------------------------------------------------
async function renderNode(env: UsecaseEnv): Promise<EvalSlots> {
  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages: renderMessages(env, env.anchor),
    extras: env.imageExtras
  }, { expect: 'images', prompt: env.anchor, signal: env.signal });
  return wrapImagesAsStoryboard(slots, env.anchor, 1);
}

// ---------------------------------------------------------------------------
// 6. image-generation — ONE explicit picture from `vars.promptText` (no
// storyboard). Used by the "adapt prompt & re-render" flow: the adapted
// prompt IS the concrete scene, so there is no planning pass. The image
// model receives ONLY the prompt text — no reference/attachment images.
// ---------------------------------------------------------------------------
async function imageGeneration(env: UsecaseEnv): Promise<EvalSlots> {
  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages: renderMessages(env, env.anchor),
    extras: env.imageExtras
  }, { expect: 'images', prompt: env.anchor, signal: env.signal });
  return wrapImagesAsStoryboard(slots, env.anchor, 1);
}

// ---------------------------------------------------------------------------
// Shared planning step (IDENTICAL code for use cases 2 and 3)
// ---------------------------------------------------------------------------
async function runPlanning(env: UsecaseEnv): Promise<EvalSlots> {
  const count = env.cx.vars.count ?? 1;
  const textOnly = env.factory.textOnlyMessages(env.contextMessages);
  // planned-scenes renders each derived description as its OWN picture, so it
  // uses the SCENE-oriented template (fewer static stills, more alive scenes);
  // planned-enblock (all pictures in one response) keeps the static stills.
  const planPrompt = env.cx.usecase === 'planned-scenes'
    ? env.factory.pictureScenePlanningInstruction(count, env.cx.vars.storyboardPrompt)
    : env.factory.picturePlanningInstruction(count, env.cx.vars.storyboardPrompt);
  return env.orch.completion(env.cx, {
    model: env.plan.model,
    provider: env.plan.provider,
    messages: [...textOnly, { role: 'user', content: planPrompt }],
    extras: await env.factory.resolveExtras(env.plan.model, env.cx.chat)
  }, { expect: 'descriptions', prompt: planPrompt, signal: env.signal });
}

// ---------------------------------------------------------------------------
// append — normal send: user/director at the end of the chat + full history.
// Streams the answer; the text/thinking slots fill incrementally (partial)
// so a view adapter can paint the node DURING the SSE stream, then finalize.
// ---------------------------------------------------------------------------
async function append(env: UsecaseEnv): Promise<EvalSlots> {
  const write = env.write;
  const messages = env.sendMessages ?? [];
  if (!write) {
    return { error: makeSlot('error', 'http', 'No writing model is enabled.', {}) };
  }
  return env.orch.completion(env.cx, {
    model: write.model,
    provider: write.provider,
    messages,
    extras: env.textExtras,
    stream: true
  }, { expect: 'text', onChunk: env.onChunk, signal: env.signal });
}

// ---------------------------------------------------------------------------
// append-with-images — like append, but the current user node carries image
// attachments. The images are FIRST described by the image-interpret model;
// the description is then merged into the direction text of the final user
// message (so the writing model sees the images' content, never the binary
// payload). Interpretation runs ONLY when the descriptions are NOT already
// stored in the node's text (see `prepareTextSend` + the image-description
// record). Falls back to a plain append otherwise.
// ---------------------------------------------------------------------------
async function appendWithImages(env: UsecaseEnv): Promise<EvalSlots> {
  const write = env.write;
  if (!write) {
    return { error: makeSlot('error', 'http', 'No writing model is enabled.', {}) };
  }

  const prep = await prepareTextSend(env, env.cx.chat.id, env.cx.node, {
    content: env.cx.vars.content,
    attachments: env.cx.vars.attachments
  });

  const slots = await env.orch.completion(env.cx, {
    model: write.model,
    provider: write.provider,
    messages: prep.messages,
    extras: env.textExtras,
    stream: true
  }, { expect: 'text', onChunk: env.onChunk, signal: env.signal });

  const out: EvalSlots = { ...slots };
  if (prep.mergedContent && prep.record) {
    // Expose the MERGED content (persist for real) + the record (marks the
    // description as stored, so it is never interpreted again).
    out.direction = okSlot(prep.mergedContent, {});
    out.interpretation = okSlot({ content: prep.mergedContent, record: prep.record }, {});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dispatch — a plain if-chain, not a table.
// ---------------------------------------------------------------------------
export function pickUsecase(vars: UsecaseVars): UsecaseKind {
  const count = vars.count ?? 1;
  if (count > 1 && vars.planDescriptions === false) return 'storyboard-direct';
  if (count > 1 && (vars.singleCall || vars.purePictures)) return 'planned-enblock';
  if (count > 1) return 'planned-scenes';
  if (vars.historyMode === 'full') return 'render-full';
  return 'render-node';
}

const CONTROLLERS: Partial<Record<UsecaseKind, UsecaseController>> = {
  'storyboard-direct': storyboardDirect,
  'planned-enblock': plannedEnblock,
  'planned-scenes': plannedScenes,
  'render-full': renderFull,
  'render-node': renderNode,
  'image-generation': imageGeneration,
  'append': append,
  'append-with-images': appendWithImages
};

export function controllerFor(usecase: UsecaseKind): UsecaseController {
  const c = CONTROLLERS[usecase];
  if (!c) throw new Error(`No controller for ${usecase}`);
  return c;
}

/** Top-level entry: builds the env and runs the selected use case. */
@Injectable({ providedIn: 'root' })
export class LlmUseCaseRunner {
  private readonly factory = inject(UsecaseContextFactory);
  private readonly orch = inject(LlmOrchestratorService);
  private readonly flowRunner = inject(LlmFlowRunner);

  async run(build: BuildContext, opts: { signal?: AbortSignal; onChunk?: PrimitiveOptions['onChunk'] } = {}): Promise<EvalSlots> {
    const usecase = build.usecase;
    const cx = this.factory.buildContext(build);

    // Structural flows (branch/insert/regenerate/rewrite/prepend): delegate
    // to the flow runner, which handles its own env (write model + ChatService
    // for the chat mutation around the text send).
    if (isFlowUsecase(usecase)) {
      return this.flowRunner.run(build, opts);
    }

    // append / append-with-images: a text send — no image model needed.
    if (usecase === 'append' || usecase === 'append-with-images') {
      const write = this.factory.resolveWriteModel(cx.node);
      if (!write || !this.factory.providerFor(write.model)) {
        return { error: makeSlot('error', 'http', 'No writing model is enabled.', {}) };
      }
      // For append-with-images the controller rebuilds the messages WITH the
      // image interpretation; building a baseline here keeps the env valid.
      const sendMessages = this.factory.buildSendMessages(
        cx.chat.id,
        cx.node.id,
        build.vars.content
      );
      const textExtras = await this.factory.resolveTextExtras(write.model, cx.chat);
      const env: UsecaseEnv = {
        cx,
        factory: this.factory,
        orch: this.orch,
        render: write,   // unused for append* but required by the type
        plan: write,
        instruction: '',
        contextMessages: sendMessages,
        anchor: '',
        imageExtras: {},
        write,
        textExtras,
        sendMessages,
        signal: opts.signal,
        onChunk: opts.onChunk
      };
      return controllerFor(usecase)(env);
    }

    const render = this.factory.resolveImageModel(build.vars.modelId, build.vars.providerId);
    if (!render || !this.factory.providerFor(render.model)) {
      return { error: makeSlot('error', 'http', 'No image model is enabled.', {}) };
    }
    const plan = this.factory.resolvePlanModel(render, cx.node);
    const instruction = this.factory.styledDrawingInstruction(build.vars.style);
    // Full chat CONTEXT up to (not including) the current node; the anchor is
    // the scene text, appended by the use-case render step. The scene text is
    // `vars.promptText` when given (explicit picture prompt — the
    // `image-generation` "adapt prompt & re-render" flow), else `vars.content`
    // (illustrate-from-draft / storyboard override), else the node's content.
    const cParentId = cx.node.parentId;
    const contextMessages = cParentId
      ? this.factory.buildContextMessagesUpTo(cx.chat.id, cParentId)
      : [];
    const sceneText = build.vars.promptText ?? build.vars.content ?? cx.node.content ?? '';
    const nodeText = sceneText.trim() || '(no text)';
    const anchor = `${instruction}\n\n${nodeText}`;
    const imageExtras = await this.factory.resolveExtras(render.model, cx.chat);

    const env: UsecaseEnv = {
      cx,
      factory: this.factory,
      orch: this.orch,
      render,
      plan,
      instruction,
      contextMessages,
      anchor,
      imageExtras,
      signal: opts.signal,
      onChunk: opts.onChunk
    };
    return controllerFor(usecase)(env);
  }
}