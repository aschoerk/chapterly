import { Injectable, signal } from '@angular/core';

/**
 * State of the open "Prepend director" dialog: the proposed (or existing)
 * director instruction text, prefilled and editable, plus whether a director
 * already exists for this node (so the dialog can offer removal).
 */
export interface PrependDialogState {
  /** The proposed / existing director text (pre-filled, editable). */
  text: string;
  /** Whether a director instruction already exists for the current node. */
  hasExisting: boolean;
  /** Collect the modal result. Resolves null when the user cancels. */
  resolve: (value: string | null) => void;
}

/**
 * Holds the open state of the "Prepend director" dialog (mounted once in the
 * app root, mirroring ConfirmDialog / IllustrateDialog). Lets the user edit
 * the director instruction that will be prepended to the following chapters.
 */
@Injectable({ providedIn: 'root' })
export class PrependDialogService {
  /** The dialog entry, or null when the dialog is closed. */
  readonly current = signal<PrependDialogState | null>(null);

  /**
   * Open the dialog prefilled with `text`. Resolves with the (possibly
   * edited) director text, or null on cancel.
   */
  open(text: string, hasExisting: boolean): Promise<string | null> {
    return new Promise(resolve => {
      this.current.set({ text, hasExisting, resolve });
    });
  }

  /** Confirm with the edited text. An empty text removes the director. */
  submit(text: string): void {
    const cur = this.current();
    if (!cur) return;
    this.current.set(null);
    cur.resolve(text ?? '');
  }

  /** Cancel — close without changing the stored text. */
  cancel(): void {
    const cur = this.current();
    if (!cur) return;
    this.current.set(null);
    cur.resolve(null);
  }
}