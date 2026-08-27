import {NodeAttachment} from '../models/chat';
import {computed, inject, Injectable, signal} from '@angular/core';
import {ConfirmDialogComponent} from '../components/confirm-dialog/confirm-dialog.component';
import {ConfirmService} from './confirm.service';

type EditorState = {
  chatId: string;
  nodeId: string;
  baselineText: string;
  baselineAtt: string;
  draftText: string;
  draftAtt: string;
};

@Injectable({ providedIn: 'root' })
export class NodeEditSession {
  readonly confirm = inject(ConfirmService)
  readonly state = signal<EditorState | null>(null);
  readonly editingNodeId = computed(() => this.state()?.nodeId ?? null);

  isDirty(): boolean {
    const s = this.state();
    if (!s) return false;
    return s.draftText !== s.baselineText || s.draftAtt !== s.baselineAtt;
  }

  /** true → caller may leave this chat. false → stay. */
  async canLeaveChat(nextChatId: string): Promise<boolean> {
    const cur = this.state();
    if (!cur || cur.chatId === nextChatId) return true;

    if (this.isDirty()) {
      const discard = await this.confirm.ask({
        title: 'Unsaved changesa',
        message: 'This chat has edits that are not saved yet.\nDiscard them and switch?',
        confirmLabel: 'Discard',
        cancelLabel: 'Stay here',
        danger: true
      });
      if (!discard) return false;
    }

    this.abandon();
    return true;
  }

  /** Opening an editor, or moving it to another node. */
  async begin(next: {
    chatId: string;
    nodeId: string;
    text: string;
    attachments: NodeAttachment[];
  }, source: 'user' | 'auto' = 'user'): Promise<boolean> {
    const cur = this.state();

    if (cur?.nodeId === next.nodeId && cur.chatId === next.chatId) {
      return true; // same editor
    }

    if (cur) {
      if (source === 'auto') return false;
      if (this.isDirty()) {
        const discard = await this.confirm.ask({
          title: 'Unsaved changes',
          message: 'This node has edits that are not saved yet.\nDiscard them and switch?',
          confirmLabel: 'Discard',
          cancelLabel: 'Keep editing',
          danger: true
        });
        if (!discard) return false;
      }
    }

    const att = JSON.stringify(next.attachments ?? []);
    this.state.set({
      chatId: next.chatId,
      nodeId: next.nodeId,
      baselineText: next.text,
      baselineAtt: att,
      draftText: next.text,
      draftAtt: att
    });
    return true;
  }

  /** Keystrokes / attach / detach — only while this node owns the editor. */
  patch(nodeId: string, text: string, attachments: NodeAttachment[]): void {
    const cur = this.state();
    if (!cur || cur.nodeId !== nodeId) return;
    this.state.update(s => s && {
      ...s,
      draftText: text,
      draftAtt: JSON.stringify(attachments ?? [])
    });
  }

  /** Cancel, or a confirmed discard. */
  abandon(nodeId?: string): void {
    if (!nodeId || this.state()?.nodeId === nodeId) this.state.set(null);
  }

  commit(nodeId?: string): void {
    if (!nodeId || this.state()?.nodeId === nodeId) this.state.set(null);
  }
}
