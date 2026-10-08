import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { ChatComponent } from './chat.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatApiPort } from '../../api/chat-api.port';
import {
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateTopicRequest,
  UpdateTopicRequest,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateModelRequest,
  UpdateModelRequest
} from '../../api/chat-api.types';
import {
  Chat, ChatNode, CreateNodeRequest, Project, Persona, Topic, NodeAttachment
} from '../../models/chat';
import { ProviderConfig, ModelEntry } from '../../models/chat-config';
import { ChatParameters, ChatParametersDraft } from '../../models/chat-parameters';
import { ChatService } from '../../core/chat.service';
import { SettingsService } from '../../core/settings.service';
import { LlmOrchestratorService } from '../../core/llm/orchestration';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodeClipboardService } from '../../core/node-clipboard.service';
import { ConfirmService } from '../../core/confirm.service';
import { seedApi } from '../../../../test-helpers/factories';

import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api'


describe('Chat', () => {
  let component: ChatComponent;
  let fixture: ComponentFixture<ChatComponent>;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let llm: {
    askLlm: ReturnType<typeof vi.fn>;
    resolveForCurrentChat: ReturnType<typeof vi.fn>;
    toLlmExtras: ReturnType<typeof vi.fn>;
    streamAnswer: ReturnType<typeof vi.fn>;
  };
  let orch: {
    completion: ReturnType<typeof vi.fn>;
    completeImage: ReturnType<typeof vi.fn>;
    images: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = new InMemoryChatApi();
    localStorage.removeItem('chat.currentChatId');
    localStorage.removeItem('chat.scrollByChatId');
    localStorage.removeItem('chat.generationTasks');
    localStorage.removeItem('chat-client.elaborate.byChatId');

    await TestBed.configureTestingModule({
      imports: [ChatComponent],
      providers: [
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },      
        {
          // Mock the ORCHESTRATOR (transport), NOT the use-case/flow runner:
          // the real send-elaborate flow then creates + streams against the
          // real (in-memory) ChatService, so node-shape + chaining assertions
          // in the elaborate tests keep working.
          provide: LlmOrchestratorService,
          useValue: {
            completion: vi.fn(async (
              _cx: unknown,
              _req: unknown,
              opts?: { onChunk?: (c: { content: string }) => void },
            ) => {
              opts?.onChunk?.({ content: 'Generated answer' });
              return { text: { status: 'ok', value: 'Generated answer' } };
            }),
            completeImage: vi.fn(async () => ({ images: { status: 'refused', value: null } })),
            images: vi.fn(async () => ({ images: { status: 'refused', value: null } }))
          }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
    component = fixture.componentInstance;
    chatService = TestBed.inject(ChatService);
    orch = TestBed.inject(LlmOrchestratorService) as unknown as {
      completion: ReturnType<typeof vi.fn>;
      completeImage: ReturnType<typeof vi.fn>;
      images: ReturnType<typeof vi.fn>;
    };
    TestBed.inject(I18nService).setLocale('en');

    const settings = TestBed.inject(SettingsService);
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [{ id: 'm-1' }]
    });
    await settings.loadAll();
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  /** Seed a story with two assistant answers and make it the active chat. */
  async function openStory(): Promise<void> {
    seedApi(api, {
      chats: [{ id: 'chat-1', title: 'Story' }],
      nodes: [
        { id: 'q1', chatId: 'chat-1', parentId: null, role: 'user', content: 'Question' },
        { id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer one' },
        { id: 'a2', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer two' }
      ]
    });
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
  }

  it('generates a title that wraps the whole story', async () => {
    await openStory();
    orch.completion.mockResolvedValueOnce({
      text: { status: 'ok', value: 'Generated structure' }
    });

    await component.generateTitle();

    const structural = chatService.nodes().filter(n => n.role === 'structural');
    expect(structural.length).toBe(1);
    const title = structural[0];
    expect(title.content).toBe('Generated structure');
    expect(title.parentId).toBeNull();
    // the title wraps the first story node
    expect(chatService.nodes().find(n => n.id === 'q1')?.parentId).toBe(title.id);
    expect(chatService.getActivePath()[0].id).toBe(title.id);
    expect(orch.completion).toHaveBeenCalledTimes(1);
    // the generated title also becomes the chat title
    expect(chatService.chats().find(c => c.id === 'chat-1')?.title).toBe('Generated structure');
  });

  it('uses every assistant node as context for title/introduction', async () => {
    await openStory();

    await component.generateIntroduction();

    const req = orch.completion.mock.calls[0][1] as {
      messages: { role: string; content: string }[];
    };
    const userMsg = req.messages.find(m => m.role === 'user')!;
    expect(userMsg.content).toContain('Answer one');
    expect(userMsg.content).toContain('Answer two');
    expect(userMsg.content).not.toContain('Question');
    // the overview task now defaults to an introduction prompt
    expect(userMsg.content).toContain('introduction');
  });

  it('places the introduction first and wraps the story when no structure node exists', async () => {
    await openStory();
    orch.completion.mockResolvedValueOnce({
      text: { status: 'ok', value: 'Generated structure' }
    });

    await component.generateIntroduction();

    const intro = chatService.nodes().find(n => n.role === 'structural');
    expect(intro?.content).toBe('Generated structure');
    expect(intro?.parentId).toBeNull();
    // the intro wraps the first story node → it becomes the 1st node
    expect(chatService.nodes().find(n => n.id === 'q1')?.parentId).toBe(intro?.id);
    // (a draft leaf may be appended at the end by ensureDraftAtLeaf)
    expect(chatService.getActivePath().slice(0, 3).map(n => n.id)).toEqual([intro?.id, 'q1', 'a1']);
  });

  it('places the introduction second, right after an existing structure node', async () => {
    seedApi(api, {
      chats: [{ id: 'chat-1', title: 'Story' }],
      nodes: [
        { id: 't1', chatId: 'chat-1', parentId: null, role: 'structural', content: 'Story title' },
        { id: 'q1', chatId: 'chat-1', parentId: 't1', role: 'user', content: 'Question' },
        { id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer one' },
        { id: 'a2', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer two' }
      ]
    });
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 't1');
    chatService.setActiveChild('t1', 'q1');
    chatService.setActiveChild('q1', 'a1');
    orch.completion.mockResolvedValueOnce({
      text: { status: 'ok', value: 'Generated structure' }
    });

    await component.generateIntroduction();

    const structural = chatService.nodes().filter(n => n.role === 'structural');
    expect(structural.length).toBe(2); // title + introduction
    const intro = structural.find(n => n.content === 'Generated structure')!;
    // the intro sits right after the existing structure node (2nd in the story)
    expect(intro.parentId).toBe('t1');
    expect(chatService.nodes().find(n => n.id === 'q1')?.parentId).toBe(intro.id);
    // (a draft leaf may be appended at the end by ensureDraftAtLeaf)
    expect(chatService.getActivePath().slice(0, 4).map(n => n.id)).toEqual(['t1', intro.id, 'q1', 'a1']);
  });

  /** Seed a linear chain q1 → a1 → q2 → a2 and walk it. */
  async function openChapteredStory(): Promise<void> {
    seedApi(api, {
      chats: [{ id: 'chat-1', title: 'Story' }],
      nodes: [
        { id: 'q1', chatId: 'chat-1', parentId: null, role: 'user', content: 'Q1' },
        { id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer one' },
        { id: 'q2', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Q2' },
        { id: 'a2', chatId: 'chat-1', parentId: 'q2', role: 'assistant', content: 'Answer two' }
      ]
    });
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    chatService.setActiveChild('a1', 'q2');
    chatService.setActiveChild('q2', 'a2');
  }

  it('generates a heading for each assistant node on the active path', async () => {
    await openChapteredStory();
    orch.completion.mockClear();

    await component.generateHeadings();

    expect(orch.completion).toHaveBeenCalledTimes(2);
    const structural = chatService.nodes().filter(n => n.role === 'structural');
    expect(structural.length).toBe(2);

    // each answer is now wrapped by its own heading
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    expect(chatService.nodes().find(n => n.id === a1.parentId)?.role).toBe('structural');
    const a2 = chatService.nodes().find(n => n.id === 'a2')!;
    expect(chatService.nodes().find(n => n.id === a2.parentId)?.role).toBe('structural');
  });

  it('provides previous chapters incl. their headings as context for the last one', async () => {
    await openChapteredStory();
    orch.completion.mockClear();
    orch.completion.mockResolvedValueOnce({ text: { status: 'ok', value: 'First Heading' } });
    orch.completion.mockResolvedValueOnce({ text: { status: 'ok', value: 'Second Heading' } });

    await component.generateHeadings();

    const calls = orch.completion.mock.calls;
    const userOf = (i: number) =>
      (calls[i][1] as { messages: { role: string; content: string }[] }).messages
        .find(m => m.role === 'user')!.content;

    // first call: only its own chapter, no prior heading
    expect(userOf(0)).toContain('Answer one');
    expect(userOf(0)).not.toContain('Answer two');
    // second call: previous chapter + its generated heading + the current (last) one
    expect(userOf(1)).toContain('Answer one');
    expect(userOf(1)).toContain('"First Heading"');
    expect(userOf(1)).toContain('Answer two');
  });

  it('skips chapters that already have a heading but keeps them in context', async () => {
    seedApi(api, {
      chats: [{ id: 'chat-1', title: 'Story' }],
      nodes: [
        { id: 'q1', chatId: 'chat-1', parentId: null, role: 'user', content: 'Q1' },
        { id: 'h1', chatId: 'chat-1', parentId: 'q1', role: 'structural', content: 'Existing Heading' },
        { id: 'a1', chatId: 'chat-1', parentId: 'h1', role: 'assistant', content: 'Answer one' },
        { id: 'q2', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Q2' },
        { id: 'a2', chatId: 'chat-1', parentId: 'q2', role: 'assistant', content: 'Answer two' }
      ]
    });
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'h1');
    chatService.setActiveChild('h1', 'a1');
    chatService.setActiveChild('a1', 'q2');
    chatService.setActiveChild('q2', 'a2');
    orch.completion.mockClear();
    orch.completion.mockResolvedValueOnce({ text: { status: 'ok', value: 'New Heading' } });

    await component.generateHeadings();

    // only a2 needs a heading – a1 already has one
    expect(orch.completion).toHaveBeenCalledTimes(1);
    const structural = chatService.nodes().filter(n => n.role === 'structural');
    expect(structural.length).toBe(2); // h1 (existing) + new one
    expect(structural.some(n => n.content === 'Existing Heading')).toBe(true);
    expect(chatService.nodes().find(n => n.id === 'a2')!.parentId).not.toBe('q2');

    // the pre-existing heading still appears in the context for a2
    const content = (orch.completion.mock.calls[0][1] as {
      messages: { role: string; content: string }[];
    }).messages.find((m: { role: string }) => m.role === 'user')!.content;
    expect(content).toContain('"Existing Heading"');
    expect(content).toContain('Answer two');
  });

  /** Seed one chapter-desc answer (with a model binding) and open it. */
  async function openElaborateStory(): Promise<void> {
    seedApi(api, {
      chats: [{ id: 'chat-1', title: 'Story' }],
      nodes: [
        { id: 'q0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Chapters', createdAt: '2025-01-01T00:00:00Z' },
        {
          id: 'a0', chatId: 'chat-1', parentId: 'q0', role: 'assistant',
          content: 'Chapter 1: …\nChapter 2: …\nChapter 3: …',
          modelId: 'alpha/model', providerId: 'prov-1',
          createdAt: '2025-01-02T00:00:00Z'
        }
      ]
    });
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'q0');
    chatService.setActiveChild('q0', 'a0');
  }

  it('elaborates chapters first..last sequentially with the most recent answer model', async () => {
    await openElaborateStory();
    orch.completion.mockClear();

    component.elaborateFirst.set(1);
    component.elaborateLast.set(2);
    component.elaborateNames.set('');

    await component.confirmElaborate();

    const nodes = chatService.nodes();
    const questions = nodes.filter(n =>
      n.role === 'user' && n.content?.startsWith('elaborate on chapter'));
    // the generic prompt leads with the chapter line; the rest is the
    // user-editable "structure.elaborate" template's expansion
    expect(questions.map(n => (n.content ?? '').split('\n')[0])).toEqual([
      'elaborate on chapter 1',
      'elaborate on chapter 2'
    ]);
    expect(questions[0].content).toContain('Expand chapter 1 in detail');

    // one LLM answer per question, chained head-to-tail. Answers are read via
    // getChildren (editAssistant VERSIONS the placeholder → only the current
    // node carries the content).
    const [q1, q2] = questions;
    const a1 = chatService.getChildren(q1.id).find(n => n.role === 'assistant')!;
    const a2 = chatService.getChildren(q2.id).find(n => n.role === 'assistant')!;
    expect(a1.content).toBe('Generated answer');
    expect(a2.content).toBe('Generated answer');
    expect(q2.parentId).toBe(a1.id); // chapter 2 continues from the chapter-1 answer

    expect(orch.completion).toHaveBeenCalledTimes(2);

    // the model of the most recent assistant answer drives every question
    expect(q1.modelId).toBe('alpha/model');
    expect(q1.providerId).toBe('prov-1');
    expect(q2.modelId).toBe('alpha/model');
    expect(a2.modelId).toBe('alpha/model');
  });

  it('elaborates each chapter from the point of view of each named character', async () => {
    await openElaborateStory();
    orch.completion.mockClear();

    component.elaborateFirst.set(1);
    component.elaborateLast.set(1);
    component.elaborateNames.set(' Anna,Ben ');

    await component.confirmElaborate();

    // The character view template starts with the "Expand chapter …" line;
    // the per-character instruction is the second line.
    const questions = chatService.nodes()
      .filter(n => n.role === 'user' && n.content?.startsWith('Expand chapter'))
      .map(n => n.content ?? '');
    expect(questions.map(q => q.split('\n')[1])).toEqual([
      'Elaborate the chapter this time out of the view of Anna in first person. Do never repeat content verbatim from previously generated views of the same chapter.',
      'Elaborate the chapter this time out of the view of Ben in first person. Do never repeat content verbatim from previously generated views of the same chapter.'
    ]);

    // still sequential: the second character hangs under the first answer
    const q1 = chatService.nodes().find(n =>
      n.content.indexOf('view of Anna in first person') !== -1)!;
    const q2 = chatService.nodes().find(n =>
      n.content.indexOf('view of Ben in first person') !== -1) !;
    const a1 = chatService.getChildren(q1.id).find(n => n.role === 'assistant')!;
    expect(q2.parentId).toBe(a1.id);
    expect(orch.completion).toHaveBeenCalledTimes(2);
  });

  it('elaborates each chapter following the dialog hints', async () => {
    await openElaborateStory();
    orch.completion.mockClear();

    component.elaborateFirst.set(1);
    component.elaborateLast.set(2);
    component.elaborateNames.set('');
    component.elaborateHints.set(' dark, melancholic tone ');

    await component.confirmElaborate();

    const questions = chatService.nodes()
      .filter(n => n.role === 'user' && n.content?.startsWith('elaborate on chapter'))
      .map(n => n.content ?? '');
    expect(questions.map(q => q.split('\n')[0])).toEqual([
      'elaborate on chapter 1',
      'elaborate on chapter 2'
    ]);
    for (const q of questions) {
      expect(q).toContain('Follow these hints from the user: dark, melancholic tone');
    }
    expect(orch.completion).toHaveBeenCalledTimes(2);
  });

  it('pre-selects the most recent answer model when opening the elaborate dialog', async () => {
    await openElaborateStory();

    component.openElaborateDialog();

    expect(component.showElaborateDialog()).toBe(true);
    expect(component.elaborateModelId()).toBe('alpha/model');
  });

  it('Escape closes the elaborate dialog (same as its Cancel button)', async () => {
    await openElaborateStory();

    component.openElaborateDialog();
    expect(component.showElaborateDialog()).toBe(true);

    component.onKey({
      key: 'Escape',
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent);

    expect(component.showElaborateDialog()).toBe(false);
  });

  it('initializes first/last chapter to 1 with empty characters the first time', async () => {
    await openElaborateStory();

    component.openElaborateDialog();

    expect(component.elaborateFirst()).toBe(1);
    expect(component.elaborateLast()).toBe(1);
    expect(component.elaborateNames()).toBe('');
  });

  it('reopens elaborate on the same chat at previous last chapter + 1 with the last characters', async () => {
    await openElaborateStory();
    orch.completion.mockClear();

    // First use: elaborate chapters 1–3 with two characters + hints
    component.elaborateFirst.set(1);
    component.elaborateLast.set(3);
    component.elaborateNames.set('Anna, Ben');
    component.elaborateHints.set('keep it atmospheric');
    await component.confirmElaborate();

    // Reopen the dialog for the SAME chat.
    orch.completion.mockClear();
    component.openElaborateDialog();

    expect(component.elaborateFirst()).toBe(4); // last chapter (3) + 1
    expect(component.elaborateLast()).toBe(4);  // defaults to First
    expect(component.elaborateNames()).toBe('Anna, Ben'); // last used characters
    expect(component.elaborateHints()).toBe('keep it atmospheric'); // last used hints
  });

  it('toggling stick-to-last points First/Last at the stored last chapter and restores the continuation when unchecked', async () => {
    await openElaborateStory();
    orch.completion.mockClear();

    // First use: elaborate chapters 1–3 → stored last chapter = 3.
    component.elaborateFirst.set(1);
    component.elaborateLast.set(3);
    await component.confirmElaborate();

    // Reopen: continuation defaults to 4.
    component.openElaborateDialog();
    expect(component.elaborateFirst()).toBe(4);
    expect(component.elaborateLast()).toBe(4);

    // The user tweaks the fields, then ticks "stick to last chapter".
    component.elaborateFirst.set(7);
    component.elaborateLast.set(9);
    component.onStickLastToggle(true);

    // First/Last now show the actual single stick chapter, not 7..9.
    expect(component.elaborateStickLast()).toBe(true);
    expect(component.elaborateFirst()).toBe(3);
    expect(component.elaborateLast()).toBe(3);

    // Unchecking restores the default continuation (last elaborated + 1).
    component.onStickLastToggle(false);
    expect(component.elaborateStickLast()).toBe(false);
    expect(component.elaborateFirst()).toBe(4);
    expect(component.elaborateLast()).toBe(4);
  });

  it('keeps elaborate continuation state separate per chat', async () => {
    await openElaborateStory();
    orch.completion.mockClear();
    component.elaborateFirst.set(1);
    component.elaborateLast.set(5);
    component.elaborateNames.set('Cassidy');
    await component.confirmElaborate();

    // Switch to a different chat: its dialog must start back at chapter 1.
    seedApi(api, {
      chats: [{ id: 'chat-2', title: 'Other', projectId: null }],
      nodes: [
        { id: 'q0b', chatId: 'chat-2', parentId: null, role: 'user', content: 'Chapters', createdAt: '2025-01-01T00:00:00Z' },
        {
          id: 'a0b', chatId: 'chat-2', parentId: 'q0b', role: 'assistant',
          content: 'Chapter 1: …', modelId: 'alpha/model', providerId: 'prov-1',
          createdAt: '2025-01-02T00:00:00Z'
        }
      ]
    });
    await chatService.loadChats();
    await chatService.selectChat('chat-2');
    chatService.setActiveChild(null, 'q0b');
    chatService.setActiveChild('q0b', 'a0b');
    orch.completion.mockClear();

    component.openElaborateDialog();

    // The other chat has never been elaborated → back to defaults.
    expect(component.elaborateFirst()).toBe(1);
    expect(component.elaborateLast()).toBe(1);
    expect(component.elaborateNames()).toBe('');
  });

  it('uses the model chosen in the elaborate dialog for every elaboration', async () => {
    // a second enabled model that is NOT the anchor's model
    seedApi(api, {
      providers: [{ id: 'prov-2' }],
      models: [{ id: 'm-2', displayName: 'Beta', modelId: 'beta/model', providerId: 'prov-2' }]
    });
    await TestBed.inject(SettingsService).loadAll();

    await openElaborateStory();
    orch.completion.mockClear();

    component.openElaborateDialog();
    expect(component.elaborateModelId()).toBe('alpha/model'); // pre-selected

    component.elaborateModelId.set('beta/model'); // user overrides
    component.elaborateFirst.set(1);
    component.elaborateLast.set(1);
    component.elaborateNames.set('');

    await component.confirmElaborate();

    const nodes = chatService.nodes();
    const q1 = nodes.find(n => n.role === 'user' && n.content?.startsWith('elaborate on chapter 1'))!;
    expect(q1.modelId).toBe('beta/model');
    expect(q1.providerId).toBe('prov-2');
    const a1 = chatService.getChildren(q1.id).find(n => n.role === 'assistant')!;
    expect(a1.modelId).toBe('beta/model');
    expect(a1.providerId).toBe('prov-2');
  });

  it('pastes a copied chapter at the top of the current chat', async () => {
    await openStory();
    const clipboard = TestBed.inject(NodeClipboardService);
    const src = chatService.nodes().find(n => n.id === 'a2')!;
    clipboard.copy(src);
    expect(clipboard.hasContent()).toBe(true);

    await component.pasteAtTop();

    const pasted = chatService.nodes().filter(n => n.content === 'Answer two' && n.id !== 'a2');
    expect(pasted.length).toBe(1);
    expect(pasted[0].parentId).toBeNull();
    expect(pasted[0].chatId).toBe('chat-1');
  });

  // ----------------------------------------------------------------------
  // Navbar multi-selection (Ctrl+click / Ctrl+drag / copy-cut-delete / paste-after)
  // ----------------------------------------------------------------------

  function ctrlPointerEvent(overrides: Partial<PointerEvent> = {}): PointerEvent {
    return {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides
    } as unknown as PointerEvent;
  }

  it('toggles navbar selection on plain Ctrl+click', async () => {
    await openStory(); // active path ids: q1, a1
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;

    component.onNavPointerDown(ctrlPointerEvent(), a1);
    expect(component.isNavNodeSelected('a1')).toBe(false); // decided on pointer-up
    component.onNavDocumentPointerUp(ctrlPointerEvent());
    expect(component.isNavNodeSelected('a1')).toBe(true);

    // second Ctrl+click deselects
    component.onNavPointerDown(ctrlPointerEvent(), a1);
    component.onNavDocumentPointerUp(ctrlPointerEvent());
    expect(component.isNavNodeSelected('a1')).toBe(false);
  });

  it('selects a range with Ctrl+drag in navbar order', async () => {
    await openStory();
    const q1 = chatService.nodes().find(n => n.id === 'q1')!;
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;

    component.onNavPointerDown(ctrlPointerEvent(), q1);
    component.onNavPointerEnter(a1); // drag continues onto the next nav node
    expect(component.isNavNodeSelected('q1')).toBe(true);
    expect(component.isNavNodeSelected('a1')).toBe(true);
    component.onNavDocumentPointerUp(ctrlPointerEvent());
    expect(component.navSelectedIds()).toEqual(['q1', 'a1']);
  });

  it('copies the selected nodes as an ordered sequence', async () => {
    await openStory();
    const clipboard = TestBed.inject(NodeClipboardService);
    component.toggleNavSelection('q1');
    component.toggleNavSelection('a1');
    component.copyNavSelection();
    const contents = clipboard.clipboard()!.nodes.map(n => n.content);
    expect(contents).toEqual(['Question', 'Answer one']);
  });

  it('cuts selected nodes: clipboard + trash, following text stays', async () => {
    await openStory();
    const clipboard = TestBed.inject(NodeClipboardService);
    const confirm = TestBed.inject(ConfirmService);
    vi.spyOn(confirm, 'ask').mockResolvedValue(true);

    component.toggleNavSelection('a1');
    await component.cutNavSelection();

    expect(clipboard.clipboard()!.nodes.map(n => n.content)).toEqual(['Answer one']);
    expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
    expect(chatService.deletedNodes().some(n => n.id === 'a1')).toBe(true);
  });

  it('deletes selected nodes (single node only, children stay)', async () => {
    await openStory();
    component.toggleNavSelection('a1');
    await component.deleteNavSelection();

    expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
    // the following answer attaches to the question again
    expect(chatService.nodes().find(n => n.id === 'a2')?.parentId).toBe('q1');
    expect(chatService.deletedNodes().some(n => n.id === 'a1')).toBe(true);
  });

  it('pastes a copied chain behind a visible navbar node as its linear continuation', async () => {
    await openStory(); // path: q1 → a1 → [auto draft]
    const clipboard = TestBed.inject(NodeClipboardService);
    const q1 = chatService.nodes().find(n => n.id === 'q1')!;
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    // whatever followed a1 on the active path (here: the auto-created draft)
    const rightId = chatService.getActivePath().find(n => n.parentId === a1.id)?.id ?? null;
    clipboard.copySequence([q1, a1]); // chain q1 (root) → a1 (child)

    await component.pasteNavSelectionAfter('a1');

    const byContent = (c: string) =>
      chatService.nodes().filter(n => n.content === c && n.isCurrent);
    const pastedQ = byContent('Question').find(n => n.id !== 'q1')!;
    const pastedA = byContent('Answer one').find(n => n.id !== 'a1')!;

    // the chain root hangs under the LEFT visible node, subtree kept
    expect(pastedQ.parentId).toBe('a1');
    expect(pastedA.parentId).toBe(pastedQ.id);
    // the node that used to follow a1 now continues behind the chain
    if (rightId) {
      expect(chatService.nodes().find(n => n.id === rightId)?.parentId).toBe(pastedA.id);
    }
    const ids = chatService.getActivePath().map(n => n.id);
    expect(ids.slice(0, 3)).toEqual(['q1', a1.id, pastedQ.id]);
    expect(ids[3]).toBe(pastedA.id);
  });

  it('pastes a copied chain between the two visible navbar nodes around the paste button', async () => {
    await openChapteredStory(); // path: q1 → a1 → q2 → a2
    const clipboard = TestBed.inject(NodeClipboardService);
    const q1 = chatService.nodes().find(n => n.id === 'q1')!;
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    clipboard.copySequence([q1, a1]); // chain q1 (root) → a1 (child)

    // the paste button sits between a1 (left) and q2 (right) on the visible chain
    await component.pasteNavSelectionAfter('a1');

    const byContent = (c: string) =>
      chatService.nodes().filter(n => n.content === c && n.isCurrent);
    const pastedQ = byContent('Q1').find(n => n.id !== 'q1')!;
    const pastedA = byContent('Answer one').find(n => n.id !== 'a1')!;

    // the chain root hangs under the LEFT node …
    expect(pastedQ.parentId).toBe('a1');
    expect(pastedA.parentId).toBe(pastedQ.id);
    // … and the RIGHT node (q2) is re-hung under the chain's last node, so the
    // chain is spliced into the visible linear order: a1 → chain → q2
    expect(chatService.nodes().find(n => n.id === 'q2')?.parentId).toBe(pastedA.id);
    // q2's own subtree (a2) stays untouched under q2
    expect(chatService.nodes().find(n => n.id === 'a2')?.parentId).toBe('q2');
    const ids = chatService.getActivePath().map(n => n.id);
    expect(ids.slice(1, 5)).toEqual([a1.id, pastedQ.id, pastedA.id, 'q2']);

    // both the reparent (patchNode) and the ordering survive a reload
    await chatService.loadNodes('chat-1');
    expect(chatService.nodes().find(n => n.id === 'q2')?.parentId).toBe(pastedA.id);
  });

  it('opens the paste-button context menu offering Insert and Append', async () => {
    await openChapteredStory(); // path: q1 → a1 → q2 → a2
    const clipboard = TestBed.inject(NodeClipboardService);
    clipboard.copySequence([chatService.nodes().find(n => n.id === 'q1')!]);

    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    component.openNavPasteMenu({
      clientX: 120,
      clientY: 80,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent, a1);

    const menu = component.navPasteMenu();
    expect(menu).not.toBeNull();
    expect(menu!.leftId).toBe('a1');
    expect(menu!.rightId).toBe('q2');

    const items = component.navPasteMenuItems(menu!);
    expect(items.length).toBe(2);
    expect(items[0].label).toContain('Insert');
    expect(items[1].label).toContain('Append');
    expect(component.navPasteMenuLeftPx()).toBeGreaterThanOrEqual(8);
    expect(component.navPasteMenuTopPx()).toBeGreaterThanOrEqual(8);
  });

  it('appending from the paste-button menu keeps the chain invisible: root under the left node, sibling of the right node', async () => {
    await openChapteredStory(); // path: q1 → a1 → q2 → a2
    const clipboard = TestBed.inject(NodeClipboardService);
    const q1 = chatService.nodes().find(n => n.id === 'q1')!;
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    clipboard.copySequence([q1, a1]); // chain q1 (root) → a1 (child)

    // Append between a1 (left) and q2 (right): q2 must stay the active child.
    await component.appendNavSelectionAfter('a1');

    const byContent = (c: string) =>
      chatService.nodes().filter(n => n.content === c && n.isCurrent);
    const pastedQ = byContent('Q1').find(n => n.id !== 'q1')!;
    const pastedA = byContent('Answer one').find(n => n.id !== 'a1')!;

    // the chain root hangs under the LEFT node …
    expect(pastedQ.parentId).toBe('a1');
    expect(pastedA.parentId).toBe(pastedQ.id);
    // … as a SIBLING of the right node — q2 is NOT re-hung under the chain
    expect(chatService.nodes().find(n => n.id === 'q2')?.parentId).toBe('a1');
    // the pasted chain never becomes visible in the navbar: the first four
    // visible nodes stay q1 → a1 → q2 → a2 (a draft follows a2)
    const ids = chatService.getActivePath().map(n => n.id);
    expect(ids.slice(0, 4)).toEqual(['q1', 'a1', 'q2', 'a2']);
    // … but both are siblings under a1 and the chain root comes right before q2
    const kids = chatService.getChildren('a1').map(n => n.id);
    expect(kids.indexOf(pastedQ.id) + 1).toBe(kids.indexOf('q2'));
  });

  it('appending at the end makes the pasted chain visible', async () => {
    await openChapteredStory(); // path: q1 → a1 → q2 → a2 → [draft]
    const clipboard = TestBed.inject(NodeClipboardService);
    const q1 = chatService.nodes().find(n => n.id === 'q1')!;
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    clipboard.copySequence([q1, a1]); // chain q1 (root) → a1 (child)

    // Paste button behind the LAST visible node → no right node.
    const lastVisible = chatService.getActivePath().at(-1)!;
    await component.appendNavSelectionAfter(lastVisible.id);

    const byContent = (c: string) =>
      chatService.nodes().filter(n => n.content === c && n.isCurrent);
    const pastedQ = byContent('Q1').find(n => n.id !== 'q1')!;
    const pastedA = byContent('Answer one').find(n => n.id !== 'a1')!;

    expect(pastedQ.parentId).toBe(lastVisible.id);
    expect(pastedA.parentId).toBe(pastedQ.id);
    // with no right node the chain becomes the visible continuation
    const ids = chatService.getActivePath().map(n => n.id);
    const qIdx = ids.indexOf(pastedQ.id);
    expect(qIdx).toBeGreaterThanOrEqual(0);
    expect(qIdx).toBe(ids.indexOf(lastVisible.id) + 1);
    expect(ids[qIdx + 1]).toBe(pastedA.id);
  });

  it('normalises navbar selection to a contiguous chain', async () => {
    await openChapteredStory(); // active path ids: q1, a1, q2, a2
    fixture.detectChanges(); // initialise the path-key effect

    // toggling two non-adjacent nodes fills the gap → one unbroken chain
    component.toggleNavSelection('q1');
    component.toggleNavSelection('q2');
    expect(component.navSelectedIds()).toEqual(['q1', 'a1', 'q2']);

    // deselecting the lower endpoint shrinks the chain to the rest
    component.toggleNavSelection('q1');
    expect(component.navSelectedIds()).toEqual(['a1', 'q2']);
  });

  it('clears the navbar selection as soon as a child is switched', async () => {
    seedApi(api, {
      chats: [{ id: 'chat-1', title: 'Story' }],
      nodes: [
        { id: 'q1', chatId: 'chat-1', parentId: null, role: 'user', content: 'Q' },
        { id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A1' },
        { id: 'a2', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A2' },
        { id: 'a3', chatId: 'chat-1', parentId: 'a1', role: 'assistant', content: 'A3' }
      ]
    });
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    chatService.setActiveChild('a1', 'a3');
    fixture.detectChanges(); // initialise the path-key effect

    component.toggleNavSelection('a1');
    expect(component.isNavNodeSelected('a1')).toBe(true);

    // switching the active child under q1 from a1 to a2 changes the path
    chatService.setActiveChild('q1', 'a2');
    fixture.detectChanges();
    expect(component.navSelectedIds()).toEqual([]);
    expect(component.isNavNodeSelected('a1')).toBe(false);
  });

  it('deleting a chain reparents following text to the topmost surviving ancestor', async () => {
    await openChapteredStory(); // q1 -> a1 -> q2 -> a2
    fixture.detectChanges();

    component.toggleNavSelection('a1');
    component.toggleNavSelection('q2');
    expect(component.navSelectedIds()).toEqual(['a1', 'q2']);

    await component.deleteNavSelection();

    expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
    expect(chatService.nodes().find(n => n.id === 'q2')).toBeUndefined();
    // a2 (the following text) is re-attached under q1 — the chain's
    // topmost surviving ancestor.
    expect(chatService.nodes().find(n => n.id === 'a2')?.parentId).toBe('q1');
    expect(chatService.deletedNodes().some(n => n.id === 'a1')).toBe(true);
  });

  it('cutting a chain puts the chain in the clipboard and reparents the following text', async () => {
    await openChapteredStory(); // q1 -> a1 -> q2 -> a2
    fixture.detectChanges();
    const clipboard = TestBed.inject(NodeClipboardService);
    const confirm = TestBed.inject(ConfirmService);
    vi.spyOn(confirm, 'ask').mockResolvedValue(true);

    component.toggleNavSelection('a1');
    component.toggleNavSelection('q2');
    expect(component.navSelectedIds()).toEqual(['a1', 'q2']);

    await component.cutNavSelection();

    expect(clipboard.clipboard()!.nodes.map(n => n.content)).toEqual(['Answer one', 'Q2']);
    expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
    expect(chatService.nodes().find(n => n.id === 'q2')).toBeUndefined();
    // a2 is re-attached under the topmost surviving ancestor (q1)
    expect(chatService.nodes().find(n => n.id === 'a2')?.parentId).toBe('q1');
  });
});

// ---------------------------------------------------------------------------
// Integration: REAL LlmService + mocked SSE fetch. Exercises the actual
// streaming path (startGeneration/stopGeneration, editAssistant versioning,
// requestAnimationFrame reveal). Regression test for "the generation stopped
// after the first elaboration".
// ---------------------------------------------------------------------------
describe('Chat · elaborate with real streaming', () => {
  let component: ChatComponent;
  let fixture: ComponentFixture<ChatComponent>;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let fetchMock: ReturnType<typeof vi.fn>;

  function sseResponse(content: string): object {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`,
      `data: [DONE]\n`,
      ''
    ].join('\n');
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'text/event-stream' : null
      },
      body: new ReadableStream({
        start(controller: any) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        }
      }),
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => ''
    };
  }

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    localStorage.clear();

    if (typeof window.requestAnimationFrame !== 'function') {
      (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    }
    if (typeof window.cancelAnimationFrame !== 'function') {
      (window as any).cancelAnimationFrame = () => {};
    }

    fetchMock = vi.fn(() => Promise.resolve(sseResponse('Elaborated chapter')));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchMock);

    await TestBed.configureTestingModule({
      imports: [ChatComponent],
      providers: [
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
    component = fixture.componentInstance;
    chatService = TestBed.inject(ChatService);
    const settings = TestBed.inject(SettingsService);
    TestBed.inject(I18nService).setLocale('en');

    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [{ id: 'm-1', modelId: 'alpha/model', providerId: 'prov-1' }],
      chats: [{ id: 'chat-1', title: 'Story' }],
      nodes: [
        { id: 'q0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Chapters', createdAt: '2025-01-01T00:00:00Z' },
        {
          id: 'a0', chatId: 'chat-1', parentId: 'q0', role: 'assistant',
          content: 'Chapter 1 and Chapter 2 are described here',
          modelId: 'alpha/model', providerId: 'prov-1',
          createdAt: '2025-01-02T00:00:00Z'
        }
      ]
    });
    await settings.loadAll();
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'q0');
    chatService.setActiveChild('q0', 'a0');
    await fixture.whenStable();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the LLM once for every requested chapter', async () => {
    component.elaborateFirst.set(1);
    component.elaborateLast.set(2);
    component.elaborateNames.set('');

    await component.confirmElaborate();

    const questions = chatService.nodes()
      .filter(n => n.role === 'user' && n.content?.startsWith('elaborate on chapter'))
      .map(n => n.content)
      .sort();
    expect(questions.map(q => q.split('\n')[0])).toEqual([
      'elaborate on chapter 1',
      'elaborate on chapter 2'
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The active path must follow the whole elaboration chain (chapters 1 and 2),
    // not get re-pointed to a stray draft under the first answer.
    const q2 = chatService.nodes().find(n => n.content?.startsWith('elaborate on chapter 2'))!;
    // chapter-1 answer is the parent of chapter-2's question
    const a1 = chatService.nodes().find(n => n.id === q2.parentId)!;
    const a2 = chatService.nodes().find(n =>
      n.role === 'assistant' && n.parentId === q2.id && n.isCurrent)!;

    const path = chatService.getActivePath();
    const pathIds = path.map(n => n.id);
    expect(pathIds).toContain(q2.id);
    expect(pathIds).toContain(a2.id);
    // the only user node hanging off chapter-1's answer is chapter-2's question
    const userChildrenOfA1 = chatService.getChildren(q2.parentId ?? null)
      .filter(n => n.role === 'user');
    expect(userChildrenOfA1.map(n => n.id)).toEqual([q2.id]);
  });
});
