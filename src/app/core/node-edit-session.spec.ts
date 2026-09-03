import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { ConfirmService, type ConfirmRequest } from './confirm.service';
import { NodeEditSession } from './node-edit-session';
import { NodeAttachment } from '../models/chat';

type BeginArgs = {
  chatId: string;
  nodeId: string;
  text: string;
  attachments: NodeAttachment[];
};

function attachment(
  partial: Partial<NodeAttachment> & Pick<NodeAttachment, 'id' | 'name'>
): NodeAttachment {
  return {
    mimeType: 'text/plain',
    size: 4,
    dataUrl: 'data:text/plain;base64,dGVzdA==',
    ...partial
  };
}

function target(partial: Partial<BeginArgs> = {}): BeginArgs {
  return {
    chatId: 'chat-1',
    nodeId: 'node-1',
    text: 'baseline text',
    attachments: [],
    ...partial
  };
}

const SWITCH_NODE_CONFIRM: ConfirmRequest = {
  title: 'Unsaved changes',
  message: 'This node has edits that are not saved yet.\nDiscard them and switch?',
  confirmLabel: 'Discard',
  cancelLabel: 'Keep editing',
  danger: true
};

const LEAVE_CHAT_CONFIRM: ConfirmRequest = {
  title: 'Unsaved changesa',
  message: 'This chat has edits that are not saved yet.\nDiscard them and switch?',
  confirmLabel: 'Discard',
  cancelLabel: 'Stay here',
  danger: true
};

describe('NodeEditSession', () => {
  let session: NodeEditSession;
  let confirm: ConfirmService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [NodeEditSession, ConfirmService]
    });
    session = TestBed.inject(NodeEditSession);
    confirm = TestBed.inject(ConfirmService);
  });

  function expectNoDialog(): void {
    expect(confirm.current()).toBeNull();
  }

  function expectDialog(expected: ConfirmRequest): void {
    const current = confirm.current();
    expect(current).not.toBeNull();
    expect({
      title: current!.title,
      message: current!.message,
      confirmLabel: current!.confirmLabel,
      cancelLabel: current!.cancelLabel,
      danger: current!.danger
    }).toEqual({
      title: expected.title,
      message: expected.message,
      confirmLabel: expected.confirmLabel ?? 'Discard',
      cancelLabel: expected.cancelLabel ?? 'Keep editing',
      danger: expected.danger ?? true
    });
  }

  function activeSessionCount(): number {
    return session.state() === null ? 0 : 1;
  }

  async function beginClean(next: BeginArgs, source: 'user' | 'auto' = 'user'): Promise<boolean> {
    const result = session.begin(next, source);
    expectNoDialog();
    return result;
  }

  describe('single-session invariant', () => {
    it('starts with no edit session', () => {
      expect(session.state()).toBeNull();
      expect(session.editingNodeId()).toBeNull();
      expect(session.isDirty()).toBe(false);
      expect(activeSessionCount()).toBe(0);
    });

    it('holds exactly one session after begin()', async () => {
      expect(await beginClean(target())).toBe(true);
      expect(activeSessionCount()).toBe(1);
      expect(session.editingNodeId()).toBe('node-1');
      expect(session.state()).toEqual({
        chatId: 'chat-1',
        nodeId: 'node-1',
        baselineText: 'baseline text',
        baselineAtt: '[]',
        draftText: 'baseline text',
        draftAtt: '[]'
      });
    });

    it('reuses the same session when begin() is called for the same chat+node', async () => {
      await beginClean(target({ text: 'first' }));
      session.patch('node-1', 'dirty draft', []);
      expect(session.isDirty()).toBe(true);

      const again = await session.begin(target({ text: 'ignored replacement' }));
      expect(again).toBe(true);
      expectNoDialog();
      expect(activeSessionCount()).toBe(1);
      expect(session.state()?.draftText).toBe('dirty draft');
      expect(session.state()?.baselineText).toBe('first');
    });

    it('replaces the previous clean session when beginning a different node', async () => {
      await beginClean(target({ nodeId: 'node-1' }));
      expect(await beginClean(target({ nodeId: 'node-2', text: 'other' }))).toBe(true);

      expect(activeSessionCount()).toBe(1);
      expect(session.editingNodeId()).toBe('node-2');
      expect(session.state()?.draftText).toBe('other');
      expectNoDialog();
    });

    it('never keeps two node ids in state at once', async () => {
      await beginClean(target({ nodeId: 'a' }));
      await beginClean(target({ nodeId: 'b' }));
      await beginClean(target({ nodeId: 'c', chatId: 'chat-2' }));

      const state = session.state();
      expect(state).not.toBeNull();
      expect(state?.nodeId).toBe('c');
      expect(state?.chatId).toBe('chat-2');
      expect(activeSessionCount()).toBe(1);
    });

    it('ignores patch() for a node that does not own the session', async () => {
      await beginClean(target({ nodeId: 'node-1', text: 'keep' }));
      session.patch('node-2', 'should not land', [attachment({ id: 'x', name: 'x.txt' })]);

      expect(session.editingNodeId()).toBe('node-1');
      expect(session.state()?.draftText).toBe('keep');
      expect(session.state()?.draftAtt).toBe('[]');
      expect(session.isDirty()).toBe(false);
      expect(activeSessionCount()).toBe(1);
    });

    it('does not create a session when patch() is called with no owner', () => {
      session.patch('node-1', 'orphan', []);
      expect(session.state()).toBeNull();
      expect(activeSessionCount()).toBe(0);
    });

    it('refuses an automatic begin while another node owns the session', async () => {
      await beginClean(target({ nodeId: 'node-1' }));
      session.patch('node-1', 'dirty', []);

      const allowed = await session.begin(target({ nodeId: 'node-2' }), 'auto');
      expect(allowed).toBe(false);
      expectNoDialog();
      expect(session.editingNodeId()).toBe('node-1');
      expect(session.state()?.draftText).toBe('dirty');
      expect(activeSessionCount()).toBe(1);
    });

    it('allows an automatic begin when there is no current session', async () => {
      expect(await beginClean(target({ nodeId: 'auto-node' }), 'auto')).toBe(true);
      expect(session.editingNodeId()).toBe('auto-node');
    });
  });

  describe('dirty tracking', () => {
    it('is clean immediately after begin()', async () => {
      await beginClean(target({ text: 'same', attachments: [attachment({ id: 'a', name: 'a.txt' })] }));
      expect(session.isDirty()).toBe(false);
    });

    it('becomes dirty when draft text diverges from the baseline', async () => {
      await beginClean(target({ text: 'original' }));
      session.patch('node-1', 'edited', []);
      expect(session.isDirty()).toBe(true);
    });

    it('becomes dirty when attachments diverge from the baseline', async () => {
      await beginClean(target({ attachments: [] }));
      session.patch('node-1', 'baseline text', [attachment({ id: 'att-1', name: 'note.txt' })]);
      expect(session.isDirty()).toBe(true);
      expect(session.state()?.draftAtt).toBe(
        JSON.stringify([attachment({ id: 'att-1', name: 'note.txt' })])
      );
    });

    it('is clean again when drafts are patched back to the baseline', async () => {
      await beginClean(target({ text: 'original' }));
      session.patch('node-1', 'edited', []);
      session.patch('node-1', 'original', []);
      expect(session.isDirty()).toBe(false);
    });

    it('treats attachment order as part of dirtiness', async () => {
      const a = attachment({ id: 'a', name: 'a.txt' });
      const b = attachment({ id: 'b', name: 'b.txt' });
      await beginClean(target({ attachments: [a, b] }));
      session.patch('node-1', 'baseline text', [b, a]);
      expect(session.isDirty()).toBe(true);
    });
  });

  describe('confirm dialog when the edit session changes while dirty', () => {
    it('does not ask when switching away from a clean session', async () => {
      await beginClean(target({ nodeId: 'node-1' }));
      expect(await beginClean(target({ nodeId: 'node-2' }))).toBe(true);
      expectNoDialog();
      expect(session.editingNodeId()).toBe('node-2');
    });

    it('opens the node-switch confirm dialog and keeps the old session until the user answers', async () => {
      await beginClean(target({ nodeId: 'node-1', text: 'v1' }));
      session.patch('node-1', 'unsaved', []);

      const pending = session.begin(target({ nodeId: 'node-2', text: 'v2' }));

      expectDialog(SWITCH_NODE_CONFIRM);
      expect(session.editingNodeId()).toBe('node-1');
      expect(session.state()?.draftText).toBe('unsaved');
      expect(activeSessionCount()).toBe(1);

      confirm.close(false);
      expect(await pending).toBe(false);
      expectNoDialog();
      expect(session.editingNodeId()).toBe('node-1');
      expect(session.isDirty()).toBe(true);
    });

    it('switches to the new node after the user confirms discard', async () => {
      await beginClean(target({ nodeId: 'node-1', text: 'v1' }));
      session.patch('node-1', 'unsaved', []);

      const pending = session.begin(target({
        chatId: 'chat-1',
        nodeId: 'node-2',
        text: 'fresh',
        attachments: [attachment({ id: 'n', name: 'n.md' })]
      }));

      expectDialog(SWITCH_NODE_CONFIRM);
      confirm.close(true);

      expect(await pending).toBe(true);
      expectNoDialog();
      expect(activeSessionCount()).toBe(1);
      expect(session.editingNodeId()).toBe('node-2');
      expect(session.isDirty()).toBe(false);
      expect(session.state()).toEqual({
        chatId: 'chat-1',
        nodeId: 'node-2',
        baselineText: 'fresh',
        baselineAtt: JSON.stringify([attachment({ id: 'n', name: 'n.md' })]),
        draftText: 'fresh',
        draftAtt: JSON.stringify([attachment({ id: 'n', name: 'n.md' })])
      });
    });

    it('asks when the same node is reopened in a different chat while dirty', async () => {
      await beginClean(target({ chatId: 'chat-1', nodeId: 'shared-node' }));
      session.patch('shared-node', 'moved', []);

      const pending = session.begin(target({ chatId: 'chat-2', nodeId: 'shared-node' }));
      expectDialog(SWITCH_NODE_CONFIRM);
      confirm.close(false);
      expect(await pending).toBe(false);
      expect(session.state()?.chatId).toBe('chat-1');
    });

    it('does not ask an automatic caller even when the current session is dirty', async () => {
      await beginClean(target({ nodeId: 'node-1' }));
      session.patch('node-1', 'dirty', []);

      expect(await session.begin(target({ nodeId: 'node-2' }), 'auto')).toBe(false);
      expectNoDialog();
      expect(session.editingNodeId()).toBe('node-1');
    });

    it('does not ask when re-beginning the exact same chat+node even if dirty', async () => {
      await beginClean(target());
      session.patch('node-1', 'still here', []);
      expect(await session.begin(target({ text: 'other baseline' }))).toBe(true);
      expectNoDialog();
      expect(session.state()?.draftText).toBe('still here');
    });
  });

  describe('canLeaveChat', () => {
    it('allows leaving when there is no session', async () => {
      expect(await session.canLeaveChat('chat-2')).toBe(true);
      expectNoDialog();
      expect(session.state()).toBeNull();
    });

    it('allows staying on the same chat without a dialog', async () => {
      await beginClean(target({ chatId: 'chat-1' }));
      session.patch('node-1', 'dirty on this chat', []);

      expect(await session.canLeaveChat('chat-1')).toBe(true);
      expectNoDialog();
      expect(session.editingNodeId()).toBe('node-1');
      expect(session.isDirty()).toBe(true);
    });

    it('abandons a clean session when switching chats, without a dialog', async () => {
      await beginClean(target({ chatId: 'chat-1' }));
      expect(await session.canLeaveChat('chat-2')).toBe(true);
      expectNoDialog();
      expect(session.state()).toBeNull();
      expect(activeSessionCount()).toBe(0);
    });

    it('opens the leave-chat confirm dialog when the current session is dirty', async () => {
      await beginClean(target({ chatId: 'chat-1' }));
      session.patch('node-1', 'unsaved chat work', []);

      const pending = session.canLeaveChat('chat-2');
      expectDialog(LEAVE_CHAT_CONFIRM);
      expect(session.editingNodeId()).toBe('node-1');

      confirm.close(false);
      expect(await pending).toBe(false);
      expect(session.editingNodeId()).toBe('node-1');
      expect(session.isDirty()).toBe(true);
      expect(activeSessionCount()).toBe(1);
    });

    it('clears the only session after the user confirms discard on chat switch', async () => {
      await beginClean(target({ chatId: 'chat-1' }));
      session.patch('node-1', 'unsaved chat work', []);

      const pending = session.canLeaveChat('chat-2');
      expectDialog(LEAVE_CHAT_CONFIRM);
      confirm.close(true);

      expect(await pending).toBe(true);
      expectNoDialog();
      expect(session.state()).toBeNull();
      expect(session.editingNodeId()).toBeNull();
      expect(activeSessionCount()).toBe(0);
    });
  });

  describe('abandon / commit', () => {
    it('abandon() without an id clears the current session', async () => {
      await beginClean(target());
      session.abandon();
      expect(session.state()).toBeNull();
    });

    it('abandon(nodeId) only clears when that node owns the session', async () => {
      await beginClean(target({ nodeId: 'node-1' }));
      session.abandon('node-other');
      expect(session.editingNodeId()).toBe('node-1');
      session.abandon('node-1');
      expect(session.state()).toBeNull();
    });

    it('commit(nodeId) only clears when that node owns the session', async () => {
      await beginClean(target({ nodeId: 'node-1' }));
      session.commit('node-other');
      expect(session.editingNodeId()).toBe('node-1');
      session.commit('node-1');
      expect(session.state()).toBeNull();
    });

    it('commit() without an id clears the current session', async () => {
      await beginClean(target());
      session.commit();
      expect(session.state()).toBeNull();
      expect(activeSessionCount()).toBe(0);
    });
  });
});
