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
  };

  beforeEach(async () => {
    api = new InMemoryChatApi();
    localStorage.removeItem('chat.currentChatId');
    localStorage.removeItem('chat.scrollByChatId');
    localStorage.removeItem('chat.generationTasks');

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
            toLlmExtras: vi.fn(() => ({}))
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

  it('uses every assistant node as context for title/summary', async () => {
    await openStory();

    await component.generateSummary();

    const messages = llm.askLlm.mock.calls[0][3];
    const userMsg = messages.find((m: { role: string }) => m.role === 'user')!;
    expect(userMsg.content).toContain('Answer one');
    expect(userMsg.content).toContain('Answer two');
    expect(userMsg.content).not.toContain('Question');
  });

  it('appends the summary at the end of the active path', async () => {
    await openStory();
    const leafId = chatService.getActivePath().at(-1)!.id;

    await component.generateSummary();

    const summary = chatService.nodes().find(n => n.role === 'structural');
    expect(summary?.parentId).toBe(leafId);
    expect(chatService.getActiveChildId(leafId)).toBe(summary?.id);
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
});
