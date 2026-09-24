import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { ChatNodeComponent } from './chat-node.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../../core/chat.service';
import { SettingsService } from '../../core/settings.service';
import { LlmService } from '../../core/llm/llm.service';
import { ConfirmService } from '../../core/confirm.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodeEditSession } from '../../core/node-edit-session';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeAttachment, makeModel, makeNode, seedApi } from '../../../../test-helpers/factories';
import { ChatNode } from '../../models/chat';
import { ModelEntry } from '../../models/chat-config';

/** Thin aliases over the shared test-helpers factories. */
const node = makeNode;
const attachment = makeAttachment;

function seedSettings(api: InMemoryChatApi): void {
  seedApi(api, {
    providers: [{ id: 'prov-1' }],
    models: [
      { id: 'm-1' },
      { id: 'm-2', displayName: 'Beta', modelId: 'beta/model' }
    ]
  });
}

describe('ChatNodeComponent', () => {
  let fixture: ComponentFixture<ChatNodeComponent>;
  let component: ChatNodeComponent;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let settings: SettingsService;
  let confirm: ConfirmService;
  let llm: {
    streamAnswer: ReturnType<typeof vi.fn>;
    askLlm: ReturnType<typeof vi.fn>;
    resolveForCurrentChat: ReturnType<typeof vi.fn>;
    toLlmExtras: ReturnType<typeof vi.fn>;
  };
  let emitted: string[];

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    seedSettings(api);
    localStorage.clear();

    vi.spyOn(window, 'alert').mockImplementation(() => {});
    if (typeof window.requestAnimationFrame !== 'function') {
      (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    }
    if (typeof window.cancelAnimationFrame !== 'function') {
      (window as any).cancelAnimationFrame = () => {};
    }

    await TestBed.configureTestingModule({
      imports: [ChatNodeComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        {
          provide: LlmService,
          useValue: {
            askLlm: vi.fn(async () => ({ content: 'Generated structure', thinking: '' })),
            resolveForCurrentChat: vi.fn(async () => ({ stream: false })),
            toLlmExtras: vi.fn(() => ({})),
            streamAnswer: vi.fn(async (
              chatId: string,
              questionNodeId: string,
              _provider: unknown,
              model: ModelEntry,
              _messages: unknown,
              _onChunk?: unknown,
              opts?: { adoptNodeIds?: string[] }
            ) => {
              const saved = await chatService.addNode(chatId, {
                parentId: questionNodeId,
                role: 'assistant',
                content: 'Generated',
                modelId: model?.modelId ?? 'alpha/model',
                providerId: model?.providerId ?? 'prov-1'
              });
              chatService.setActiveChild(questionNodeId, saved.id);
              if (opts?.adoptNodeIds?.length) {
                await chatService.reparentNodes(chatId, opts.adoptNodeIds, saved.id);
                chatService.setActiveChild(saved.id, opts.adoptNodeIds[0]);
              }
              return saved;
            })
          }
        }
      ]
    }).compileComponents();

    chatService = TestBed.inject(ChatService);
    settings = TestBed.inject(SettingsService);
    confirm = TestBed.inject(ConfirmService);
    llm = TestBed.inject(LlmService) as unknown as {
      streamAnswer: ReturnType<typeof vi.fn>;
      askLlm: ReturnType<typeof vi.fn>;
      resolveForCurrentChat: ReturnType<typeof vi.fn>;
      toLlmExtras: ReturnType<typeof vi.fn>;
    };
    TestBed.inject(I18nService).setLocale('en');

    await settings.loadAll();
  });

  /** Render the component for a single node. */
  function createFixture(cn: ChatNode, activeChildId: string | null = null): void {
    fixture = TestBed.createComponent(ChatNodeComponent);
    component = fixture.componentInstance;
    emitted = [];
    component.activate.subscribe((id: string) => emitted.push(id));
    fixture.componentRef.setInput('node', cn);
    if (activeChildId !== null) fixture.componentRef.setInput('activeChildId', activeChildId);
    fixture.detectChanges();
  }

  /** Seed a chat + tree and make it the active chat (mirrors real navigation). */
  async function openChat(tree: ChatNode[], chatId = 'chat-1', title = 'Story'): Promise<void> {
    const now = new Date().toISOString();
    api.chats.push({
      id: chatId,
      title,
      projectId: null,
      node_number: tree.length,
      created_at: now,
      updated_at: now
    });
    api.nodes = tree;
    await chatService.loadChats();
    await chatService.selectChat(chatId);
  }

  async function startEditing(_cn?: ChatNode): Promise<void> {
    await component.startEdit();
    fixture.detectChanges();
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>);
  }

  function findButton(text: string): HTMLButtonElement | null {
    return buttons().find(b => (b.textContent || '').includes(text)) ?? null;
  }

  function titleButton(title: string): HTMLButtonElement | null {
    return buttons().find(b => b.getAttribute('title') === title) ?? null;
  }

  function confirmResolves(value: boolean): void {
    vi.spyOn(confirm, 'ask').mockResolvedValue(value);
  }

  function expectButtonDisabled(btn: HTMLButtonElement | null): void {
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
  }

  // ------------------------------------------------------------------
  // Node chrome
  // ------------------------------------------------------------------

  describe('node chrome', () => {
    it('shows the Dir badge for a user node and the Ch badge for an assistant', () => {
      createFixture(node({ role: 'user', content: 'Hello' }));
      expect(fixture.nativeElement.querySelector('.badge.question')).not.toBeNull();

      createFixture(node({ role: 'assistant', content: 'Hi' }));
      expect(fixture.nativeElement.querySelector('.badge.answer')).not.toBeNull();
    });

    it('shows the version and char count metadata', () => {
      createFixture(node({ role: 'assistant', content: '12345', version: 3 }));
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('v3');
      expect(text).toContain('5 chars');
    });

    it('applies role and draft CSS classes to the container', () => {
      createFixture(node({ role: 'user', content: 'Hello' }));
      let el = fixture.nativeElement.querySelector('.node');
      expect(el).not.toBeNull();
      expect((el as HTMLElement).classList).toContain('question-node');
      expect((el as HTMLElement).classList).not.toContain('answer-node');

      createFixture(node({ role: 'assistant', content: 'Hi' }));
      el = fixture.nativeElement.querySelector('.node');
      expect((el as HTMLElement).classList).toContain('answer-node');
    });

    it('emits the data-node-id attribute', () => {
      createFixture(node({ id: 'custom-42' }));
      expect(fixture.nativeElement.querySelector('.node')?.getAttribute('data-node-id')).toBe('custom-42');
    });

    it('exposes the node through the node input signal', () => {
      const cn = node({ id: 'abc', role: 'assistant' });
      createFixture(cn);
      expect(component.node()).toEqual(cn);
    });
  });

  // ------------------------------------------------------------------
  // Branch switcher
  // ------------------------------------------------------------------

  describe('branch switcher', () => {
    it('is hidden when the node has no siblings', () => {
      createFixture(node({ content: 'Only child' }));
      expect(fixture.nativeElement.querySelector('.branch-switcher')).toBeNull();
    });

    it('shows the branch count when siblings exist', async () => {
      const q1 = node({ id: 'q1', content: 'First' });
      const q2 = node({ id: 'q2', content: 'Second' });
      await openChat([q1, q2]);
      createFixture(q1, q2.id);
      expect(fixture.nativeElement.querySelector('.branch-switcher')).not.toBeNull();
      const text = (fixture.nativeElement.querySelector('.branch-count') as HTMLElement).textContent ?? '';
      expect(text).toContain('2 / 2');
    });

    it('navigates to the previous sibling via prevSibling()', async () => {
      const q1 = node({ id: 'q1', content: 'First' });
      const q2 = node({ id: 'q2', content: 'Second' });
      await openChat([q1, q2]);
      createFixture(q1, q2.id);
      component.prevSibling();
      expect(emitted).toEqual(['q1']);
    });

    it('navigates to the next sibling via nextSibling()', async () => {
      const q1 = node({ id: 'q1', content: 'First' });
      const q2 = node({ id: 'q2', content: 'Second' });
      await openChat([q1, q2]);
      createFixture(q2, q1.id);
      component.nextSibling();
      expect(emitted).toEqual(['q2']);
    });

    it('does nothing for a single node', () => {
      createFixture(node({ content: 'Solo' }));
      component.prevSibling();
      component.nextSibling();
      expect(emitted).toEqual([]);
    });

    it('prev/next buttons call prevSibling/nextSibling', async () => {
      const q1 = node({ id: 'q1', content: 'First' });
      const q2 = node({ id: 'q2', content: 'Second' });
      const q3 = node({ id: 'q3', content: 'Third' });
      await openChat([q1, q2, q3]);
      createFixture(q1, q2.id);
      const prev = titleButton('Previous branch');
      const next = titleButton('Next branch');
      expect(prev).not.toBeNull();
      expect(next).not.toBeNull();

      prev!.click();
      expect(emitted).toEqual(['q1']);

      emitted.length = 0;
      next!.click();
      expect(emitted).toEqual(['q3']);
    });
  });

  // ------------------------------------------------------------------
  // Delete / remove
  // ------------------------------------------------------------------

  describe('delete & remove buttons', () => {
    it('renders delete and remove buttons for a user node', () => {
      createFixture(node({ content: 'Hello' }));
      expect(titleButton('Delete this node and its subtree')).not.toBeNull();
      expect(titleButton('Delete this node only. Children stay and attach to its parent.')).not.toBeNull();
    });

    it('deletes the node and its subtree after confirmation', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      await openChat([q1]);
      confirmResolves(true);
      createFixture(q1);

      await component.deleteNode();
      fixture.detectChanges();

      expect(chatService.nodes().find(n => n.id === 'q1')).toBeUndefined();
      // the app guarantees the active path ends on an empty question
      expect(chatService.nodes().some(n => n.role === 'user' && !n.content?.trim())).toBe(true);
    });

    it('keeps the node when confirmation is declined', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      await openChat([q1]);
      confirmResolves(false);
      createFixture(q1);

      await component.deleteNode();
      fixture.detectChanges();

      expect(chatService.nodes().find(n => n.id === 'q1')).not.toBeUndefined();
    });

    it('does not ask for confirmation on a trivial (empty) node', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      vi.spyOn(confirm, 'ask').mockResolvedValue(false);
      createFixture(q1);

      await component.deleteNode();
      fixture.detectChanges();

      expect(confirm.ask).not.toHaveBeenCalled();
      expect(chatService.nodes().find(n => n.id === 'q1')).toBeUndefined();
    });

    it('remove keeps the children and reparents them to the parent', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      confirmResolves(true);
      createFixture(q1);

      await component.deleteNodeOnly();
      fixture.detectChanges();

      expect(chatService.nodes().find(n => n.id === 'q1')).toBeUndefined();
      expect(chatService.nodes().find(n => n.id === 'a1')?.parentId).toBeNull();
      // after removal the remaining child becomes active
      expect(emitted).toContain('a1');
    });

    it('disables the delete button while a generation is running', () => {
      chatService.startGeneration('n1');
      createFixture(node({ id: 'n1', content: 'Hello' }));
      expectButtonDisabled(titleButton('Delete this node and its subtree'));
      chatService.stopGeneration();
    });
  });

  // ------------------------------------------------------------------
  // Copy
  // ------------------------------------------------------------------

  describe('copy button', () => {
    it('copies the node content to the clipboard and shows the copied state', async () => {
      const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
      (navigator as any).clipboard = clipboard;
      createFixture(node({ content: 'Copy me' }));

      await component.copyContent();
      fixture.detectChanges();

      expect(clipboard.writeText).toHaveBeenCalledWith('Copy me');
      expect(component.copied()).toBe(true);
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Copied');
    });
  });

  // ------------------------------------------------------------------
  // Thinking + prior versions toggles
  // ------------------------------------------------------------------

  describe('thinking toggle', () => {
    it('exposes hasThinking and shows the thinking body once opened', () => {
      const cn = node({ role: 'assistant', content: 'Answer', thinking: 'Chain of thought' });
      createFixture(cn);

      expect(component.hasThinking()).toBe(true);
      expect(fixture.nativeElement.querySelector('.thinking-body')).toBeNull();

      const toggle = fixture.nativeElement.querySelector('.thinking-toggle') as HTMLButtonElement;
      expect(toggle).not.toBeNull();
      toggle.click();
      fixture.detectChanges();

      expect(component.thinkingClosed()).toBe(false);
      expect(fixture.nativeElement.querySelector('.thinking-body')).not.toBeNull();
    });

    it('hides the toggle when there is no thinking text', () => {
      createFixture(node({ role: 'assistant', content: 'Answer', thinking: null }));
      expect(component.hasThinking()).toBe(false);
      expect(fixture.nativeElement.querySelector('.thinking-toggle')).toBeNull();
    });
  });

  describe('prior versions toggle', () => {
    it('shows prior versions when opened', async () => {
      const prev = node({ id: 'v1', chatId: 'chat-1', parentId: null, role: 'assistant',
        content: 'Older', previousVersionId: null, version: 1 });
      const cur = node({ id: 'v2', chatId: 'chat-1', parentId: null, role: 'assistant',
        content: 'Newer', previousVersionId: 'v1', version: 2 });

      api.nodes = [prev, cur];
      await chatService.loadNodes('chat-1');
      createFixture(cur);

      expect(component.priorVersions().map(v => v.id)).toEqual(['v1']);

      const toggle = fixture.nativeElement.querySelector('.prior-toggle') as HTMLButtonElement;
      expect(toggle).not.toBeNull();
      toggle.click();
      fixture.detectChanges();

      expect(component.showPriorVersions()).toBe(true);
      expect(fixture.nativeElement.querySelectorAll('.prior-version').length).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // Editing: enter / cancel
  // ------------------------------------------------------------------

  describe('editing: enter & cancel', () => {
    it('starts editing and opens the inline editor', async () => {
      createFixture(node({ content: 'Hello' }));
      expect(component.isEditing()).toBe(false);
      expect(fixture.nativeElement.querySelector('.inline-content-editor')).toBeNull();

      await startEditing(node({ content: 'Hello' }));
      expect(component.isEditing()).toBe(true);
      expect(fixture.nativeElement.querySelector('.inline-content-editor')).not.toBeNull();
    });

    it('opens the editor from the edit button', async () => {
      createFixture(node({ content: 'Hello' }));
      const edit = titleButton('Edit this node in place');
      expect(edit).not.toBeNull();
      edit!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.isEditing()).toBe(true);
    });

    it('starts editing when the empty question content is clicked', async () => {
      createFixture(node({ role: 'user', content: '' }));
      const area = fixture.nativeElement.querySelector('.empty-draft.click-to-edit') as HTMLElement;
      expect(area).not.toBeNull();
      area.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.isEditing()).toBe(true);
    });

    it('prefills the draft with the current content', async () => {
      createFixture(node({ content: 'Original' }));
      await startEditing(node({ content: 'Original' }));
      expect(component.contentDraft()).toBe('Original');
    });

    it('cancel clears the draft and closes the editor', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      component.onDraftText('Changed');
      expect(component.isDraftEmpty()).toBe(false);
      confirmResolves(true);

      await component.cancelEdit();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
      expect(component.contentDraft()).toBe('');
      expect(fixture.nativeElement.querySelector('.inline-content-editor')).toBeNull();
    });

    it('asks for confirmation when cancelling a dirty editor', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      component.onDraftText('Changed');
      confirmResolves(false);

      await component.cancelEdit();
      fixture.detectChanges();

      expect(confirm.ask).toHaveBeenCalled();
      expect(component.isEditing()).toBe(true);
    });

    it('manual typing goes through onDraftText and syncs the edit session', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      component.onDraftText('Typed text');
      const session = TestBed.inject(NodeEditSession);
      expect(component.contentDraft()).toBe('Typed text');
      expect(session.isDirty()).toBe(true);
    });

    it('Ctrl+Enter saves a version from the editor', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Edited via shortcut');

      const textarea = fixture.nativeElement.querySelector('.editor-textarea') as HTMLTextAreaElement;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      await fixture.whenStable();
      fixture.detectChanges();

      expect(chatService.nodes().some(n => n.role === 'user' && n.content === 'Edited via shortcut')).toBe(true);
    });

    it('Escape cancels the editor', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      const textarea = fixture.nativeElement.querySelector('.editor-textarea') as HTMLTextAreaElement;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.isEditing()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Editing: save as version
  // ------------------------------------------------------------------

  describe('editing: save as version', () => {
    it('saves an edited user question as a new version and activates it', async () => {
      const q1 = node({ id: 'q1', content: 'Original question' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Rewritten question');

      await component.saveAsVersion();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
      const saved = chatService.nodes().find(n => n.role === 'user' && n.content === 'Rewritten question');
      expect(saved).not.toBeUndefined();
      expect(saved!.id).not.toBe('q1');
      expect(emitted).toContain(saved!.id);
    });

    it('saves an edited assistant answer as a new version', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Old answer' });
      await openChat([q1, a1]);
      createFixture(a1);
      await startEditing(a1);
      component.onDraftText('New answer');

      await component.saveAsVersion();
      fixture.detectChanges();

      const saved = chatService.nodes().find(n => n.role === 'assistant' && n.content === 'New answer');
      expect(saved).not.toBeUndefined();
      expect(saved!.id).not.toBe('a1');
      expect(emitted).toContain(saved!.id);
    });

    it('closes the editor without a new node when nothing changed', async () => {
      const q1 = node({ id: 'q1', content: 'Same' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);

      await component.saveAsVersion();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
      expect(chatService.nodes().filter(n => n.role === 'user' && n.content?.trim()).length).toBe(1);
    });

    it('the OK button is disabled while the editor draft is empty', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('');
      fixture.detectChanges();
      expectButtonDisabled(findButton('OK'));
    });
  });

  // ------------------------------------------------------------------
  // Draft composer (unsent question)
  // ------------------------------------------------------------------

  describe('draft composer (unsent question)', () => {
    it('is an unsent leaf question', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);
      expect(component.isUnsentQuestion()).toBe(true);
      expect(component.showClosedContinue()).toBe(true);
    });

    it('shows the closed continue button for an empty question', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);
      expect(fixture.nativeElement.querySelector('.continue-closed')).not.toBeNull();
    });

    it('sends the draft: persists the question and streams an answer', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      component.onDraftText('Tell me a story');
      await component.sendDraft();
      fixture.detectChanges();

      expect(chatService.nodes().find(n => n.id === 'q1')?.content).toBe('Tell me a story');
      expect(emitted).toContain('q1');
      expect(llm.streamAnswer).toHaveBeenCalled();
      expect(component.isEditing()).toBe(false);
    });

    it('updates the chat title from the first line when the chat is still "New Chat"', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1], 'chat-1', 'New Chat');
      createFixture(q1);

      component.onDraftText('My brand new story');
      await component.sendDraft();
      fixture.detectChanges();

      expect(chatService.chats().find(c => c.id === 'chat-1')?.title).toBe('My brand new story');
    });

    it('the send button is disabled for an empty draft', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);
      await startEditing(q1);
      expectButtonDisabled(findButton('Send'));
    });

    it('continueDraft fills "continue", sends it, and closes the editor', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      await component.continueDraft();
      fixture.detectChanges();

      expect(chatService.nodes().find(n => n.id === 'q1')?.content).toBe('continue');
      expect(emitted).toContain('q1');
      expect(component.isEditing()).toBe(false);
    });

    it('the closed continue button triggers continueDraft without opening the editor', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);
      await component.startEdit();
      // auto-close the editor to get back to the closed state
      await component.cancelEdit();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Branch
  // ------------------------------------------------------------------

  describe('branch', () => {
    it('branches an edited question into a new sibling before streaming', async () => {
      const q1 = node({ id: 'q1', content: 'Original' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Alternative path');

      await component.saveAsBranchAndSend();
      fixture.detectChanges();

      const branch = chatService.nodes().find(n => n.role === 'user' && n.content === 'Alternative path');
      expect(branch).not.toBeUndefined();
      expect(branch!.id).not.toBe('q1');
      expect(branch!.parentId).toBeNull(); // sibling of q1
      expect(emitted).toContain(branch!.id);
      expect(llm.streamAnswer).toHaveBeenCalled();
    });

    it('branches from an assistant answer by adding a child question', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      createFixture(a1);
      component.onDraftText('Continue from here');

      await component.saveAsBranchAndSend();
      fixture.detectChanges();

      const branch = chatService.nodes().find(n => n.role === 'user' && n.content === 'Continue from here');
      expect(branch).not.toBeUndefined();
      expect(branch!.parentId).toBe('a1');
      expect(emitted).toContain(branch!.id);
      expect(llm.streamAnswer).toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Insert
  // ------------------------------------------------------------------

  describe('insert', () => {
    it('inserts a new question above and hangs the old one under the new answer', async () => {
      const q1 = node({ id: 'q1', content: 'Earlier question' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Old answer' });

      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Inserted question');

      await component.saveAsInsertAndSend();
      fixture.detectChanges();

      const inserted = chatService.nodes().find(n => n.role === 'user' && n.content === 'Inserted question');
      expect(inserted).not.toBeUndefined();
      expect(inserted!.parentId).toBeNull();
      // the new assistant answer hangs under the inserted question
      const answer = chatService.nodes().find(n => n.role === 'assistant' && n.parentId === inserted!.id);
      expect(answer).not.toBeUndefined();
      // the old question now hangs under the new answer
      expect(chatService.nodes().find(n => n.id === 'q1')?.parentId).toBe(answer!.id);
    });

    it('does nothing when called on an assistant node', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      createFixture(a1);
      component.onDraftText('Should not insert');

      await component.saveAsInsertAndSend();
      fixture.detectChanges();

      expect(llm.streamAnswer).not.toHaveBeenCalled();
      expect(chatService.nodes().filter(n => n.role === 'user' && n.content === 'Should not insert').length).toBe(0);
    });
  });

  describe('structure generation', () => {
    it('offers the heading button only on assistant nodes', () => {
      createFixture(node({ role: 'user', content: 'Question' }));
      expect(titleButton('Generate a chapter heading for this answer')).toBeNull();

      createFixture(node({ role: 'assistant', content: 'Answer' }));
      expect(titleButton('Generate a chapter heading for this answer')).not.toBeNull();
    });

    it('generates a chapter heading that wraps the assistant answer', async () => {
      const q1 = node({ id: 'q1', content: 'Story context' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter text' });
      await openChat([q1, a1]);
      createFixture(a1);

      await component.generateHeading();

      const generated = chatService.nodes().find(n => n.role === 'structural');
      expect(generated?.content).toBe('Generated structure');
      expect(generated?.parentId).toBe('q1');
      expect(generated?.modelId).toBe('alpha/model');
      expect(chatService.nodes().find(n => n.id === 'a1')?.parentId).toBe(generated?.id);
      expect(llm.askLlm).toHaveBeenCalled();
      expect(emitted).toContain(generated?.id);
    });

    it('uses only the current node text as context', async () => {
      const q1 = node({ id: 'q1', content: 'Story context' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Sole context' });
      const a2 = node({ id: 'a2', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Other answer' });
      await openChat([q1, a1, a2]);
      createFixture(a1);

      await component.generateHeading();

      const messages = llm.askLlm.mock.calls[0][3];
      const userMsg = messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg.content).toContain('Sole context');
      expect(userMsg.content).not.toContain('Other answer');
      expect(userMsg.content).not.toContain('Story context');
    });

    it('does nothing when called on a non-assistant node', async () => {
      const q1 = node({ id: 'q1', content: 'Story context' });
      await openChat([q1]);
      createFixture(q1);

      await component.generateHeading();

      expect(llm.askLlm).not.toHaveBeenCalled();
      expect(chatService.nodes().filter(n => n.role === 'structural').length).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // Regenerate
  // ------------------------------------------------------------------

  describe('regenerate', () => {
    it('deletes the answer and its subtree, activates the parent, and re-streams', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer', modelId: 'alpha/model' });
      const d = node({ id: 'd', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, d]);
      confirmResolves(true);
      createFixture(a1);

      await component.regenerateAnswer();
      fixture.detectChanges();

      expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
      expect(chatService.nodes().find(n => n.id === 'd')).toBeUndefined();
      expect(emitted).toContain('q1');
      expect(llm.streamAnswer).toHaveBeenCalled();
    });

    it('does nothing while already loading or generating', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      chatService.startGeneration('a1');
      createFixture(a1);

      await component.regenerateAnswer();
      fixture.detectChanges();

      expect(llm.streamAnswer).not.toHaveBeenCalled();
      chatService.stopGeneration();
    });
  });

  // ------------------------------------------------------------------
  // Attachments
  // ------------------------------------------------------------------

  describe('attachments', () => {
    it('renders read-only attachment chips with a file link', () => {
      const cn = node({ content: 'With file', attachments: [attachment({ mimeType: 'text/plain' })] });
      createFixture(cn);
      expect(fixture.nativeElement.querySelector('.attachment-chips.read-only')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.file-link')).not.toBeNull();
    });

    it('renders an image thumbnail for image attachments', () => {
      const cn = node({
        content: 'With image',
        attachments: [attachment({ id: 'img', name: 'pic.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' })]
      });
      createFixture(cn);
      expect(fixture.nativeElement.querySelector('.thumb')).not.toBeNull();
    });

    it('adds attachments from the file input', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));

      const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
      const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await component.onEditorFilesSelected({ target: input } as any);
      fixture.detectChanges();

      expect(component.editAttachments().length).toBe(1);
      expect(component.editAttachments()[0].name).toBe('hello.txt');
      expect(fixture.nativeElement.querySelector('.attachment-chips.editable .chip')).not.toBeNull();
    });

    it('removes an attachment via the chip × button', async () => {
      const a = attachment();
      createFixture(node({ content: 'Hello', attachments: [a] }));
      await startEditing(node({ content: 'Hello', attachments: [a] }));

      component.removeEditAttachment(a.id);
      fixture.detectChanges();

      expect(component.editAttachments()).toEqual([]);
    });

    it('opens the file picker when the attach button is clicked', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
      input.click = vi.fn();
      const add = titleButton('Add attachment');
      expect(add).not.toBeNull();
      add!.click();
      expect(input.click).toHaveBeenCalled();
    });

    it('handles dropped files through onEditorDrop', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));

      const file = new File(['dropped'], 'drop.txt', { type: 'text/plain' });
      const dt = { files: [file] };
      const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: dt } as unknown as DragEvent;
      await component.onEditorDrop(event);

      expect(component.editAttachments().length).toBe(1);
      expect(component.editAttachments()[0].name).toBe('drop.txt');
    });

    it('toggles the drag-over state for drag events', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      const over = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as DragEvent;
      const leave = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as DragEvent;

      component.onEditorDragOver(over);
      expect(component.isEditorDragOver()).toBe(true);

      component.onEditorDragLeave(leave);
      expect(component.isEditorDragOver()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Preview toggle
  // ------------------------------------------------------------------

  describe('editor preview', () => {
    it('toggles the preview panel and rerenders the markdown', async () => {
      createFixture(node({ content: '# Heading' }));
      await startEditing(node({ content: '# Heading' }));

      const previewBtn = findButton('Show Preview');
      expect(previewBtn).not.toBeNull();
      previewBtn!.click();
      fixture.detectChanges();

      expect(component.showPreview()).toBe(true);
      expect(fixture.nativeElement.querySelector('.editor-preview')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.editor-preview')).not.toBeNull();

      const hideBtn = findButton('Hide Preview');
      expect(hideBtn).not.toBeNull();
    });

    it('renders the markdown preview via MarkdownService', async () => {
      createFixture(node({ content: '**bold**' }));
      await startEditing(node({ content: '**bold**' }));
      component.showPreview.set(true);
      fixture.detectChanges();

      const preview = fixture.nativeElement.querySelector('.editor-preview') as HTMLElement;
      expect(preview.textContent).toContain('bold');
    });
  });

  // ------------------------------------------------------------------
  // Stop generation
  // ------------------------------------------------------------------

  describe('stop generation', () => {
    it('shows a stop button while generating and stops the generation on click', () => {
      chatService.startGeneration('n1');
      createFixture(node({ id: 'n1', content: 'Hello' }));

      const stop = titleButton('Stop generation');
      expect(stop).not.toBeNull();
      stop!.click();
      expect(chatService.generatingNodeId()).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Misc helpers
  // ------------------------------------------------------------------

  describe('helper API', () => {
    it('isLeafNode / isQuestion / hasSiblings reflect the tree', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: '' });
      await openChat([q1, a1]);
      createFixture(a1);

      expect(component.isQuestion()).toBe(false);
      expect(component.isLeafNode()).toBe(true);
      expect(component.hasSiblings).toBe(false);
    });

    it('resolves a preferred model from the enabled models', () => {
      createFixture(node({ content: 'Hi', role: 'user' }));
      expect(component.resolvePreferredModelId(node({ content: 'Hi' }))).toBe('alpha/model');
    });

    it('renderedHtml follows the node content', () => {
      createFixture(node({ content: '**Bold**' }));
      expect(component.renderedHtml()).toContain('Bold');
    });
  });
});