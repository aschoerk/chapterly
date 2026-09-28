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
import { LlmService } from '../../core/llm/llm.service';
import { I18nService } from '../../core/i18n/i18n.service';
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
              _messages: unknown
            ) => {
              const saved = await chatService.addNode(chatId, {
                parentId: questionNodeId,
                role: 'assistant',
                content: 'Generated answer',
                modelId: model?.modelId ?? 'alpha/model',
                providerId: model?.providerId ?? 'prov-1'
              });
              chatService.setActiveChild(questionNodeId, saved.id);
              return saved;
            })
          }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
    component = fixture.componentInstance;
    chatService = TestBed.inject(ChatService);
    llm = TestBed.inject(LlmService) as unknown as {
      askLlm: ReturnType<typeof vi.fn>;
      resolveForCurrentChat: ReturnType<typeof vi.fn>;
      toLlmExtras: ReturnType<typeof vi.fn>;
      streamAnswer: ReturnType<typeof vi.fn>;
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

    await component.generateTitle();

    const structural = chatService.nodes().filter(n => n.role === 'structural');
    expect(structural.length).toBe(1);
    const title = structural[0];
    expect(title.content).toBe('Generated structure');
    expect(title.parentId).toBeNull();
    // the title wraps the first story node
    expect(chatService.nodes().find(n => n.id === 'q1')?.parentId).toBe(title.id);
    expect(chatService.getActivePath()[0].id).toBe(title.id);
    expect(llm.askLlm).toHaveBeenCalledTimes(1);
    // the generated title also becomes the chat title
    expect(chatService.chats().find(c => c.id === 'chat-1')?.title).toBe('Generated structure');
  });

  it('uses every assistant node as context for title/introduction', async () => {
    await openStory();

    await component.generateIntroduction();

    const messages = llm.askLlm.mock.calls[0][3];
    const userMsg = messages.find((m: { role: string }) => m.role === 'user')!;
    expect(userMsg.content).toContain('Answer one');
    expect(userMsg.content).toContain('Answer two');
    expect(userMsg.content).not.toContain('Question');
    // the overview task now defaults to an introduction prompt
    expect(userMsg.content).toContain('introduction');
  });

  it('places the introduction first and wraps the story when no structure node exists', async () => {
    await openStory();

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
    llm.askLlm.mockClear();

    await component.generateHeadings();

    expect(llm.askLlm).toHaveBeenCalledTimes(2);
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
    llm.askLlm.mockClear();
    llm.askLlm.mockResolvedValueOnce({ content: 'First Heading', thinking: '' });
    llm.askLlm.mockResolvedValueOnce({ content: 'Second Heading', thinking: '' });

    await component.generateHeadings();

    const calls = llm.askLlm.mock.calls;
    const userOf = (i: number) =>
      (calls[i][3] as { role: string; content: string }[]).find(m => m.role === 'user')!.content;

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
    llm.askLlm.mockClear();
    llm.askLlm.mockResolvedValueOnce({ content: 'New Heading', thinking: '' });

    await component.generateHeadings();

    // only a2 needs a heading – a1 already has one
    expect(llm.askLlm).toHaveBeenCalledTimes(1);
    const structural = chatService.nodes().filter(n => n.role === 'structural');
    expect(structural.length).toBe(2); // h1 (existing) + new one
    expect(structural.some(n => n.content === 'Existing Heading')).toBe(true);
    expect(chatService.nodes().find(n => n.id === 'a2')!.parentId).not.toBe('q2');

    // the pre-existing heading still appears in the context for a2
    const content = llm.askLlm.mock.calls[0][3]
      .find((m: { role: string }) => m.role === 'user')!.content;
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
    llm.streamAnswer.mockClear();

    component.elaborateFirst.set(1);
    component.elaborateLast.set(2);
    component.elaborateNames.set('');

    await component.confirmElaborate();

    const nodes = chatService.nodes();
    const questions = nodes.filter(n =>
      n.role === 'user' && n.content?.startsWith('elaborate on chapter'));
    expect(questions.map(n => n.content)).toEqual([
      'elaborate on chapter 1',
      'elaborate on chapter 2'
    ]);

    // one LLM answer per question, chained head-to-tail
    const [q1, q2] = questions;
    const a1 = nodes.find(n => n.role === 'assistant' && n.parentId === q1.id)!;
    const a2 = nodes.find(n => n.role === 'assistant' && n.parentId === q2.id)!;
    expect(a1.content).toBe('Generated answer');
    expect(a2.content).toBe('Generated answer');
    expect(q2.parentId).toBe(a1.id); // chapter 2 continues from the chapter-1 answer

    expect(llm.streamAnswer).toHaveBeenCalledTimes(2);

    // the model of the most recent assistant answer drives every question
    expect(q1.modelId).toBe('alpha/model');
    expect(q1.providerId).toBe('prov-1');
    expect(q2.modelId).toBe('alpha/model');
    expect(a2.modelId).toBe('alpha/model');
  });

  it('elaborates each chapter from the point of view of each named character', async () => {
    await openElaborateStory();
    llm.streamAnswer.mockClear();

    component.elaborateFirst.set(1);
    component.elaborateLast.set(1);
    component.elaborateNames.set(' Anna,Ben ');

    await component.confirmElaborate();

    const questions = chatService.nodes()
      .filter(n => n.role === 'user' && n.content?.startsWith('elaborate on chapter'))
      .map(n => n.content);
    expect(questions).toContain([
      'elaborate on chapter 1 out of the view of Anna in first person',
      'elaborate on chapter 1 out of the view of Ben in first person'
    ]);

    // still sequential: the second character hangs under the first answer
    const q1 = chatService.nodes().find(n =>
      n.content === 'elaborate on chapter 1 out of the view of Anna in first person')!;
    const q2 = chatService.nodes().find(n =>
      n.content === 'elaborate on chapter 1 out of the view of Ben in first person')!;
    const a1 = chatService.nodes().find(n => n.role === 'assistant' && n.parentId === q1.id)!;
    expect(q2.parentId).toBe(a1.id);
    expect(llm.streamAnswer).toHaveBeenCalledTimes(2);
  });

  it('pre-selects the most recent answer model when opening the elaborate dialog', async () => {
    await openElaborateStory();

    component.openElaborateDialog();

    expect(component.showElaborateDialog()).toBe(true);
    expect(component.elaborateModelId()).toBe('alpha/model');
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
    llm.streamAnswer.mockClear();

    // First use: elaborate chapters 1–3 with two characters
    component.elaborateFirst.set(1);
    component.elaborateLast.set(3);
    component.elaborateNames.set('Anna, Ben');
    await component.confirmElaborate();

    // Reopen the dialog for the SAME chat.
    llm.streamAnswer.mockClear();
    component.openElaborateDialog();

    expect(component.elaborateFirst()).toBe(4); // last chapter (3) + 1
    expect(component.elaborateLast()).toBe(4);  // defaults to First
    expect(component.elaborateNames()).toBe('Anna, Ben'); // last used characters
  });

  it('keeps elaborate continuation state separate per chat', async () => {
    await openElaborateStory();
    llm.streamAnswer.mockClear();
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
    llm.streamAnswer.mockClear();

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
    llm.streamAnswer.mockClear();

    component.openElaborateDialog();
    expect(component.elaborateModelId()).toBe('alpha/model'); // pre-selected

    component.elaborateModelId.set('beta/model'); // user overrides
    component.elaborateFirst.set(1);
    component.elaborateLast.set(1);
    component.elaborateNames.set('');

    await component.confirmElaborate();

    const nodes = chatService.nodes();
    const q1 = nodes.find(n => n.role === 'user' && n.content === 'elaborate on chapter 1')!;
    expect(q1.modelId).toBe('beta/model');
    expect(q1.providerId).toBe('prov-2');
    const a1 = nodes.find(n => n.role === 'assistant' && n.parentId === q1.id)!;
    expect(a1.modelId).toBe('beta/model');
    expect(a1.providerId).toBe('prov-2');
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
    expect(questions).toEqual([
      'elaborate on chapter 1',
      'elaborate on chapter 2'
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The active path must follow the whole elaboration chain (chapters 1 and 2),
    // not get re-pointed to a stray draft under the first answer.
    const q2 = chatService.nodes().find(n => n.content === 'elaborate on chapter 2')!;
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
