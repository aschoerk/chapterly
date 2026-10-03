import type { ImageScene, Slot, SlotStatus } from './types';

/**
 * Slot helpers — tiny factories so evaluators/use cases read fluently:
 *   slots.text = okSlot('…')
 *   slots.images = refusedSlot('Content policy: …')
 *   slots.error = errorSlot('aborted')
 */

export function makeSlot<T>(status: SlotStatus, value: T | null, reason?: string, meta?: Slot<T>['meta']): Slot<T> {
  return { status, value, reason, meta };
}

export function partialSlot<T>(value: T | null, meta?: Slot<T>['meta']): Slot<T> {
  return makeSlot('partial', value, undefined, meta);
}

export function okSlot<T>(value: T, meta?: Slot<T>['meta']): Slot<T> {
  return makeSlot('ok', value, undefined, meta);
}

export function refusedSlot<T = null>(reason: string, meta?: Slot<T>['meta']): Slot<T> {
  return makeSlot<T>('refused', null as T, reason, meta);
}

export function errorSlot(reason: 'timeout' | 'aborted' | 'http' | 'parse', detail?: string): Slot<'timeout' | 'aborted' | 'http' | 'parse'> {
  return makeSlot('error', reason, detail, undefined);
}

/** The text of a slot ('' when partial/refused/error with no value). */
export function slotText(slot: Slot<string> | undefined): string {
  return slot?.value ?? '';
}

/** Whether a slot settled usable (ok or a non-empty partial). */
export function slotUsable(slot: Slot<unknown> | undefined): boolean {
  if (!slot) return false;
  if (slot.status === 'ok') return true;
  return slot.status === 'partial' && !!slot.value;
}

/**
 * Collect all image parts from a set of slots — used by the post-processor
 * and by the storyboard aggregation.
 */
export function allSlotImages(slots: Array<Slot<import('../llm-message').LlmImagePart[]> | undefined>): import('../llm-message').LlmImagePart[] {
  return slots.flatMap(s => (s?.value ?? []));
}

/** Count of scenes that refused (for user feedback like "got 2 of 3"). */
export function refusedSceneCount(scenes: ImageScene[] | null | undefined): number {
  if (!scenes) return 0;
  return scenes.filter(s => s.refused).length;
}