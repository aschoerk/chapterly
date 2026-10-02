import { Injectable, signal } from '@angular/core';
import {
  clampIllustrateCount,
  defaultIllustrateOptions,
  IllustrateOptions
} from '../models/illustrate-options';

const LS_KEY = 'chat.illustrateOptions.v1';

interface IllustrateState extends IllustrateOptions {
  /** Collect the modal result. Resolves null when the user cancels. */
  resolve: (value: IllustrateOptions | null) => void;
}

function readLast(): IllustrateOptions {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultIllustrateOptions();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultIllustrateOptions();
    return {
      count: clampIllustrateCount(typeof parsed.count === 'number' ? parsed.count : 1),
      style: typeof parsed.style === 'string' ? parsed.style : '',
      storyboardPrompt: typeof parsed.storyboardPrompt === 'string' ? parsed.storyboardPrompt : '',
      purePictures: typeof parsed.purePictures === 'boolean' ? parsed.purePictures : false,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
      providerId: typeof parsed.providerId === 'string' ? parsed.providerId : ''
    };
  } catch {
    return defaultIllustrateOptions();
  }
}

function persist(opts: IllustrateOptions): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(opts));
  } catch {
    // storage may be unavailable (private mode / SSR) — ignore.
  }
}

/**
 * Holds the open state of the Illustrate dialog (mounted once in the app root,
 * mirroring ConfirmService/ConfirmDialogComponent) and remembers the last-used
 * count / style / storyboard prompt between runs.
 */
@Injectable({ providedIn: 'root' })
export class IllustrateDialogService {
  /** The dialog entry, or null when the dialog is closed. */
  readonly current = signal<IllustrateState | null>(null);
  /** Last confirmed options (seeded from localStorage). */
  readonly last = signal<IllustrateOptions>(readLast());

  /**
   * Open the dialog. Resolves with the chosen options, or null on cancel.
   *
   * @param seed initial overrides for fields not (or no longer) remembered —
   *   e.g. `{ modelId, providerId }` for the default rendering model that the
   *   caller resolved. The dialog still starts from the last-used options for
   *   everything else; a seeded model wins over a stale remembered one.
   */
  open(seed: Partial<IllustrateOptions> = {}): Promise<IllustrateOptions | null> {
    const last = this.last();
    return new Promise(resolve => {
      this.current.set({
        count: last.count,
        style: last.style,
        storyboardPrompt: last.storyboardPrompt,
        purePictures: last.purePictures,
        modelId: last.modelId,
        providerId: last.providerId,
        ...seed,
        resolve
      });
    });
  }

  /** Confirm: remember + resolve with the chosen options. */
  submit(options: IllustrateOptions): void {
    const clamped: IllustrateOptions = {
      count: clampIllustrateCount(options.count),
      style: (options.style || '').trim(),
      storyboardPrompt: (options.storyboardPrompt || '').trim(),
      purePictures: !!options.purePictures,
      modelId: (options.modelId || '').trim(),
      providerId: (options.providerId || '').trim()
    };
    this.last.set(clamped);
    persist(clamped);
    const cur = this.current();
    if (!cur) return; // no dialog open — the values are just remembered
    this.current.set(null);
    cur.resolve(clamped);
  }

  /** Cancel: close and resolve with null. */
  cancel(): void {
    const cur = this.current();
    if (!cur) return;
    this.current.set(null);
    cur.resolve(null);
  }
}