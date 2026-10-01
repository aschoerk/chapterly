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
import { GenerationSettingsService } from '../../core/generation-settings.service';
import { LightboxService } from '../../core/lightbox.service';
import { decodeDataUrlToText } from '../../core/llm/llm-message';
import { IllustrateDialogService } from '../../core/illustrate-dialog.service';
import { PrependDialogService } from '../../core/prepend-dialog.service';

/** Thin aliases over the shared test-helpers factories. */
const node = makeNode;
const attachment = makeAttachment;

function seedSettings(api: InMemoryChatApi): void {
  seedApi(api, {
    providers: [{ id: 'prov-1' }],
    models: [{ id: 'm-1' }, { id: 'm-2', displayName: 'Beta', modelId: 'beta/model' }],
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
    generateImage: ReturnType<typeof vi.fn>;
  };
  let illustrateDialog: { open: ReturnType<typeof vi.fn>; current: ReturnType<typeof vi.fn> };
  let prependDialog: { open: ReturnType<typeof vi.fn>; current: ReturnType<typeof vi.fn> };
  let emitted: string[];

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    seedSettings(api);
    localStorage.clear();

    vi.spyOn(window, 'alert').mockImplementation(() => {});
    if (typeof window.requestAnimationFrame !== 'function') {
      (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      };
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
          provide: IllustrateDialogService,
          useValue: {
            // Default: a simple single-scene, no-style run.
            open: vi.fn(async () => ({ count: 1, style: '', storyboardPrompt: '', purePictures: false })),
            current: vi.fn(() => null)
          }
        },
        {
          provide: PrependDialogService,
          useValue: {
            open: vi.fn(async () => null),
            current: vi.fn(() => null)
          }
        },
        {
          provide: LlmService,
          useValue: {
            askLlm: vi.fn(async () => ({ content: 'Generated structure', thinking: '' })),
            resolveForCurrentChat: vi.fn(async () => ({ stream: false })),
            toLlmExtras: vi.fn(() => ({})),
            generateImage: vi.fn(async () => ({ content: '', images: [] })),
            streamAnswer: vi.fn(
              async (
                chatId: string,
                questionNodeId: string,
                _provider: unknown,
                model: ModelEntry,
                _messages: unknown,
                _onChunk?: unknown,
                opts?: { adoptNodeIds?: string[] },
              ) => {
                const saved = await chatService.addNode(chatId, {
                  parentId: questionNodeId,
                  role: 'assistant',
                  content: 'Generated',
                  modelId: model?.modelId ?? 'alpha/model',
                  providerId: model?.providerId ?? 'prov-1',
                });
                chatService.setActiveChild(questionNodeId, saved.id);
                if (opts?.adoptNodeIds?.length) {
                  await chatService.reparentNodes(chatId, opts.adoptNodeIds, saved.id);
                  chatService.setActiveChild(saved.id, opts.adoptNodeIds[0]);
                }
                return saved;
              },
            ),
          },
        },
      ],
    }).compileComponents();

    chatService = TestBed.inject(ChatService);
    settings = TestBed.inject(SettingsService);
    confirm = TestBed.inject(ConfirmService);
    llm = TestBed.inject(LlmService) as unknown as {
      streamAnswer: ReturnType<typeof vi.fn>;
      askLlm: ReturnType<typeof vi.fn>;
      resolveForCurrentChat: ReturnType<typeof vi.fn>;
      toLlmExtras: ReturnType<typeof vi.fn>;
      generateImage: ReturnType<typeof vi.fn>;
    };
    illustrateDialog = TestBed.inject(IllustrateDialogService) as unknown as {
      open: ReturnType<typeof vi.fn>;
      current: ReturnType<typeof vi.fn>;
    };
    prependDialog = TestBed.inject(PrependDialogService) as unknown as {
      open: ReturnType<typeof vi.fn>;
      current: ReturnType<typeof vi.fn>;
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
      updated_at: now,
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
    return Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
  }

  function findButton(text: string): HTMLButtonElement | null {
    return buttons().find((b) => (b.textContent || '').includes(text)) ?? null;
  }

  function titleButton(title: string): HTMLButtonElement | null {
    return buttons().find((b) => b.getAttribute('title') === title) ?? null;
  }

  function confirmResolves(value: boolean): void {
    vi.spyOn(confirm, 'ask').mockResolvedValue(value);
  }

  /** Make the next Prepend dialog resolve with the given director text. */
  function prependConfirm(text: string | null): void {
    (prependDialog.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce(text);
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
      expect(fixture.nativeElement.querySelector('.node')?.getAttribute('data-node-id')).toBe(
        'custom-42',
      );
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
      const text =
        (fixture.nativeElement.querySelector('.branch-count') as HTMLElement).textContent ?? '';
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
      const prev = titleButton('Previous continuation');
      const next = titleButton('Next continuation');
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
      expect(titleButton('Delete this section and all following text')).not.toBeNull();
      expect(
        titleButton(
          'Delete this section only. Following text stays and attaches to its predecessor.',
        ),
      ).not.toBeNull();
    });

    it('deletes the node and its subtree after confirmation', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      await openChat([q1]);
      confirmResolves(true);
      createFixture(q1);

      await component.deleteNode();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')).toBeUndefined();
      // the app guarantees the active path ends on an empty question
      expect(chatService.nodes().some((n) => n.role === 'user' && !n.content?.trim())).toBe(true);
    });

    it('keeps the node when confirmation is declined', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      await openChat([q1]);
      confirmResolves(false);
      createFixture(q1);

      await component.deleteNode();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')).not.toBeUndefined();
    });

    it('does not ask for confirmation on a trivial (empty) node', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      vi.spyOn(confirm, 'ask').mockResolvedValue(false);
      createFixture(q1);

      await component.deleteNode();
      fixture.detectChanges();

      expect(confirm.ask).not.toHaveBeenCalled();
      expect(chatService.nodes().find((n) => n.id === 'q1')).toBeUndefined();
    });

    it('remove keeps the children and reparents them to the parent', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      confirmResolves(true);
      createFixture(q1);

      await component.deleteNodeOnly();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')).toBeUndefined();
      expect(chatService.nodes().find((n) => n.id === 'a1')?.parentId).toBeNull();
      // after removal the remaining child becomes active
      expect(emitted).toContain('a1');
    });

    it('disables the delete button while a generation is running', () => {
      chatService.startGeneration('n1');
      createFixture(node({ id: 'n1', content: 'Hello' }));
      expectButtonDisabled(titleButton('Delete this section and all following text'));
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
      const prev = node({
        id: 'v1',
        chatId: 'chat-1',
        parentId: null,
        role: 'assistant',
        content: 'Older',
        previousVersionId: null,
        version: 1,
      });
      const cur = node({
        id: 'v2',
        chatId: 'chat-1',
        parentId: null,
        role: 'assistant',
        content: 'Newer',
        previousVersionId: 'v1',
        version: 2,
      });

      api.nodes = [prev, cur];
      await chatService.loadNodes('chat-1');
      createFixture(cur);

      expect(component.priorVersions().map((v) => v.id)).toEqual(['v1']);

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
      const edit = titleButton('Edit this section in place');
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
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Edited via shortcut');

      const textarea = fixture.nativeElement.querySelector(
        '.editor-textarea',
      ) as HTMLTextAreaElement;
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      );
      await fixture.whenStable();
      fixture.detectChanges();

      expect(
        chatService.nodes().some((n) => n.role === 'user' && n.content === 'Edited via shortcut'),
      ).toBe(true);
    });

    it('Escape cancels the editor', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      const textarea = fixture.nativeElement.querySelector(
        '.editor-textarea',
      ) as HTMLTextAreaElement;
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
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Rewritten question');

      await component.saveAsVersion();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
      const saved = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Rewritten question');
      expect(saved).not.toBeUndefined();
      expect(saved!.id).not.toBe('q1');
      expect(emitted).toContain(saved!.id);
    });

    it('saves an edited assistant answer as a new version', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Old answer',
      });
      await openChat([q1, a1]);
      createFixture(a1);
      await startEditing(a1);
      component.onDraftText('New answer');

      await component.saveAsVersion();
      fixture.detectChanges();

      const saved = chatService
        .nodes()
        .find((n) => n.role === 'assistant' && n.content === 'New answer');
      expect(saved).not.toBeUndefined();
      expect(saved!.id).not.toBe('a1');
      expect(emitted).toContain(saved!.id);
    });

    it('closes the editor without a new node when nothing changed', async () => {
      const q1 = node({ id: 'q1', content: 'Same' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);

      await component.saveAsVersion();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
      expect(chatService.nodes().filter((n) => n.role === 'user' && n.content?.trim()).length).toBe(
        1,
      );
    });

    it('the OK button is disabled while the editor draft is empty', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
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

      expect(chatService.nodes().find((n) => n.id === 'q1')?.content).toBe('Tell me a story');
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

      expect(chatService.chats().find((c) => c.id === 'chat-1')?.title).toBe('My brand new story');
    });

    it('automatically interprets attached images with the configured image-interpret model', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      // Configure the image-interpret task to a (vision-capable) model.
      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-interpret', { providerId: 'prov-1', modelId: 'alpha/model' });

      llm.askLlm.mockResolvedValueOnce({ content: 'Interpreted: a red ball.', thinking: '' });

      const img = attachment({
        id: 'img',
        name: 'pic.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
      });

      await component.startEdit();
      component.editAttachments.set([img]);
      component.onDraftText('Continue from this picture');
      await component.sendDraft();
      fixture.detectChanges();

      // The interpretation askLlm call must have used the configured model.
      expect(llm.askLlm).toHaveBeenCalledTimes(1);
      const askArgs = llm.askLlm.mock.calls[0];
      expect(askArgs[2]).toBe('alpha/model');
      // The message content is parts incl. an image_url.
      const content = askArgs[3][0].content;
      expect(Array.isArray(content)).toBe(true);
      expect((content as { type: string }[]).some((p) => p.type === 'image_url')).toBe(true);

      // The streamed answer must NOT re-send the binary image.
      expect(llm.streamAnswer).toHaveBeenCalled();
      const streamMessages = llm.streamAnswer.mock.calls[0][4] as {
        role: string;
        content: unknown;
      }[];
      const serialized = JSON.stringify(streamMessages);
      expect(serialized).not.toContain('image_url');
      expect(serialized).toContain('Interpreted: a red ball.');
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

      expect(chatService.nodes().find((n) => n.id === 'q1')?.content).toBe('continue');
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
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Alternative path');

      await component.saveAsBranchAndSend();
      fixture.detectChanges();

      const branch = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Alternative path');
      expect(branch).not.toBeUndefined();
      expect(branch!.id).not.toBe('q1');
      expect(branch!.parentId).toBeNull(); // sibling of q1
      expect(emitted).toContain(branch!.id);
      expect(llm.streamAnswer).toHaveBeenCalled();
    });

    it('branches from an assistant answer by adding a child question', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(a1);
      component.onDraftText('Continue from here');

      await component.saveAsBranchAndSend();
      fixture.detectChanges();

      const branch = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Continue from here');
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
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Old answer',
      });

      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Inserted question');

      await component.saveAsInsertAndSend();
      fixture.detectChanges();

      const inserted = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Inserted question');
      expect(inserted).not.toBeUndefined();
      expect(inserted!.parentId).toBeNull();
      // the new assistant answer hangs under the inserted question
      const answer = chatService
        .nodes()
        .find((n) => n.role === 'assistant' && n.parentId === inserted!.id);
      expect(answer).not.toBeUndefined();
      // the old question now hangs under the new answer
      expect(chatService.nodes().find((n) => n.id === 'q1')?.parentId).toBe(answer!.id);
    });

    it('does nothing when called on an assistant node', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(a1);
      component.onDraftText('Should not insert');

      await component.saveAsInsertAndSend();
      fixture.detectChanges();

      expect(llm.streamAnswer).not.toHaveBeenCalled();
      expect(
        chatService.nodes().filter((n) => n.role === 'user' && n.content === 'Should not insert')
          .length,
      ).toBe(0);
    });
  });

  describe('structure generation', () => {
    it('offers the heading button only on assistant nodes', () => {
      createFixture(node({ role: 'user', content: 'Question' }));
      expect(titleButton('Generate a chapter heading for this answer')).toBeNull();

      createFixture(node({ role: 'assistant', content: 'Answer' }));
      expect(titleButton('Generate a chapter heading for this answer')).not.toBeNull();
    });

    it('replaces the existing heading node for the same answer', async () => {
      const q1 = node({ id: 'q1', content: 'Story context' });
      const h1 = node({
        id: 'h1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'structural',
        content: 'Old heading',
      });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'h1',
        role: 'assistant',
        content: 'Chapter text',
      });
      await openChat([q1, h1, a1]);
      createFixture(a1);

      await component.generateHeading();

      expect(chatService.nodes().filter((n) => n.role === 'structural')).toHaveLength(1);
      expect(chatService.nodes().find((n) => n.id === 'h1')?.content).toBe('Generated structure');
      expect(chatService.nodes().find((n) => n.id === 'a1')?.parentId).toBe('h1');
    });

    it('generates a chapter heading that wraps the assistant answer', async () => {
      const q1 = node({ id: 'q1', content: 'Story context' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Chapter text',
      });
      await openChat([q1, a1]);
      createFixture(a1);

      await component.generateHeading();

      const generated = chatService.nodes().find((n) => n.role === 'structural');
      expect(generated?.content).toBe('Generated structure');
      expect(generated?.parentId).toBe('q1');
      expect(generated?.modelId).toBe('alpha/model');
      expect(chatService.nodes().find((n) => n.id === 'a1')?.parentId).toBe(generated?.id);
      expect(llm.askLlm).toHaveBeenCalled();
      expect(emitted).toContain(generated?.id);
    });

    it('uses only the current node text as context', async () => {
      const q1 = node({ id: 'q1', content: 'Story context' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Sole context',
      });
      const a2 = node({
        id: 'a2',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Other answer',
      });
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
      expect(chatService.nodes().filter((n) => n.role === 'structural').length).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // Regenerate
  // ------------------------------------------------------------------

  describe('regenerate', () => {
    it('deletes the answer and its subtree, activates the parent, and re-streams', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
        modelId: 'alpha/model',
      });
      const d = node({ id: 'd', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, d]);
      confirmResolves(true);
      createFixture(a1);

      await component.regenerateAnswer();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'a1')).toBeUndefined();
      expect(chatService.nodes().find((n) => n.id === 'd')).toBeUndefined();
      expect(emitted).toContain('q1');
      expect(llm.streamAnswer).toHaveBeenCalled();
    });

    it('does nothing while already loading or generating', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
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
  // Regenerate in place (rewrite this answer, keep following text)
  // ------------------------------------------------------------------

  describe('regenerateInPlace', () => {
    it('replaces only this answer and re-hangs the following text under the new one', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
        modelId: 'alpha/model',
      });
      const d1 = node({
        id: 'd1', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction',
      });
      const a2 = node({
        id: 'a2',
        chatId: 'chat-1',
        parentId: 'd1',
        role: 'assistant',
        content: 'Following text',
        modelId: 'alpha/model',
      });
      await openChat([q1, a1, d1, a2]);
      confirmResolves(true);
      createFixture(a1);

      await component.regenerateInPlace();
      fixture.detectChanges();

      // Only the regenerated answer is gone…
      expect(chatService.nodes().find((n) => n.id === 'a1')).toBeUndefined();
      // …the following text survives intact.
      expect(chatService.nodes().find((n) => n.id === 'd1')).toBeDefined();
      expect(chatService.nodes().find((n) => n.id === 'a2')).toBeDefined();

      // A fresh answer hangs under the question and adopts the preserved subtree.
      const newAnswer = chatService.getChildren('q1').find((n) => n.role === 'assistant')!;
      expect(newAnswer).toBeDefined();
      expect(newAnswer.id).not.toBe('a1');
      expect(chatService.getChildren(newAnswer.id).map((n) => n.id)).toContain('d1');
      expect(chatService.getActiveChild(newAnswer.id)?.id).toBe('d1');

      expect(emitted).toContain('q1');
      expect(llm.streamAnswer).toHaveBeenCalledWith(
        'chat-1', 'q1', expect.anything(), expect.anything(), expect.anything(), undefined,
        expect.objectContaining({ adoptNodeIds: ['d1'] }),
      );
    });

    it('with no following text it behaves like a plain regenerate', async () => {
      const older = new Date(Date.now() - 60_000).toISOString();
      const newer = new Date().toISOString();
      const q1 = node({ id: 'q1', content: 'Question', createdAt: older, updatedAt: older });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
        modelId: 'alpha/model',
        createdAt: older,
        updatedAt: older,
      });
      // A later sibling question under q1 so the active path ends on it, not
      // on a1 — otherwise selectChat auto-adds a draft question under a1.
      const q2 = node({
        id: 'q2',
        parentId: 'q1',
        content: 'Question 2',
        createdAt: newer,
        updatedAt: newer,
      });
      await openChat([q1, a1, q2]);
      createFixture(a1);

      await component.regenerateInPlace();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'a1')).toBeUndefined();
      const newAnswer = chatService.getChildren('q1').find((n) => n.role === 'assistant')!;
      expect(newAnswer).toBeDefined();
      expect(newAnswer.id).not.toBe('a1');
      expect(llm.streamAnswer).toHaveBeenCalled();
    });

    it('asks for confirmation when there is following text; aborting keeps the node', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
        modelId: 'alpha/model',
      });
      const d1 = node({
        id: 'd1', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction',
      });
      await openChat([q1, a1, d1]);
      confirmResolves(false);
      createFixture(a1);

      await component.regenerateInPlace();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'a1')).toBeDefined();
      expect(llm.streamAnswer).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Attachments
  // ------------------------------------------------------------------

  describe('attachments', () => {
    it('renders read-only attachment chips with a file link', () => {
      const cn = node({
        content: 'With file',
        attachments: [attachment({ mimeType: 'text/plain' })],
      });
      createFixture(cn);
      expect(fixture.nativeElement.querySelector('.attachment-chips.read-only')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.file-link')).not.toBeNull();
    });

    it('renders an image thumbnail for image attachments', () => {
      const cn = node({
        content: 'With image',
        attachments: [
          attachment({
            id: 'img',
            name: 'pic.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAAA',
          }),
        ],
      });
      createFixture(cn);
      expect(fixture.nativeElement.querySelector('.thumb')).not.toBeNull();
    });

    it('opens the lightbox (not window.open) when an image is clicked', () => {
      const lightbox = TestBed.inject(LightboxService);
      lightbox.close();
      const a1 = attachment({
        id: 'img1',
        name: 'a.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
      });
      const a2 = attachment({
        id: 'img2',
        name: 'b.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,BBBB',
      });
      const cn = node({ content: 'x', attachments: [a1, a2] });
      createFixture(cn);

      const spy = vi.fn();
      (window as any).open = spy;
      component.openImage(a1.dataUrl);
      expect(spy).not.toHaveBeenCalled();
      expect(lightbox.current()).toEqual({ urls: [a1.dataUrl, a2.dataUrl], index: 0 });
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
      expect(
        fixture.nativeElement.querySelector('.attachment-chips.editable .chip'),
      ).not.toBeNull();
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
      const event = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: dt,
      } as unknown as DragEvent;
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

    it('classifies recorded prompt attachments (prompt-N.txt / refused-prompt-N.txt)', () => {
      const ok = attachment({
        id: 'ok',
        name: 'prompt-2.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A scene'),
      });
      const refused = attachment({
        id: 'ref',
        name: 'refused-prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA scene\n\nModel reply:\nNo',
        ),
      });
      const plain = attachment({ id: 'plain', name: 'notes.txt', mimeType: 'text/plain' });
      createFixture(node({ content: 'x', attachments: [ok, refused, plain] }));

      expect(component.isPromptAttachment(ok)).toBe(true);
      expect(component.isPromptAttachment(refused)).toBe(true);
      expect(component.isPromptAttachment(plain)).toBe(false);
      expect(component.isRefusedPromptAttachment(refused)).toBe(true);
      expect(component.isRefusedPromptAttachment(ok)).toBe(false);

      // promptAttachmentPrompt extracts only the prompt part of a refused record.
      expect(component.promptAttachmentPrompt(refused)).toBe('A scene');
    });

    it('shows the recorded prompt text inline instead of only a download link', () => {
      const ok = attachment({
        id: 'ok',
        name: 'prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Medium shot: a lantern-lit bazaar at night.',
        ),
      });
      createFixture(node({ content: 'x', attachments: [ok] }));

      // Prompt attachments are NOT plain download links any more.
      expect(fixture.nativeElement.querySelector('.file-link')).toBeNull();
      expect(fixture.nativeElement.querySelector('.prompt-toggle')).not.toBeNull();

      // Collapsed by default — no inline text yet.
      expect(fixture.nativeElement.querySelector('.prompt-text')).toBeNull();

      component.togglePrompt(ok);
      fixture.detectChanges();
      const text = fixture.nativeElement.querySelector('.prompt-text')?.textContent ?? '';
      expect(text).toContain('lantern-lit bazaar');

      // Toggling again collapses.
      component.togglePrompt(ok);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.prompt-text')).toBeNull();
    });

    it('adapts a refused prompt and re-renders it in place', async () => {
      const refused = attachment({
        id: 'ref',
        name: 'refused-prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA dungeon scene\n\nModel reply:\nI cannot generate that image.',
        ),
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Chapter',
        attachments: [refused],
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      llm.generateImage.mockResolvedValueOnce({
        content: '',
        images: [{ url: 'data:image/png;base64,QQ==' }],
      });

      createFixture(a1, 'a1');
      component.startPromptEdit(refused);
      fixture.detectChanges();

      // Editor opens pre-filled with the prompt portion only (no "Model reply").
      expect(component.editingPromptId()).toBe('ref');
      expect(component.promptEditDraft()).toBe('A dungeon scene');
      expect(fixture.nativeElement.querySelector('.prompt-editor')).not.toBeNull();

      // Re-render against the refused scene number, single picture, no planning.
      component.promptEditDraft.set('A brighter dungeon scene, lit by torchlight');
      await component.rerenderPrompt(refused);
      fixture.detectChanges();

      expect(llm.generateImage).toHaveBeenCalledTimes(1);
      const optsArg = llm.generateImage.mock.calls[0][4] as {
        count: number;
        planDescriptions?: boolean;
      };
      expect(optsArg.count).toBe(1);
      expect(optsArg.planDescriptions).toBe(false);

      // editAssistant versions the chapter — read the current assistant child.
      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      // The refused record is replaced by an image + its prompt file.
      expect(chapter.attachments?.some(a => a.name === 'refused-prompt-1.txt')).toBe(false);
      expect(chapter.attachments?.some(a => a.name === 'illustration-1.png')).toBe(true);
      const promptFile = chapter.attachments!.find(a => a.name === 'prompt-1.txt');
      expect(promptFile).toBeTruthy();
      // The adapted prompt is what got recorded next to the new image.
      expect(decodeDataUrlToText(promptFile!.dataUrl!)).toContain('brighter dungeon scene');
      expect(emitted).toContain(chapter.id);
    });

    it('attaches re-rendered pictures when the service returns per-scene records (real shape)', async () => {
      const refused = attachment({
        id: 'ref',
        name: 'refused-prompt-2.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA dungeon scene\n\nModel reply:\nNo',
        ),
      });
      // Chapter already has a successful scene 1 + the refused scene 2.
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Chapter',
        attachments: [
          attachment({ id: 'img1', name: 'illustration-1.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }),
          attachment({ id: 'p1', name: 'prompt-1.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;charset=utf-8,scene-1' }),
          refused,
        ],
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // Mirrors LlmService.generateImage's REAL return shape (scenes populated).
      llm.generateImage.mockResolvedValueOnce({
        content: 'done',
        images: [{ url: 'data:image/png;base64,BBBB' }],
        scenes: [{
          scene: 1,
          prompt: 'adapted scene prompt',
          images: [{ url: 'data:image/png;base64,BBBB' }],
          refused: false,
        }],
      });

      createFixture(a1, 'a1');
      component.startPromptEdit(refused);
      component.promptEditDraft.set('A brighter dungeon scene');
      await component.rerenderPrompt(refused);
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      const names = (chapter.attachments || []).map(a => a.name);
      // Keeps scene 1, replaces refused scene 2 with illustration-2 + prompt-2.
      expect(names.some(a => a === 'illustration-1.png')).toBe(true);
      expect(names.some(a => a === 'refused-prompt-2.txt')).toBe(false);
      expect(names.some(a => a === 'illustration-2.png')).toBe(true);
      expect(names.some(a => a === 'prompt-2.txt')).toBe(true);
    });

    it('alerts and saves an updated refused record when the re-render is refused again', async () => {
      const refused = attachment({
        id: 'ref',
        name: 'refused-prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA scene\n\nModel reply:\nNo',
        ),
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Chapter',
        attachments: [refused],
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      // Model refuses again: no images, refused scene with a reply.
      llm.generateImage.mockResolvedValueOnce({
        content: 'I cannot help with that.',
        images: [],
        scenes: [{
          scene: 1,
          // In the real flow scene.prompt is the anchor, which embeds the
          // user's adapted draft text.
          prompt: 'Illustrate... chapter to illustrate:\nA softer scene',
          images: [],
          refused: true,
          content: 'I cannot help with that.',
        }],
      });

      createFixture(a1, 'a1');
      component.startPromptEdit(refused);
      component.promptEditDraft.set('A softer scene');
      await component.rerenderPrompt(refused);
      fixture.detectChanges();

      // No picture attached, but the refusal is surfaced — no silent success.
      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.some(a => a.name === 'illustration-1.png')).toBe(false);
      // The adapted prompt is preserved in the updated refused record.
      const kept = chapter.attachments!.find(a => a.name === 'refused-prompt-1.txt');
      expect(kept).toBeTruthy();
      expect(decodeDataUrlToText(kept!.dataUrl!)).toContain('A softer scene');
      expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('I cannot help with that.'));
      // Editor resets after the attempt.
      expect(component.editingPromptId()).toBeNull();
      expect(component.expandedPromptId()).toBeNull();
    });

    it('adapts & re-renders a SUCCESSFUL prompt by replacing its paired illustration', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A castle scene'),
      });
      const img = attachment({
        id: 'img1',
        name: 'illustration-1.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,OLDDATA',
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter',
        attachments: [img, prompt],
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      llm.generateImage.mockResolvedValueOnce({
        content: '',
        images: [{ url: 'data:image/png;base64,NEWDATA' }],
      });

      createFixture(a1, 'a1');
      component.startPromptEdit(prompt);
      component.promptEditDraft.set('A brighter castle at dusk');
      await component.rerenderPrompt(prompt);
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      // The OLD illustration is replaced, not duplicated.
      const images = (chapter.attachments || []).filter(a => a.name === 'illustration-1.png');
      expect(images).toHaveLength(1);
      expect(images[0].dataUrl).toBe('data:image/png;base64,NEWDATA');
      // The OLD prompt record is replaced with the adapted one.
      const prompts = (chapter.attachments || []).filter(a => a.name === 'prompt-1.txt');
      expect(prompts).toHaveLength(1);
      expect(decodeDataUrlToText(prompts[0].dataUrl!)).toContain('brighter castle at dusk');
    });

    it('deletes a prompt attachment after confirmation (image kept, editor closed)', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A castle scene'),
      });
      const img = attachment({
        id: 'img1',
        name: 'illustration-1.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,KEEPME',
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter',
        attachments: [img, prompt],
      });
      await openChat([q1, a1]);

      createFixture(a1, 'a1');
      component.startPromptEdit(prompt); // keep the editor open — it must close on delete
      confirmResolves(true);
      await component.deletePromptAttachment(prompt);
      fixture.detectChanges();

      expect(confirm.ask).toHaveBeenCalled();
      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.some(a => a.id === 'p1')).toBe(false);
      expect(chapter.attachments?.some(a => a.id === 'img1')).toBe(true);
      // Editor state reset.
      expect(component.editingPromptId()).toBeNull();
      expect(component.expandedPromptId()).toBeNull();
    });

    it('keeps the prompt record when deletion is cancelled', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'refused-prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA scene\n\nModel reply:\nNo',
        ),
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter',
        attachments: [prompt],
      });
      await openChat([q1, a1]);

      createFixture(a1, 'a1');
      confirmResolves(false);
      await component.deletePromptAttachment(prompt);
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.some(a => a.id === 'p1')).toBe(true);
    });

    it('pre-fills the editor from a SUCCESSFUL prompt for adapt & re-render', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'prompt-2.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A lantern-lit bazaar at night.'),
      });
      createFixture(node({ role: 'assistant', content: 'Chapter', attachments: [prompt] }));

      component.startPromptEdit(prompt);
      expect(component.editingPromptId()).toBe('p1');
      expect(component.promptEditDraft()).toBe('A lantern-lit bazaar at night.');
    });

    it('renders adapt & re-render AND delete for a non-refused prompt in the box', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A castle scene'),
      });
      createFixture(node({ role: 'assistant', content: 'Chapter', attachments: [prompt] }));
      component.togglePrompt(prompt);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Adapt prompt & re-render');
      expect(text).toContain('Delete prompt');
    });
  });

  // ------------------------------------------------------------------
  // Illustrate — text → picture generation
  // ------------------------------------------------------------------

  describe('illustrate', () => {
    it('is disabled on a direction without a chapter, enabled with one', () => {
      const dir = node({ id: 'q1', content: 'Night train, Mara at the window.' });
      createFixture(dir);
      expect(component.canIllustrate()).toBe(false);

      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'The letter…',
      });
      createFixture(a1);
      expect(component.canIllustrate()).toBe(true);
    });

    it('generates a picture for the current chapter and attaches it', async () => {
      const q1 = node({ id: 'q1', content: 'Night train, Mara at the window.' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Mara folds the letter and watches the conductor pass.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      llm.generateImage.mockResolvedValueOnce({
        content: '',
        images: [{ url: 'data:image/png;base64,QQ==' }],
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      expect(llm.generateImage).toHaveBeenCalledTimes(1);
      // The direction text is sent as the scene to depict.
      const imagesArgs = llm.generateImage.mock.calls[0][2] as { role: string; content: unknown }[];
      const lastText = JSON.stringify(imagesArgs[imagesArgs.length - 1].content);
      expect(lastText).toContain('Night train, Mara at the window.');

      // Single picture (count 1): no storyboard, no description planning,
      // no one-shot batch call.
      const optsArg = llm.generateImage.mock.calls[0][4] as {
        planDescriptions?: boolean;
        singleCall?: boolean;
      };
      expect(optsArg.planDescriptions).not.toBe(true);
      expect(optsArg.singleCall).not.toBe(true);

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(2);
      expect(chapter.attachments![0].name).toBe('illustration-1.png');
      expect(chapter.attachments![0].mimeType).toBe('image/png');
      // Companion text attachment with the exact prompt used.
      expect(chapter.attachments![1].name).toBe('prompt-1.txt');
      expect(chapter.attachments![1].mimeType).toBe('text/plain');
      expect(decodeDataUrlToText(chapter.attachments![1].dataUrl)).toContain(
        'Night train, Mara at the window.',
      );
      expect(emitted).toContain(chapter.id);
    });

    it('attaches the picture to the chapter itself when invoked on a chapter', async () => {
      const q1 = node({ id: 'q1', content: 'A prov night-train that never quite arrives.' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'The carriage sways; weak tea on the fold-out table.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      llm.generateImage.mockResolvedValueOnce({
        content: '',
        images: [{ url: 'data:image/png;base64,QQ==' }],
      });

      createFixture(a1);
      await component.illustrate();
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(2);
      expect(chapter.attachments![0].dataUrl).toContain('data:image/png');
      expect(chapter.attachments![1].name).toBe('prompt-1.txt');
      expect(decodeDataUrlToText(chapter.attachments![1].dataUrl)).toContain(
        'The carriage sways; weak tea on the fold-out table.',
      );
    });

    it('propagates pure picture mode into generateImage (forces planning)', async () => {
      const q1 = node({ id: 'q1', content: 'A mild direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      llm.generateImage.mockResolvedValueOnce({
        content: '',
        images: [{ url: 'data:image/png;base64,QQ==' }],
      });

      // The user enabled the "pure picture mode" check button in the dialog.
      illustrateDialog.open.mockResolvedValue({
        count: 1,
        style: '',
        storyboardPrompt: '',
        purePictures: true,
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      expect(llm.generateImage).toHaveBeenCalledTimes(1);
      const optsArg = llm.generateImage.mock.calls[0][4] as {
        purePictures?: boolean;
        planDescriptions?: boolean;
      };
      expect(optsArg.purePictures).toBe(true);
      // Pure mode forces the description-planning pass so only the derived
      // descriptions reach the image model.
      expect(optsArg.planDescriptions).toBe(true);
    });

    it('shows an alert and does not call the LLM when no image model is enabled', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);
      createFixture(q1, 'a1');

      await component.illustrate();
      fixture.detectChanges();

      expect(llm.generateImage).not.toHaveBeenCalled();
      expect(window.alert).toHaveBeenCalled();
    });

    it('uses the edited draft as the prompt when illustrating from the composer', async () => {
      const q1 = node({ id: 'q1', content: 'Old stubborn direction.' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Mara watches the conductor pass.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      llm.generateImage.mockResolvedValueOnce({
        content: '',
        images: [{ url: 'data:image/png;base64,QQ==' }],
      });

      createFixture(q1, 'a1');
      await component.startEdit();
      component.onDraftText('The train stops at a ghost platform');
      expect(component.canIllustrateDraft()).toBe(true);
      await component.illustrateWithDraft();
      fixture.detectChanges();

      expect(llm.generateImage).toHaveBeenCalledTimes(1);
      const imagesArgs = llm.generateImage.mock.calls[0][2] as { role: string; content: unknown }[];
      const lastText = JSON.stringify(imagesArgs[imagesArgs.length - 1].content);
      // The edited draft (not the stale saved content) drives the prompt.
      expect(lastText).toContain('The train stops at a ghost platform');
      expect(lastText).not.toContain('Old stubborn direction.');

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(2);
      expect(chapter.attachments![0].name).toBe('illustration-1.png');
      expect(chapter.attachments![1].name).toBe('prompt-1.txt');
    });

    it('requests the dialog storyboard count + style + rules and attaches every image', async () => {
      const q1 = node({ id: 'q1', content: 'A bustling bazaar at night.' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Lanterns sway; a stall-keeper counts coins.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      illustrateDialog.open.mockResolvedValue({
        count: 3,
        style: 'comic style',
        storyboardPrompt: 'no explicit images, hide behind bystanders',
        purePictures: false,
      });

      const imgs = [0, 1, 2].map((i) => ({ url: `data:image/png;base64,AAAA${i}` }));
      llm.generateImage.mockImplementation(async (_p: unknown, _m: unknown, _ms: unknown, _sig?: unknown, opts?: any) => {
        opts?.onProgress?.(Math.min(imgs.length, opts.count), opts.count);
        return { content: '', images: imgs };
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      expect(llm.generateImage).toHaveBeenCalledTimes(1);
      const optsArg = llm.generateImage.mock.calls[0][4] as {
        count: number;
        storyboardPrompt: string;
        planDescriptions?: boolean;
        singleCall?: boolean;
        planner?: { model?: unknown; provider?: unknown } | null;
        onProgress?: unknown;
      };
      expect(optsArg.count).toBe(3);
      expect(optsArg.storyboardPrompt).toContain('no explicit images');
      // Storyboard mode asks the service to plan concrete picture
      // descriptions before rendering each scene.
      expect(optsArg.planDescriptions).toBe(true);
      // Storyboard mode asks the service to render all pictures in ONE
      // completion so faces/figures/environment stay consistent (falls back
      // to per-scene automatically when the model returns fewer).
      expect(optsArg.singleCall).toBe(true);
      // A planner (text model/provider, fallback = rendering model) is passed
      // so the pure-text storyboard planning does not depend on the image model.
      expect(optsArg.planner?.model).toBeDefined();
      expect(optsArg.planner?.provider).toBeDefined();

      // The style is folded into the prompt.
      const msgs = llm.generateImage.mock.calls[0][2] as { role: string; content: unknown }[];
      expect(JSON.stringify(msgs[msgs.length - 1].content)).toContain('Style: comic style');

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      // Mock returns one completion with all 3 images (no per-scene records),
      // so the fallback keeps one prompt for the scene.
      expect(chapter.attachments?.length).toBe(4);
      expect(chapter.attachments![0].name).toBe('illustration-1.png');
      expect(chapter.attachments![2].name).toBe('illustration-3.png');
      expect(chapter.attachments![3].name).toBe('prompt-1.txt');
      expect(component.imageProgress()).toBeNull();
    });

    it('uses the ASSISTANT NODE model for storyboard planning, not the image-interpret task', async () => {
      // Three distinct models: the assistant node writes with gamma, the
      // configured image-interpret task points at beta, image-create at alpha.
      api.models.push(makeModel({ id: 'm-3', modelId: 'gamma/model' }));
      await settings.loadAll();

      const q1 = node({ id: 'q1', content: 'A castle by the sea.' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Waves batter the old keep.',
        modelId: 'gamma/model',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      generation.update('image-interpret', { providerId: 'prov-1', modelId: 'beta/model' });
      llm.generateImage.mockResolvedValueOnce({
        content: '',
        images: [{ url: 'data:image/png;base64,QQ==' }],
      });

      createFixture(a1);
      await component.illustrate();
      fixture.detectChanges();

      expect(llm.generateImage).toHaveBeenCalledTimes(1);
      const optsArg = llm.generateImage.mock.calls[0][4] as {
        planner?: { model?: { modelId?: string }; provider?: unknown } | null;
      };
      // The planner must be the model that wrote the assistant node (gamma),
      // NOT the configured image-interpret task model (beta).
      expect(optsArg.planner?.model?.modelId).toBe('gamma/model');
    });

    it('stores an exact prompt file per scene when the service returns scene records', async () => {
      const q1 = node({ id: 'q1', content: 'Two beats.' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter.' });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      illustrateDialog.open.mockResolvedValue({
        count: 2,
        style: 'ink',
        storyboardPrompt: 'keep it clean',
        purePictures: false,
      });

      llm.generateImage.mockResolvedValueOnce({
        content: '',
        images: [
          { url: 'data:image/png;base64,QQ==' },
          { url: 'data:image/png;base64,QQE=' },
        ],
        scenes: [
          { scene: 1, prompt: 'prompt for scene 1', images: [{ url: 'data:image/png;base64,QQ==' }] },
          { scene: 2, prompt: 'prompt for scene 2', images: [{ url: 'data:image/png;base64,QQE=' }] },
        ],
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(4);
      expect(chapter.attachments![0].name).toBe('illustration-1.png');
      expect(chapter.attachments![1].name).toBe('prompt-1.txt');
      expect(decodeDataUrlToText(chapter.attachments![1].dataUrl)).toBe('prompt for scene 1');
      expect(chapter.attachments![2].name).toBe('illustration-2.png');
      expect(chapter.attachments![3].name).toBe('prompt-2.txt');
      expect(decodeDataUrlToText(chapter.attachments![3].dataUrl)).toBe('prompt for scene 2');
    });

    it('preserves the prompt of refused images as a refused-prompt attachment', async () => {
      const q1 = node({ id: 'q1', content: 'A refused attempt.' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter.' });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      llm.generateImage.mockResolvedValueOnce({
        content: "I can't draw that.",
        images: [],
        scenes: [{ scene: 1, prompt: 'sensitive scene', images: [], content: "I can't draw that.", refused: true }],
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(1);
      expect(chapter.attachments![0].name).toBe('refused-prompt-1.txt');
      const text = decodeDataUrlToText(chapter.attachments![0].dataUrl) ?? '';
      expect(text).toContain('sensitive scene');
      expect(text).toContain("I can't draw that.");
      // The user is still informed nothing was generated.
      expect(window.alert).toHaveBeenCalled();
    });

    it('does nothing when the dialog is cancelled', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);
      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      illustrateDialog.open.mockResolvedValue(null);

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      expect(llm.generateImage).not.toHaveBeenCalled();
      expect(component.isLoading()).toBe(false);
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
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: '',
      });
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

  // ------------------------------------------------------------------
  // Prepend (director) feature
  // ------------------------------------------------------------------

  describe('prepend (director) feature', () => {
    it('opens the director dialog, calls the LLM, and inserts the two nodes before the current direction', async () => {
      const q1 = node({ id: 'q1', content: 'Root direction' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, q3]);
      createFixture(q3);

      prependConfirm('Custom director: these events are retold from outside the named characters.');
      await component.openPrependDialog();
      fixture.detectChanges();

      // The answer is streamed through the normal streaming path (streamAnswer).
      expect(llm.streamAnswer).toHaveBeenCalledTimes(1);
      const askMessages = llm.streamAnswer.mock.calls[0][4] as { role: string; content: unknown }[];
      expect(askMessages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      // Prior context is unchanged (interleaved, like a normal send).
      expect(String(askMessages[0].content)).toBe('Root direction');
      expect(String(askMessages[1].content)).toBe('Chapter one.');
      // The LAST message is the prompt (director instruction). q3 is a leaf so
      // there is no following assistant content.
      const prompt = String(askMessages[2].content);
      expect(prompt).toContain('Custom director: these events are retold');

      // Two new nodes were created: a USER director (the prompt) + an
      // assistant result, both BEFORE the current direction node.
      const nodes = chatService.nodes();
      const director = nodes.find(n => n.role === 'user' && n.content === 'Custom director: these events are retold from outside the named characters.');
      const resultNode = nodes.find(n => n.role === 'assistant' && n.content === 'Generated');
      expect(director).toBeDefined();
      expect(resultNode).toBeDefined();
      // Chain: a1 → director(user) → result(assistant) → q3 (both before the current direction).
      expect(director!.parentId).toBe('a1');
      expect(resultNode!.parentId).toBe(director!.id);
      expect(chatService.nodes().find(n => n.id === 'q3')?.parentId).toBe(resultNode!.id);
      // The current direction was adopted under the streamed result.
      expect(llm.streamAnswer.mock.calls[0][6]).toEqual({ adoptNodeIds: ['q3'] });

      // Persisted + active for the current node.
      expect(component.prependEnabled()).toBe(true);
      expect(JSON.parse(localStorage.getItem('chat.prependByNodeId')!)).toEqual({
        q3: 'Custom director: these events are retold from outside the named characters.'
      });
    });

    it('appends the assistant node content FOLLOWING the current node at the end of the prompt', async () => {
      // Upstream: q1 → a1(Chapter one.). Current direction: q2. Downstream
      // following chapters: a2 (Chapter two.), a3 (Chapter three.).
      const q1 = node({ id: 'q1', content: 'Root direction' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q2 = node({ id: 'q2', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction two' });
      const a2 = node({ id: 'a2', chatId: 'chat-1', parentId: 'q2', role: 'assistant', content: 'Chapter two.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a2', role: 'user', content: 'Direction three' });
      const a3 = node({ id: 'a3', chatId: 'chat-1', parentId: 'q3', role: 'assistant', content: 'Chapter three.' });
      const q4 = node({ id: 'q4', chatId: 'chat-1', parentId: 'a3', role: 'user', content: '' });
      await openChat([q1, a1, q2, a2, q3, a3, q4]);
      createFixture(q2);

      prependConfirm('RECAP');
      await component.openPrependDialog();

      // Prior context = path up to q2's parent (a1) — like insert.
      expect(llm.streamAnswer).toHaveBeenCalledTimes(1);
      const askMessages = llm.streamAnswer.mock.calls[0][4] as { role: string; content: unknown }[];
      expect(askMessages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(String(askMessages[0].content)).toBe('Root direction');
      expect(String(askMessages[1].content)).toBe('Chapter one.');
      // The LAST message (the prompt) ends with the FOLLOWING assistant
      // chapters — Chapter two. and Chapter three. — appended after the
      // director instruction.
      const prompt = String(askMessages[2].content);
      expect(prompt).toContain('RECAP');
      expect(prompt).toContain('Chapter two.');
      expect(prompt).toContain('Chapter three.');
      // The prompt must end with the following content, not the prior chapter.
      expect(prompt.indexOf('Chapter three.')).toBeGreaterThan(prompt.indexOf('Chapter two.'));
      expect(prompt.indexOf('Chapter two.')).toBeGreaterThan(prompt.indexOf('RECAP'));
    });

    it('a cancelled dialog keeps the state', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      prependConfirm('The events have already occurred.');
      await component.openPrependDialog();
      expect(component.prependEnabled()).toBe(true);

      prependConfirm(null); // cancel
      await component.openPrependDialog();
      expect(component.prependEnabled()).toBe(true);
    });

    it('an empty confirmation clears the director', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      prependConfirm('Some text');
      await component.openPrependDialog();
      expect(component.prependEnabled()).toBe(true);

      prependConfirm('');
      await component.openPrependDialog();
      expect(component.prependEnabled()).toBe(false);
      expect(JSON.parse(localStorage.getItem('chat.prependByNodeId')!)).toEqual({});
    });

    it('reads a pre-stored prepend text for the rendered node', async () => {
      const q1 = node({ id: 'q1', content: '' });
      localStorage.setItem('chat.prependByNodeId', JSON.stringify({ q1: 'custom director' }));
      await openChat([q1]);
      createFixture(q1);

      expect(component.prependEnabled()).toBe(true);
      expect(component.prependText()).toBe('custom director');
    });

    it('shows the prepend toggle only for a user (direction) node', async () => {
      // A user node that already has an answer (not the empty draft composer).
      const q1 = node({ id: 'q1', content: 'A direction with a chapter' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'The chapter.' });
      await openChat([q1, a1]);
      createFixture(q1);

      const toggle = buttons().find((b) => (b.textContent || '').trim() === 'Prepend');
      expect(toggle).not.toBeNull();
      expect(toggle!.getAttribute('title')).toBe('Insert a director instruction before this direction: it invents events and situations that illustrate and lead up to the following chapters (≤ 5000 tokens) without contradicting them.');

      // A non-user (assistant) node should NOT carry the prepend button.
      createFixture(a1);
      fixture.detectChanges();
      const notFound = buttons().find((b) => (b.textContent || '').trim() === 'Prepend');
      expect(notFound).toBeUndefined();
    });

    it('uses the stored edited text over the characters-based default in the LLM call', async () => {
      const q1 = node({ id: 'q1', content: 'A' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction three' });
      const a3 = node({ id: 'a3', chatId: 'chat-1', parentId: 'q3', role: 'assistant', content: 'Chapter following.' });
      await openChat([q1, a1, q3, a3]);
      createFixture(q3);

      localStorage.setItem(
        'chat-client.elaborate.byChatId',
        JSON.stringify({ 'chat-1': { lastChapter: 2, characters: 'Anna, Ben' } }),
      );
      prependConfirm('My own director text (chars ignored).');
      await component.openPrependDialog();

      const askMessages = llm.streamAnswer.mock.calls[0][4] as { role: string; content: unknown }[];
      // The LAST message (the prompt) = edited text + the following chapter.
      const instruction = String(askMessages[askMessages.length - 1].content);
      expect(instruction).toContain('My own director text');
      expect(instruction).toContain('Chapter following.');
      expect(instruction).not.toContain('Anna');
    });

    it('falls back to the default director instruction when opening with no stored text', async () => {
      const q1 = node({ id: 'q1', content: 'A' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, q3]);
      createFixture(q3);

      // The dialog is seeded with the (basic) default — assert the proposal.
      prependConfirm(null); // cancel, nothing is stored / called
      await component.openPrependDialog();
      const proposed = (prependDialog.open as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(proposed).toContain('Assume the events');
      expect(proposed).not.toContain('{{characters}}');
      expect(llm.streamAnswer).not.toHaveBeenCalled();
    });

    it('restricts the FOLLOWING chapter sequence in the prompt to 5000 tokens, dropping the farthest whole chapters', async () => {
      const ch1 = 'A'.repeat(6000); // ~1500 tokens each (chars/4)
      const ch2 = 'B'.repeat(6000);
      const ch3 = 'C'.repeat(6000);
      const ch4 = 'D'.repeat(6000);

      // Current node = q2. Following chapters after it: a2(ch2), a3(ch3), a4(ch4)
      // = 4500 tokens (≤ 5000). Adding a fifth (ch5) would exceed the cap, so
      // only the 3 nearest following chapters make it into the prompt.
      const ch5 = 'E'.repeat(6000);
      const q1 = node({ id: 'q1', content: 'q1' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: ch1 });
      const q2 = node({ id: 'q2', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction 2' });
      const a2 = node({ id: 'a2', chatId: 'chat-1', parentId: 'q2', role: 'assistant', content: ch2 });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a2', role: 'user', content: 'Direction 3' });
      const a3 = node({ id: 'a3', chatId: 'chat-1', parentId: 'q3', role: 'assistant', content: ch3 });
      const q4 = node({ id: 'q4', chatId: 'chat-1', parentId: 'a3', role: 'user', content: 'Direction 4' });
      const a4 = node({ id: 'a4', chatId: 'chat-1', parentId: 'q4', role: 'assistant', content: ch4 });
      const q5 = node({ id: 'q5', chatId: 'chat-1', parentId: 'a4', role: 'user', content: 'Direction 5' });
      const a5 = node({ id: 'a5', chatId: 'chat-1', parentId: 'q5', role: 'assistant', content: ch5 });
      const q6 = node({ id: 'q6', chatId: 'chat-1', parentId: 'a5', role: 'user', content: '' });
      await openChat([q1, a1, q2, a2, q3, a3, q4, a4, q5, a5, q6]);
      createFixture(q2);

      prependConfirm('DIRECTOR');
      await component.openPrependDialog();

      expect(llm.streamAnswer).toHaveBeenCalledTimes(1);
      const askMessages = llm.streamAnswer.mock.calls[0][4] as { role: string; content: unknown }[];
      // Last message (the prompt) = DIRECTOR + the 3 nearest following chapters.
      const prompt = String(askMessages[askMessages.length - 1].content);
      expect(prompt).toContain('DIRECTOR');
      expect(prompt).toContain(ch2);
      expect(prompt).toContain(ch3);
      expect(prompt).toContain(ch4);
      // The farthest following whole chapter was dropped, never truncated.
      expect(prompt).not.toContain(ch5);

      // Prior context (like insert) is the path up to the parent (a1).
      expect(askMessages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(String(askMessages[1].content)).toBe(ch1);
    });

    it('a failed LLM call clears the prepend flag and inserts no nodes', async () => {
      const q1 = node({ id: 'q1', content: 'A' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, q3]);
      createFixture(q3);

      (llm.streamAnswer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
      prependConfirm('DIRECTOR');
      await component.openPrependDialog();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(component.prependEnabled()).toBe(false);
      // The failed stream still created the director user node; the flag is
      // rolled back and no result was inserted.
      const nodes = chatService.nodes();
      expect(nodes.some(n => n.role === 'assistant' && n.content === 'Generated')).toBe(false);
      expect(nodes.find(n => n.id === 'q3')?.parentId).toBe('a1');
    });

    it('after prepend the inserted director node becomes part of later contexts (incl. illustration)', async () => {
      const q1 = node({ id: 'q1', content: 'Root direction' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant',
        content: 'Mara folds the letter and watches the conductor pass.',
      });
      const q2 = node({ id: 'q2', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Night train, Mara at the window.' });
      const a2 = node({
        id: 'a2', chatId: 'chat-1', parentId: 'q2', role: 'assistant',
        content: 'The train crosses a frozen bridge.',
      });
      await openChat([q1, a1, q2, a2]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      llm.generateImage.mockResolvedValueOnce({
        content: '',
        images: [{ url: 'data:image/png;base64,QQ==' }],
      });

      createFixture(q2, 'a2');
      prependConfirm('DIRECTOR');
      await component.openPrependDialog();
      await component.illustrate();
      fixture.detectChanges();

      expect(llm.generateImage).toHaveBeenCalledTimes(1);
      const imagesArgs = llm.generateImage.mock.calls[0][2] as { role: string; content: unknown }[];
      // The director text is now a real USER node in the tree, so it appears
      // in later contexts (like illustration) as part of the story path.
      const serialized = JSON.stringify(imagesArgs);
      expect(serialized).toContain('DIRECTOR');
    });
  });
});
