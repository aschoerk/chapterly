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
}

export const ILLUSTRATE_COUNT_MIN = 1;
export const ILLUSTRATE_COUNT_MAX = 64;

export function defaultIllustrateOptions(): IllustrateOptions {
  return { count: 1, style: '', storyboardPrompt: '' };
}

export function clampIllustrateCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(ILLUSTRATE_COUNT_MIN, Math.min(ILLUSTRATE_COUNT_MAX, Math.floor(count)));
}