/**
 * Orchestration types — the vocabulary shared across the LLM orchestration
 * subdirectory.
 *
 * This is a NEW, self-contained layer (prototype). It does NOT depend on
 * LlmService; it reuses only leaf helpers (llm-message, llm-sse, the log
 * service, parameter resolution) and the core services (chat / settings /
 * generation tasks / prompt defaults) so it can later be wired into the
 * modal dialogs without changing the existing code.
 */
import { ChatMessage, ChatNode, NodeAttachment, Chat } from '../../../models/chat';
import { ModelEntry, ProviderConfig } from '../../../models/chat-config';

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

/**
 * The use cases the dialog can select (image ones replace the monolithic
 * "storyboard" mode inside generateImage) plus the plain text send:
 *
 *  1. storyboard-direct  — use the chat as-is, ask the image model for N
 *                          pictures in one go (no planning).
 *  2. planned-enblock    — text model derives PICTURE DESCRIPTIONS ONLY,
 *                          then all of them go as ONE block to the image
 *                          model (completion, or /images with n — per model).
 *  3. planned-scenes     — text model derives PICTURE DESCRIPTIONS ONLY,
 *                          then they are rendered ONE PER SCENE in a loop.
 *  4. render-full        — no storyboard: render the current node while
 *                          knowing the COMPLETE chat up to now.
 *  5. render-node        — no storyboard: render the CURRENT NODE only.
 *  append               — normal send: a user/director node at the end of the
 *                          chat + the FULL history as context; stream a text
 *                          answer back (used by sendDraft-like flows).
 *  append-with-images   — like `append`, but the current user node carries
 *                          image attachments: describe them with the
 *                          image-interpret model FIRST, then inject the
 *                          description into the direction text (no binary
 *                          images are re-sent to the writing model) and
 *                          stream the answer.
 */
export type UsecaseKind =
  | 'storyboard-direct'
  | 'planned-enblock'
  | 'planned-scenes'
  | 'render-full'
  | 'render-node'
  | 'append'
  | 'append-with-images';

/** Which provider endpoint a request intent targets. */
export type LlmEndpoint = 'completion' | 'images';

// ---------------------------------------------------------------------------
// Slots — the response model (status-aware, error-tolerant)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a slot:
 *  - 'partial'  while data keeps arriving (e.g. streaming text);
 *  - 'ok'       settled with a usable value;
 *  - 'refused'  the model (or provider moderation) declined / returned nothing;
 *  - 'error'    the call failed / timed out / was aborted.
 */
export type SlotStatus = 'partial' | 'ok' | 'refused' | 'error';

/** One named response slot. Value is null while partial / on refused / error. */
export interface Slot<T> {
  status: SlotStatus;
  value: T | null;
  /** Human-readable reason for refused/error (moderation text, timeout, …). */
  reason?: string;
  /** Provenance / diagnostics: model, prompt, scene, … */
  meta?: Record<string, string | number | boolean | undefined>;
}

/** One derived picture description (from the planning pass). */
export interface PictureDescription {
  /** The concrete, self-contained picture description text. */
  text: string;
  /** 0-based index (scene number - 1). */
  index: number;
}

/** Per-scene outcome of a render call (kept findable for refused scenes). */
export interface ImageScene {
  /** 1-based scene number (used for the prompt file name). */
  scene: number;
  /** The EXACT prompt text sent for this scene. */
  prompt: string;
  /** Images produced (empty when refused/errored). */
  images: import('../llm-message').LlmImagePart[];
  /** Text reply (e.g. a refusal) when no image came back. */
  content?: string;
  /** True when this scene produced no image. */
  refused: boolean;
}

/**
 * All named slots a use case may produce. Every slot carries a status, so a
 * use case can be scripted against the RESULT regardless of whether the call
 * succeeded, was refused, or errored.
 */
export interface EvalSlots {
  /** Streamed/final text (assistant content). */
  text?: Slot<string>;
  /** Streamed/final thinking/reasoning text. */
  thinking?: Slot<string>;
  /** Picture descriptions derived by the planning pass (uses 2 & 3). */
  descriptions?: Slot<PictureDescription[]>;
  /** Images of a single (or en-block) image call. */
  images?: Slot<import('../llm-message').LlmImagePart[]>;
  /** Per-scene records (aggregated storyboard result). */
  storyboard?: Slot<ImageScene[]>;
  /**
   * The MERGED user-node content a text-send use case should persist
   * (`append-with-images`): the direction text + the auto-generated image
   * description. The image itself is never stored as content — only its
   * description — so the history stays usable and images are never re-sent.
   */
  direction?: Slot<string>;
  /**
   * Overall error slot, set when the whole use case could not complete
   * (timeout, caller abort, hard failure). A use case may end with BOTH
   * partial scenes and an error — never throws.
   */
  error?: Slot<'timeout' | 'aborted' | 'http' | 'parse'>;
}

// ---------------------------------------------------------------------------
// Request intents + use-case run context
// ---------------------------------------------------------------------------

/** Which model "role" a request runs on (rendering vs. planning). */
export type LlmModelRole = 'render' | 'plan';

/** A concrete request the orchestrator primitives can execute. */
export interface RequestIntent {
  readonly usecase: UsecaseKind;
  readonly role: LlmModelRole;
  readonly endpoint: LlmEndpoint;
  readonly model: ModelEntry;
  readonly provider: ProviderConfig;
  /** chat-completions payload (for endpoint 'completion'). */
  readonly messages?: ChatMessage[];
  /** /images payload (for endpoint 'images'). */
  readonly prompt?: string;
  readonly n?: number;
  /** Extra request params (temperature, thinking, modalities, …). */
  readonly extras?: Record<string, unknown>;
  /** Whether the completion should stream. */
  readonly stream?: boolean;
  /** Meta for the caller (scene index, prompt used, …). */
  readonly meta?: Record<string, unknown>;
}

/**
 * What the request builder needs to produce a root intent: the chat + current
 * node + selected use case + the variables filled out by a dialog or by text
 * templates.
 */
export interface UsecaseVars {
  /** Number of scenes (1 = single picture). */
  count?: number;
  /** Free-form style hint ('' = none). */
  style?: string;
  /** Storyboard-wide rules (count > 1). */
  storyboardPrompt?: string;
  /** Run the picture-description planning pass first. */
  planDescriptions?: boolean;
  /** Pure picture mode: only derived descriptions reach the image model. */
  purePictures?: boolean;
  /** Render the whole storyboard en-block (single call, count > 1). */
  singleCall?: boolean;
  /** Full chat context vs current node only (count === 1). */
  historyMode?: 'single' | 'full';
  /** Render the current chat as-is for storyboard-direct (raw). */
  useChatAsIs?: boolean;
  /** Prompt text provided directly (e.g. from a text template). */
  promptText?: string;
  /** For `append`: the text to send as the final user message. When omitted
   *  the current node's saved content is used. */
  content?: string;
  /** For `append-with-images`: the user node's attachments (the images to
   *  interpret). The current node's own attachments are used when absent. */
  attachments?: NodeAttachment[];
}

/** The full static run context handed to every use case. */

/** The full static run context handed to every use case. */
export interface UsecaseContext {
  readonly chat: Chat;
  readonly node: ChatNode;
  readonly usecase: UsecaseKind;
  readonly vars: UsecaseVars;
}

export type { LlmImagePart } from '../llm-message';