import { Injectable, inject } from '@angular/core';
import type { ChatMessage, NodeAttachment } from '../../../models/chat';
import type { EvalSlots, ImageScene, LlmImagePart, UsecaseContext, UsecaseKind, UsecaseVars } from './types';
import { UsecaseContextFactory, type BuildContext, type ModelRef } from './context';
import { LlmOrchestratorService, type PrimitiveOptions } from './orchestrator';
import { makeSlot, okSlot } from './slots';
import { isFlowUsecase, LlmFlowRunner, prepareTextSend } from './flows';
import { isImageMime, resolvedMime, type MessagePart } from '../llm-message';

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
  /** Progressive callback — fired as soon as scenes are ready while a
   *  storyboard use case (planned-enblock / planned-scenes / storyboard-
   *  direct) renders them one at a time, so a caller can paint the pictures
   *  on the chapter IMMEDIATELY instead of waiting for the whole run. Each
   *  call delivers the scenes rendered SO FAR (grows monotonically; scenes
   *  not yet attempted are omitted). */
  readonly onImages?: (scenes: ImageScene[]) => void;
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

/**
 * One image-model request. The prompt is sent as a plain single user message
 * (TEXT ONLY — no reference/attachment images ever reach the generation
 * model); optionally a text-only `prefix` (chat context) is prepended.
 */
async function renderImage(
  env: UsecaseEnv,
  prompt: string,
  opts: { prefix?: ChatMessage[]; scene?: number } = {}
): Promise<EvalSlots> {
  return env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages: [...(opts.prefix ?? []), { role: 'user', content: prompt }],
    extras: env.imageExtras
  }, { expect: 'images', prompt, scene: opts.scene, signal: env.signal });
}

/** Complete batch result: ONE scene record holding ALL images under the batch prompt. */
function completeStoryboard(batchPrompt: string, images: LlmImagePart[]): ImageScene[] {
  return [{ scene: 1, prompt: batchPrompt, images, refused: false }];
}

/** Aggregated outcome of a multi-picture render attempt. */
interface StoryboardRender {
  images: LlmImagePart[];
  scenes: ImageScene[];
  /** First refusal / failure reason (kept findable on refused scenes). */
  content: string;
}

/** Progressive snapshot of the per-scene fallback: the scenes 1..attempted
 *  (each with its own prompt + the image produced so far, or a refused record
 *  when the model returned none). Scenes that were not attempted yet are NOT
 *  included, so a caller can attach each picture the moment it is ready. */
function fallbackSceneSnapshot(
  perScene: (LlmImagePart | null)[],
  count: number,
  attempted: number,
  scenePrompt: (i: number) => string,
  content: string
): ImageScene[] {
  const out: ImageScene[] = [];
  for (let i = 0; i < Math.min(attempted, count); i++) {
    const img = perScene[i];
    out.push({
      scene: i + 1,
      prompt: scenePrompt(i),
      images: img ? [img] : [],
      content: img ? undefined : (content || undefined),
      refused: !img
    });
  }
  return out;
}

/**
 * Multi-picture render with PER-PICTURE FALLBACK + REPRISE. Used by the three
 * use cases that can produce several pictures from ONE image-model call
 * (`storyboard-direct`, `planned-enblock`, `planned-scenes`):
 *
 *  1. Try the BATCH call for all `count` pictures — text only.
 *  2. If it returns fewer than `count`, render each MISSING picture
 *     individually (per-scene prompts, text only — each sends ONLY that
 *     scene's own description).
 *  3. If a picture is STILL missing, run ONE final "consistency" batch
 *     attempt — but ONLY when MORE THAN ONE picture was already rendered
 *     (a single image gives too little style context to re-render against).
 *     Its prompt is built by `reprisePromptFor(successful, missing)` with the
 *     DEFAULT render prompt builder, embedding ONLY the successfully rendered
 *     descriptions and using their REAL count as `total`. A `null` return
 *     skips the reprise entirely. When it yields `>= count` pictures the
 *     whole set is replaced; otherwise each returned image is merged into a
 *     still-missing slot.
 */
async function renderBatchWithFallback(
  env: UsecaseEnv,
  count: number,
  batchPrompt: string,
  scenePrompt: (i: number) => string,
  prefix: ChatMessage[] = [],
  reprisePromptFor?: (successful: number[], missing: number[]) => string | null
): Promise<StoryboardRender> {
  // 1. Batch attempt (text only).
  const first = await renderImage(env, batchPrompt, { prefix });
  const firstImages = first.images?.value ?? [];
  let content = first.images?.reason ?? '';
  if (env.signal?.aborted) {
    return {
      images: firstImages,
      content,
      scenes: firstImages.length ? completeStoryboard(batchPrompt, firstImages) : []
    };
  }
  if (firstImages.length > 0) {
    return { images: firstImages, content, scenes: completeStoryboard(batchPrompt, firstImages) };
  }

  // 2. Per-picture fallback: render each MISSING scene individually, sending
  //    ONLY that scene's own description (never the whole list again).
  const perScene: (LlmImagePart | null)[] = [];
  for (let i = 0; i < count; i++) {
    if (i < firstImages.length) { perScene.push(firstImages[i]); continue; }
    const slots = await renderImage(env, scenePrompt(i), { prefix, scene: i + 1 });
    if (slots.images?.reason && !content) content = slots.images.reason;
    perScene.push((slots.images?.value ?? [])[0] ?? null);
    // The scene is ready the moment its render call resolves (image or
    // refused) — surface it immediately so a caller can attach it now.
    env.onImages?.(fallbackSceneSnapshot(perScene, count, i + 1, scenePrompt, content));
    if (env.signal?.aborted) break;
  }

  const successful: number[] = [];
  const missing: number[] = [];
  for (let i = 0; i < perScene.length; i++) {
    (perScene[i] ? successful : missing).push(i);
  }

  // 3. Final "consistency" batch: it embeds ONLY the SUCCESSFULLY rendered
  //    descriptions and re-renders the FULL `count` set, so the missing
  //    pictures are completed consistently with the ones that worked.
  if (missing.length > 0 && !env.signal?.aborted) {
    // Decide the reprise prompt. A `null` from the builder means "skip the
    // reprise entirely" (e.g. not enough successful pictures); without a
    // builder (storyboard-direct) the original batch prompt is re-run.
    const reprisePrompt = reprisePromptFor
      ? reprisePromptFor(successful, missing)
      : batchPrompt;
    if (reprisePrompt) {
      const reprise = await renderImage(env, reprisePrompt, { prefix });
      if (reprise.images?.reason && !content) content = reprise.images.reason;
      const repriseImages = reprise.images?.value ?? [];
      if (repriseImages.length >= count) {
        // The re-rendered whole set is consistent → replace everything.
        return { images: repriseImages, content, scenes: completeStoryboard(reprisePrompt, repriseImages) };
      }
      if (repriseImages.length > 0) {
        // Partial reprise → merge into the still-missing slots.
        let j = 0;
        for (const idx of missing) {
          if (j >= repriseImages.length) break;
          perScene[idx] = repriseImages[j++];
        }
      }
    }
  }

  const scenes: ImageScene[] = [];
  const finalCollected: LlmImagePart[] = [];
  for (let i = 0; i < count; i++) {
    const img = perScene[i];
    if (img) finalCollected.push(img);
    scenes.push({
      scene: i + 1,
      prompt: scenePrompt(i),
      images: img ? [img] : [],
      content: img ? undefined : (content || undefined),
      refused: !img
    });
  }
  return { images: finalCollected, content, scenes };
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
  // One-shot storyboard prompt heads the call; the chat's TEXT is the context.
  // The image model only ever receives the prompt + story text — NO
  // attachments (prior illustrations / hand-attached images never reach it).
  const batchPrompt = env.factory.oneShotStoryboardPrompt(
    env.anchor, [], count, env.cx.vars.storyboardPrompt
  );
  const contextText = env.factory.textOnlyMessages(env.contextMessages);
  const scenePrompt = (i: number) =>
    env.anchor + (count > 1
      ? `\n\n${env.factory.storyboardInstruction(i, count, env.cx.vars.storyboardPrompt)}`
      : '');
  // The final "consistency" attempt re-runs the anchor one-shot (there are no
  // per-scene descriptions in storyboard-direct — the model picks the scenes
  // from the anchor itself).
  const batch = await renderBatchWithFallback(
    env, count, batchPrompt, scenePrompt, contextText
  );
  return {
    images: okSlot(batch.images, {}),
    storyboard: makeSlot('ok', batch.scenes, undefined, {})
  };
}

/**
 * The per-scene render prompt for a PLANNED description. The base is the
 * drawing INSTRUCTION (`env.instruction`, the "how to draw" task prompt) —
 * NOT the raw anchor/prose, so the last assistant node's chapter text NEVER
 * reaches the image model (that was the legacy behavior too: the description
 * IS the scene). Only when NO description is available (planning degraded)
 * does the prompt fall back to the raw anchor as the story cue.
 */
function plannedScenePrompt(
  env: UsecaseEnv,
  desc: string | undefined,
  i: number,
  count: number,
  extra?: string
): string {
  if (desc) {
    const base = env.instruction.trim();
    return base
      ? `${base}\n\nRender exactly this picture description (it overrides any scene cue above):\n${desc}`
      : desc;
  }
  // No description → the anchor (instruction + the beat to depict) is the
  // only story cue; append the per-scene storyboard instruction when >1.
  return env.anchor + (count > 1
    ? `\n\n${env.factory.storyboardInstruction(i, count, extra)}`
    : '');
}

/** The prompt templates that distinguish the two planned storyboard use cases. */
interface PlannedStoryboardTemplates {
  /** Build the planning instruction (the prompt prefix for the planning pass). */
  planning: (count: number) => string;
  /** Build the DEFAULT en-block render prompt — used for the initial batch AND
   *  the reprise (enblock: image.pure / image.one-shot; scenes: image.one-shot-scenes). */
  render: (descs: string[], total: number) => string;
}

/**
 * Shared "plan → ONE en-block render (+ per-picture fallback + reprise)"
 * pipeline used by `planned-enblock` and `planned-scenes`. The two use cases
 * are IDENTICAL except for the prompt TEMPLATES passed in (the planning
 * prefix and the render prefix); the call flow, the batch early-return, the
 * per-scene fallback and the consistency reprise are the same code.
 */
async function plannedStoryboard(env: UsecaseEnv, tpl: PlannedStoryboardTemplates): Promise<EvalSlots> {
  const count = env.cx.vars.count ?? 1;
  const planSlots = await runPlanning(env, tpl.planning);
  const descriptions = planSlots.descriptions?.value ?? [];

  // The DEFAULT render prompt builder — the SAME one that renders all
  // pictures in one go. It is used for the initial batch AND for the fallback
  // reprise, so the reprise always uses the identical default prompt, just
  // combined with a DIFFERENT description list (the successfully rendered
  // ones), keeping the template consistent with the initial batch.
  const buildRenderPrompt = tpl.render;

  const batchPrompt = buildRenderPrompt(descriptions.map(d => d.text), count);

  const scenePrompt = (i: number) =>
    plannedScenePrompt(env, descriptions[i]?.text, i, count, env.cx.vars.storyboardPrompt);

  // The final "consistency" attempt uses the SAME DEFAULT render prompt builder
  // as the initial one-shot, but embeds ONLY the descriptions of the pictures
  // that were successfully rendered and adapts `total` to their REAL count
  // (never the missing/failed ones, never the whole list). It runs ONLY when
  // MORE THAN ONE picture succeeded — a single description gives too little
  // style context to re-render against — otherwise it is skipped entirely.
  const batch = await renderBatchWithFallback(
    env, count, batchPrompt, scenePrompt, [],
    (successful) => {
      const successTexts = successful
        .map(i => descriptions[i]?.text)
        .map(t => (t ?? '').trim())
        .filter(t => t.length > 0);
      if (successTexts.length <= 1) return null;
      return buildRenderPrompt(successTexts, successTexts.length);
    }
  );
  return {
    ...planSlots,
    images: okSlot(batch.images, {}),
    storyboard: makeSlot('ok', batch.scenes, undefined, {})
  };
}

// ---------------------------------------------------------------------------
// 2. planned-enblock — plan → ONE en-block render (+ fallback + reprise)
//    with the STATIC-STILL planning template and the default render prompts
//    (image.pure in pure picture mode, image.one-shot otherwise).
// ---------------------------------------------------------------------------
async function plannedEnblock(env: UsecaseEnv): Promise<EvalSlots> {
  return plannedStoryboard(env, {
    planning: (count) =>
      env.factory.picturePlanningInstruction(count, env.cx.vars.storyboardPrompt),
    render: (descs, total) =>
      env.cx.vars.purePictures
        ? env.factory.purePicturesPrompt(
            env.instruction, descs, total, env.cx.vars.storyboardPrompt)
        : env.factory.oneShotStoryboardPrompt(
            env.instruction, descs, total, env.cx.vars.storyboardPrompt)
  });
}

// ---------------------------------------------------------------------------
// 3. planned-scenes — IDENTICAL to `planned-enblock`, only the prompt
//    TEMPLATES differ: the SCENE-oriented planning prefix (image.planning-
//    scenes) and the scene one-shot render template (image.one-shot-scenes) —
//    fewer static stills, more alive, action-bearing scenes.
// ---------------------------------------------------------------------------
async function plannedScenes(env: UsecaseEnv): Promise<EvalSlots> {
  return plannedStoryboard(env, {
    planning: (count) =>
      env.factory.pictureScenePlanningInstruction(count, env.cx.vars.storyboardPrompt),
    render: (descs, total) =>
      env.factory.oneShotScenesPrompt(
        env.instruction, descs, total, env.cx.vars.storyboardPrompt)
  });
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
// 7. image-send — create an image from marked text + a chat constant
// (combined in `vars.promptText`) sent AS-IS to the image model, plus optional
// reference images (`vars.attachments`) forwarded as image_url parts. That is
// explicitly NOT like the illustration use cases: no planning pass and NO
// drawing-instruction template — the prompt is exactly what the user typed in
// the dialog. Reference images are forwarded ONLY when the user attached them
// (they are occasional references, not the primary input). The picture is
// attached to the assistant node by the caller.
// ---------------------------------------------------------------------------
/** The image_url message parts of the reference images attached in the dialog. */
function referenceImageParts(attachments: NodeAttachment[] | undefined | null): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const a of attachments ?? []) {
    if (isImageMime(resolvedMime(a)) && a.dataUrl?.startsWith('data:') && a.dataUrl.includes(',')) {
      parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    }
  }
  return parts;
}

async function imageSend(env: UsecaseEnv): Promise<EvalSlots> {
  const prompt = (env.cx.vars.promptText ?? '').trim();
  const refs = referenceImageParts(env.cx.vars.attachments);
  let messages: ChatMessage[];
  if (refs.length > 0) {
    messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt || 'See the attached reference image(s).' },
        ...refs
      ]
    }];
  } else {
    messages = [{ role: 'user', content: prompt || '(no text)' }];
  }
  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages,
    extras: env.imageExtras
  }, { expect: 'images', prompt, signal: env.signal });
  return wrapImagesAsStoryboard(slots, prompt, 1);
}

// ---------------------------------------------------------------------------
// Shared planning step (IDENTICAL code for the two planned use cases; the
// planning prompt/prefix is passed in by the caller).
// ---------------------------------------------------------------------------
async function runPlanning(
  env: UsecaseEnv,
  planningPrompt: (count: number) => string
): Promise<EvalSlots> {
  const count = env.cx.vars.count ?? 1;
  const textOnly = env.factory.textOnlyMessages(env.contextMessages);
  const planPrompt = planningPrompt(count);
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
  'image-send': imageSend,
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

  async run(build: BuildContext, opts: { signal?: AbortSignal; onChunk?: PrimitiveOptions['onChunk']; onImages?: (scenes: ImageScene[]) => void } = {}): Promise<EvalSlots> {
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
        onChunk: opts.onChunk,
        onImages: opts.onImages
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
      onChunk: opts.onChunk,
      onImages: opts.onImages
    };
    return controllerFor(usecase)(env);
  }
}