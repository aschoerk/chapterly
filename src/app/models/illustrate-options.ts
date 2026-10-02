/**
 * User choices captured by the Illustrate dialog. The values are persisted
 * (last-used) so the next Illustrate starts from the previous configuration.
 */
export interface IllustrateOptions {
  /** Number of scenes to render (1 = single picture, N>1 = storyboard). */
  count: number;
  /** Free-form style hint, e.g. "comic style, sketchy ink". Empty = none. */
  style: string;
  /**
   * Extra storyboard instruction applied when count > 1 (e.g. "no explicit
   * images, hide behind bystanders, furniture, shadows"). Unused for count=1.
   */
  storyboardPrompt: string;
  /**
   * Pure picture mode: send the image model ONLY temporal-free picture
   * descriptions derived from the story text (plus the consistency rules),
   * never the raw story prose. Image models are less tolerant of sensitive
   * story content than text models, so stripping the temporal context lowers
   * moderation rejects. The derived descriptions are sent to the image model
   * EN-BLOCK first so the image model itself controls character / setting /
   * style consistency across all pictures.
   */
  purePictures: boolean;
  /**
   * Image model chosen in the dialog that renders the picture(s)
   * (`ModelEntry.modelId`, e.g. `openai/gpt-image-1`). Empty means "use the
   * configured default image-create task model".
   */
  modelId: string;
  /** Provider of the chosen model (`ModelEntry.providerId`). */
  providerId: string;
  /**
   * How the story context is delivered to the image model for a SINGLE
   * picture (count === 1):
   * - 'single' (default): only the current node's text is sent as a single
   *   final message.
   * - 'full': the complete text of the chat up to the current node is sent to
   *   the image model in normal form as user/assistant messages, with the
   *   current node's text as the final message.
   * Ignored for storyboards (count > 1).
   */
  historyMode: 'single' | 'full';
  /**
   * Picture-description planning: run a TEXT model first to turn the story
   * into concrete picture descriptions, then let the image model render from
   * those. On by default and used for storyboards, assistant chapters and
   * pure picture mode. When disabled the planning pass is skipped and — for a
   * single picture — the story text that would have been sent to the planning
   * model is sent to the image generating model directly (the whole chat up
   * to this point, delivered as one completion — a one-shot even though only
   * one image is requested). Forced back on in pure picture mode, which needs
   * the derived descriptions.
   */
  planDescriptions: boolean;
}

export type IllustrateHistoryMode = IllustrateOptions['historyMode'];

export const ILLUSTRATE_COUNT_MIN = 1;
export const ILLUSTRATE_COUNT_MAX = 64;

export function isIllustrateHistoryMode(v: unknown): v is IllustrateHistoryMode {
  return v === 'single' || v === 'full';
}

export function defaultIllustrateOptions(): IllustrateOptions {
  return {
    count: 1,
    style: '',
    storyboardPrompt: '',
    purePictures: false,
    modelId: '',
    providerId: '',
    historyMode: 'single',
    planDescriptions: true
  };
}

export function clampIllustrateCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(ILLUSTRATE_COUNT_MIN, Math.min(ILLUSTRATE_COUNT_MAX, Math.floor(count)));
}