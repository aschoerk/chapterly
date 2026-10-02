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
}

export const ILLUSTRATE_COUNT_MIN = 1;
export const ILLUSTRATE_COUNT_MAX = 64;

export function defaultIllustrateOptions(): IllustrateOptions {
  return { count: 1, style: '', storyboardPrompt: '', purePictures: false, modelId: '', providerId: '' };
}

export function clampIllustrateCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(ILLUSTRATE_COUNT_MIN, Math.min(ILLUSTRATE_COUNT_MAX, Math.floor(count)));
}