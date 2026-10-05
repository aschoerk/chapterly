import { Injectable, signal } from '@angular/core';
import { Chat, ChatNode } from '../models/chat';
import type { RewriteContextMode } from './llm/orchestration';

/**
 * State of the open "Rewrite selection" dialog: the marked fragment (editable),
 * the free-form directions, the chosen context scope, the default model and the
 * resolve callback. The dialog itself runs the LLM and resolves with the final
 * text that should replace the marked range — or null when cancelled.
 */
export interface RewriteDialogState {
  /** The marked text, editable in the dialog (what gets rewritten). */
  fragment: string;
  /** Free-form directions / hints how the text should change. */
  directions: string;
  /** How much surrounding context the model should see. */
  contextMode: RewriteContextMode;
  /** Offset in the node content up to which context is included ('upto'). */
  selectionEnd: number;
  /** The node containing the marked text. */
  node: ChatNode;
  /** The chat the node belongs to (null-safe). */
  chat: Chat | null;
  /** Default model (the one that created the node), overridable. */
  modelId: string;
  /** Provider of the default model. */
  providerId: string;
  /** Collect the modal result. Resolves the text or null on cancel. */
  resolve: (value: string | null) => void;
}

/**
 * Holds the open state of the "Rewrite selection" dialog (mounted once in the
 * app root, mirroring ConfirmDialog / PrependDialog). The caller supplies the
 * marked fragment + node context and receives the text to replace the
 * selection with.
 */
@Injectable({ providedIn: 'root' })
export class RewriteDialogService {
  /** The dialog entry, or null when the dialog is closed. */
  readonly current = signal<RewriteDialogState | null>(null);

  /**
   * Open the dialog for a marked piece of text. Resolves with the text to
   * insert in place of the marked range, or null when the user cancels.
   */
  open(opts: {
    fragment: string;
    directions?: string;
    contextMode?: RewriteContextMode;
    selectionEnd: number;
    node: ChatNode;
    chat: Chat | null;
    modelId: string;
    providerId?: string;
  }): Promise<string | null> {
    return new Promise(resolve => {
      this.current.set({
        fragment: opts.fragment,
        directions: opts.directions ?? '',
        contextMode: opts.contextMode ?? 'node',
        selectionEnd: opts.selectionEnd,
        node: opts.node,
        chat: opts.chat,
        modelId: opts.modelId,
        providerId: opts.providerId ?? '',
        resolve
      });
    });
  }

  /** Confirm with the chosen text (replaces the marked range). */
  close(text: string): void {
    const cur = this.current();
    if (!cur) return;
    this.current.set(null);
    cur.resolve(text);
  }

  /** Cancel — close without changing anything. */
  cancel(): void {
    const cur = this.current();
    if (!cur) return;
    this.current.set(null);
    cur.resolve(null);
  }
}