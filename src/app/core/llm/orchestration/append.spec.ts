import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeModel, makeChat } from '../../../../../test-helpers/factories';
import { SettingsService } from '../../settings.service';
import { ChatService } from '../../chat.service';
import { I18nService } from '../../i18n/i18n.service';
import { LlmUseCaseRunner } from './usecases';
import { LlmPostprocessorService } from './postprocessor';

/**
 * A streaming OpenAI-compatible SSE body. Emits one `data:` line per chunk
 * followed by the [DONE] sentinel.
 */
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const lines = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  lines.push('data: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    }
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body
  } as unknown as Response;
}

describe('LLM orchestration — append (normal send: user/director at the end + full history)', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  const CHAT_ID = 'chat-1';
  const Q_ID = 'q-last';

  async function setup(): Promise<{ runner: LlmUseCaseRunner; post: LlmPostprocessorService; chatService: ChatService }> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    const now = new Date().toISOString();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' },
        { id: 'm-2', displayName: 'Beta', modelId: 'beta/model' }
      ]
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story', created_at: now, updated_at: now }));
    api.nodes = [
      makeNode({ id: 'n1', chatId: CHAT_ID, parentId: null, role: 'user', content: 'Opening direction.', isCurrent: true }),
      makeNode({ id: 'a1', chatId: CHAT_ID, parentId: 'n1', role: 'assistant', content: 'The first chapter.', isCurrent: true }),
      makeNode({ id: Q_ID, chatId: CHAT_ID, parentId: 'a1', role: 'user', content: '', isCurrent: true, modelId: 'alpha/model' })
    ];
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const chatService = TestBed.inject(ChatService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    return {
      runner: TestBed.inject(LlmUseCaseRunner),
      post: TestBed.inject(LlmPostprocessorService),
      chatService
    };
  }

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('streams the answer with full history as context, then appends an assistant node', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['The ', 'night ', 'train ', 'arrives.']));
    const { runner, post, chatService } = await setup();

    const runOpts = { onChunk: vi.fn() };
    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === Q_ID)!,
      usecase: 'append',
      vars: { content: 'Mara boards the train.' }
    }, runOpts);

    // ONE completion streamed to completion.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // FULL history forwarded as normal messages: opening + chapter + the final user text.
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toBe('Opening direction.');
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].content).toBe('The first chapter.');
    // The final message is the composer draft (contentOverride), not ''.
    expect(body.messages[2]).toEqual({ role: 'user', content: 'Mara boards the train.' });

    // Streaming: chunks were folded; onChunk fired while partial.
    expect(slots.text?.status).toBe('ok');
    expect(slots.text?.value).toBe('The night train arrives.');
    expect(runOpts.onChunk).toHaveBeenCalled();

    // Place the answer: persist draft + create assistant node under the director.
    const plan = post.planAppend(slots, {
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === Q_ID)!,
      usecase: 'append',
      vars: {}
    }, { modelId: 'alpha/model', providerId: 'prov-1' });
    expect(plan.empty).toBe(false);
    const answer = await post.applyAppend(plan, {
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === Q_ID)!,
      usecase: 'append',
      vars: {}
    }, 'Mara boards the train.');

    expect(answer.role).toBe('assistant');
    expect(answer.content).toBe('The night train arrives.');
    expect(answer.parentId).toBe(Q_ID);
    // The question was persisted with the draft + the answer is the active child.
    expect(chatService.nodes().find(n => n.id === Q_ID)?.content).toBe('Mara boards the train.');
    expect(chatService.getActiveChild(Q_ID)?.id).toBe(answer.id);
  });

  it('uses the saved node content when no draft override is given', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['A ', 'quiet ', 'chapter.']));
    const { runner, chatService } = await setup();
    // Set a saved content on the final director node.
    const node = chatService.nodes().find(n => n.id === Q_ID)!;
    await chatService.patchNode(CHAT_ID, Q_ID, { content: 'Saved direction text.' });

    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === Q_ID)!,
      usecase: 'append',
      vars: {} // no content override
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(last).toEqual({ role: 'user', content: 'Saved direction text.' });
    expect(slots.text?.value).toBe('A quiet chapter.');
  });

  it('surfaces an empty stream as empty (no fragment), never throws', async () => {
    // Streaming response with an empty content delta → nothing assembled.
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '' } }] })}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body
    } as unknown as Response);

    const { runner, post, chatService } = await setup();
    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === Q_ID)!,
      usecase: 'append',
      vars: { content: 'Mara boards the train.' }
    });
    // Nothing was generated → text slot is refused (never throws).
    expect(slots.text?.status).toBe('refused');
    // planAppend surfaces empty so the caller can inform the user.
    const plan = post.planAppend(slots, {
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === Q_ID)!,
      usecase: 'append',
      vars: {}
    }, { modelId: 'alpha/model', providerId: 'prov-1' });
    expect(plan.empty).toBe(true);
  });
});