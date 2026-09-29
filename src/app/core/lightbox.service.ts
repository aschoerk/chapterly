import { Injectable, signal } from '@angular/core';

/** Open state of the in-app image lightbox. */
export interface LightboxState {
  /** Image URLs to display (data: or https://…). */
  urls: string[];
  /** Index of the currently shown image. */
  index: number;
}

/**
 * Owns the open state of the image lightbox (mounted once in the app root,
 * mirroring ConfirmService/IllustrateDialogService). Opening an image in a
 * lightbox avoids `window.open(dataUrl, '_blank')`, which Chromium (Chrome +
 * Electron) blocks for `data:` URLs — Firefox allows it, which is why clicking
 * a thumbnail only worked in Firefox.
 */
@Injectable({ providedIn: 'root' })
export class LightboxService {
  /** The open lightbox, or null when closed. */
  readonly current = signal<LightboxState | null>(null);

  /** Open the lightbox with a list of images at the given index. */
  open(urls: string[], index = 0): void {
    if (!urls.length) return;
    const clamped = Math.min(Math.max(index, 0), urls.length - 1);
    this.current.set({ urls, index: clamped });
  }

  /** Show the next image (wraps). No-op for a single image. */
  next(): void {
    this.current.update(s => {
      if (!s || s.urls.length < 2) return s;
      return { ...s, index: (s.index + 1) % s.urls.length };
    });
  }

  /** Show the previous image (wraps). No-op for a single image. */
  prev(): void {
    this.current.update(s => {
      if (!s || s.urls.length < 2) return s;
      return { ...s, index: (s.index - 1 + s.urls.length) % s.urls.length };
    });
  }

  /** Close the lightbox. */
  close(): void {
    this.current.set(null);
  }
}