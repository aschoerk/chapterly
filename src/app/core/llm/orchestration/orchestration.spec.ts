import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeModel, makeProvider, makeAttachment } from '../../../../../test-helpers/factories';
import { SettingsService } from '../../settings.service';
import { GenerationSettingsService } from '../../generation-settings.service';
import { ChatService } from '../../chat.service';

import {
  evaluateCompletion,
  evaluateImagesResponse,
  evaluateDescriptions,
  foldStreamChunk,
  finalizeStream,
  isContentModeration,
  moderationReason
} from './evaluators';
import { pickUsecase, LlmUseCaseRunner } from './usecases';
import { LlmOrchestratorService } from './orchestrator';
import { LlmTransportService } from './transport';
import { LlmPostprocessorService } from './postprocessor';
import type { EvalSlots, UsecaseVars } from './types';
import { I18nService } from '../../i18n/i18n.service';

describe('LLM orchestration — evaluators (pure, never throw)', () => {
  it('evaluates a success completion into text + thinking slots', () => {
    const slots = evaluateCompletion({
      raw: {
        choices: [{ message: { role: 'assistant', content: 'Hello world', reasoning: 'think…' } }]
      }
    });
    expect(slots.text?.status).toBe('ok');
    expect(slots.text?.value).toBe('Hello world');
    expect(slots.thinking?.value).toBe('think…');
  });

  it('evaluates an image completion into an images slot', () => {
    const slots = evaluateCompletion({
      raw: {
        choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] } }]
      }
    });
    expect(slots.images?.status).toBe('ok');
    expect(slots.images?.value).toHaveLength(1);
  });

  it('marks an empty/refused completion as refused (never throws)', () => {
    const slots = evaluateCompletion({ raw: { choices: [{ message: { refusal: 'I cannot do that' } }] } });
    expect(slots.images?.status).toBe('refused');
  });

  it('turns a transport error into a refused slot for moderation', () => {
    const err = { status: 400, text: '{"error":{"message":"Content policy violation"}}' };
    const slots = evaluateImagesResponse({ error: err });
    expect(slots.images?.status).toBe('refused');
  });

  it('turns a timeout/abort into an error slot with reason (never throws)', () => {
    const slots = evaluateCompletion({ error: { status: 0, text: '' }, aborted: true });
    expect(slots.error?.status).toBe('error');
    expect(slots.error?.value).toBe('aborted');
  });

  it('evaluates the planning pass into descriptions', () => {
    const slots = evaluateDescriptions({
      raw: { choices: [{ message: { content: '{"pictures":["A castle at dawn.","A rider in the mist."]}' } }] }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('castle');
  });

  it('splits a DOUBLE-ENCODED JSON list from the planning model', () => {
    // Some models escape the array into a STRING value instead of a real array:
    // {"pictures": "[\"desc 1\",\"desc 2\"]"}
    const inner = JSON.stringify(['A castle at dawn.', 'A rider in the mist.']);
    const slots = evaluateDescriptions({
      raw: { choices: [{ message: { content: JSON.stringify({ pictures: inner }) } }] }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('castle');
    expect(slots.descriptions?.value?.[1].text).toContain('rider');
  });

  it('splits a bare JSON array when the model drops the wrapper object', () => {
    const slots = evaluateDescriptions({
      raw: { choices: [{ message: { content: JSON.stringify(['A bridge.', 'A lantern.']) } }] }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('bridge');
  });

  it('splits a JSON object embedded in surrounding prose and keeps brackets inside descriptions intact', () => {
    const json = JSON.stringify({
      pictures: ['A sign reading "[EXIT]" above the door.', 'A lantern at dusk.']
    });
    const content = `Sure, here are the frozen frames:\n${json}\nEnjoy!`;
    const slots = evaluateDescriptions({
      raw: { choices: [{ message: { content } }] }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('[EXIT]');
    expect(slots.descriptions?.value?.[1].text).toContain('lantern');
  });

  it('splits a map keyed 0..n from the planning model', () => {
    const slots = evaluateDescriptions({
      raw: {
        choices: [{
          message: {
            content: JSON.stringify({ pictures: { '0': 'First frame.', '1': 'Second frame.' } })
          }
        }]
      }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('First frame');
    expect(slots.descriptions?.value?.[1].text).toContain('Second frame');
  });

  it('returns refused descriptions when planning output is unusable', () => {
    const slots = evaluateDescriptions({ raw: { choices: [{ message: { content: '' } }] } });
    expect(slots.descriptions?.status).toBe('refused');
  });

  it('detects content moderation across provider shapes', () => {
    expect(isContentModeration('Request Moderated')).toBe(true);
    expect(moderationReason('{"error":{"message":"Content policy violation"}}')).toContain('Content');
    expect(isContentModeration('transport failure 500')).toBe(false);
  });

  describe('streaming fold + finalize (SSE reaches the node DURING)', () => {
    it('folds chunks into a partial text slot', () => {
      let running = foldStreamChunk({}, { content: 'The' });
      running = foldStreamChunk(running, { content: ' castle' });
      running = foldStreamChunk(running, { thinking: 'hmm' });
      expect(running.text?.status).toBe('partial');
      expect(running.text?.value).toBe('The castle');
      expect(running.thinking?.value).toBe('hmm');
    });

    it('finalizes a partial stream into ok on success', () => {
      const running = foldStreamChunk({}, { content: 'The answer' });
      const done = finalizeStream(running, { raw: { choices: [{ message: { role: 'assistant', content: 'The answer' } }] } });
      expect(done.text?.status).toBe('ok');
      expect(done.text?.value).toBe('The answer');
    });

    it('finalizes an aborted stream into an error slot, preserving the partial', () => {
      const running = foldStreamChunk({}, { content: 'Half' });
      const done = finalizeStream(running, { error: { status: 0, text: '' }, aborted: true });
      expect(done.error?.status).toBe('error');
      expect(done.error?.value).toBe('aborted');
      expect(done.text?.value).toBe('Half'); // partial data is never lost
    });
  });
});

describe('LLM orchestration — dispatch (plain if-chain)', () => {
  it('maps dialog vars to the 5 use cases', () => {
    const v = (o: UsecaseVars) => o;
    expect(pickUsecase(v({ count: 3, planDescriptions: false }))).toBe('storyboard-direct');
    expect(pickUsecase(v({ count: 3, planDescriptions: true, singleCall: true }))).toBe('planned-enblock');
    expect(pickUsecase(v({ count: 3, purePictures: true }))).toBe('planned-enblock');
    expect(pickUsecase(v({ count: 3, planDescriptions: true }))).toBe('planned-scenes');
    expect(pickUsecase(v({ count: 1, historyMode: 'full' }))).toBe('render-full');
    expect(pickUsecase(v({ count: 1 }))).toBe('render-node');
  });
});

describe('LLM orchestration — transport fallbacks (the retries stay in transport)', () => {
  let transport: LlmTransportService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
    void TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient()]
    });
    transport = TestBed.inject(LlmTransportService);
  });

  afterEach(() => vi.unstubAllGlobals());

  function imagesResponse(count: number): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: Array.from({ length: count }).map((_, i) => ({
          b64_json: `AAA${i}`, media_type: 'image/png'
        }))
      })
    } as unknown as Response;
  }

  function errorResponse(status: number, message: string): Response {
    return {
      ok: false,
      status,
      text: async () => message
    } as unknown as Response;
  }

  const model = makeModel({ architecture: { input_modalities: [], output_modalities: ['image'] } });
  const provider = makeProvider();

  it('routes an image-only model (404 Qwen hint) to /images', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(
      404,
      '{"error":{"message":"qwen/qwen-image-3 is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.","code":404}}'
    ));
    fetchMock.mockResolvedValueOnce(imagesResponse(1));

    const raw = await transport.completeImage({
      provider, model,
      messages: [{ role: 'user', content: 'Draw a castle' }]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chat/completions');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/images');
    expect((raw as { data: unknown[] }).data).toHaveLength(1);
  });

  it('falls back to /images on a context-overflow error', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(
      400,
      '{"error":{"message":"This endpoint\'s maximum context length is 65536 tokens. However, you requested about 78089 tokens…"}}'
    ));
    fetchMock.mockResolvedValueOnce(imagesResponse(1));
    const raw = await transport.completeImage({
      provider, model,
      messages: [{ role: 'user', content: 'Draw a castle at dusk' }]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((raw as { data: unknown[] }).data).toHaveLength(1);
  });

  it('retries once without the modalities field when it is rejected', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, '{"error":{"message":"Unsupported parameter: modalities"}}'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] } }] })
    } as unknown as Response);
    const raw = await transport.completeImage({ provider, model, messages: [{ role: 'user', content: 'x' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((raw as { choices: unknown[] }).choices).toHaveLength(1);
  });
});

describe('LLM orchestration — planned-scenes pipeline (use case 3)', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'img', displayName: 'Image', modelId: 'vendor/image', architecture: { input_modalities: [], output_modalities: ['image'] } },
        { id: 'txt', displayName: 'Texter', modelId: 'vendor/text' }
      ]
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
  });

  afterEach(() => vi.unstubAllGlobals());

  function textResponse(text: string): Response {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: text } }] }) } as unknown as Response;
  }
  function completionImage(n: number): Response {
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { images: Array.from({ length: n }).map((_, i) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,IMG${i}` } })) } }] })
    } as unknown as Response;
  }

  it('plans then renders each scene, collecting every image into storyboard', async () => {
    // 1 planning + 2 render calls.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern."]}'));
    fetchMock.mockResolvedValueOnce(completionImage(1));
    fetchMock.mockResolvedValueOnce(completionImage(1));

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
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 2 }
    });

    // 3 network calls total: 1 planning + 2 scenes.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard).toHaveLength(2);
    expect(slots.images?.value).toHaveLength(2);
    // Every scene prompt starts with the drawing instruction (anchor base).
    for (const scene of storyboard) {
      expect(scene.prompt).toContain('Illustrate this beat');
    }
    // The exact description drove scene 2.
    expect(storyboard[1].prompt).toContain('lantern');

    // Postprocess → placement plan with prompt files.
    const post = TestBed.inject(LlmPostprocessorService);
    const plan = post.plan(slots, { chat: { id: 'chat-1' } as never, node: makeNode({ id: aid, role: 'assistant' }) as never, usecase: 'planned-scenes', vars: {} });
    expect(plan).not.toBeNull();
    expect(plan?.attachments.some(a => a.name.startsWith('illustration-'))).toBe(true);
    expect(plan?.attachments.some(a => a.name === 'prompt-2.txt')).toBe(true);
  });

  it('uses the SCENE-oriented planning prompt for planned-scenes (fewer stills, more scenes)', async () => {
    // 1 planning + 2 render calls.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern."]}'));
    fetchMock.mockResolvedValueOnce(completionImage(1));
    fetchMock.mockResolvedValueOnce(completionImage(1));

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
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 2 }
    });

    // First fetch = the planning call: body carries the SCENE-oriented prompt
    // (image.planning-scenes), not the static-still template (image.planning).
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: string }[];
    };
    // The plan prompt is the LAST user message (the earlier ones are context).
    const user = [...body.messages].reverse().find(m => m.role === 'user')!.content;
    expect(user).toContain('CONCRETE SCENES');
    expect(user).toMatch(/feel ALIVE/);
    expect(user).not.toContain('frozen instant');
  });

  it('does NOT forward reference attachments to the image model after planning', async () => {
    // The render model can also READ images — prior illustrations exist along
    // the path, but the post-planning render must still drive the image model
    // from the derived descriptions ONLY (no image_url parts / binaries).
    api.models = [
      makeModel({
        id: 'img', displayName: 'Image', modelId: 'vendor/image',
        architecture: { input_modalities: ['image'], output_modalities: ['image'] }
      }),
      makeModel({ id: 'txt', displayName: 'Texter', modelId: 'vendor/text' })
    ];
    // 1 planning + 2 render calls.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern."]}'));
    fetchMock.mockResolvedValueOnce(completionImage(1));
    fetchMock.mockResolvedValueOnce(completionImage(1));

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
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const now = new Date().toISOString();
    const priorImage = makeAttachment({
      id: 'img0', name: 'illustration-0.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,REFIMAGE'
    });
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Prior direction.' }),
      makeNode({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', content: 'Prior chapter.', attachments: [priorImage] as never }),
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', content: 'A direction.' }),
      makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'u0');
    chatService.setActiveChild('u0', 'a0');
    chatService.setActiveChild('a0', 'u1');
    chatService.setActiveChild('u1', 'a1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now },
      node: makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 2 }
    });

    // 3 network calls: 1 planning + 2 scene renders.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const i of [1, 2]) {
      const body = JSON.parse((fetchMock.mock.calls[i][1] as { body: string }).body) as {
        messages: { role: string; content: unknown }[];
      };
      const user = body.messages.find(m => m.role === 'user')!;
      // The render prompt is a PLAIN string — no image_url parts, no binaries.
      expect(typeof user.content).toBe('string');
      expect(JSON.stringify(body.messages)).not.toContain('image_url');
      expect(JSON.stringify(body.messages)).not.toContain('REFIMAGE');
    }
  });

  it('storyboard-direct does NOT send attachments to the image model either', async () => {
    // The render model can also READ images and the path already contains an
    // illustration attachment — but storyboard-direct must send TEXT only
    // (chat text + the one-shot prompt), never the binaries / references.
    api.models = [
      makeModel({
        id: 'img', displayName: 'Image', modelId: 'vendor/image',
        architecture: { input_modalities: ['image'], output_modalities: ['image'] }
      }),
      makeModel({ id: 'txt', displayName: 'Texter', modelId: 'vendor/text' })
    ];
    fetchMock.mockResolvedValueOnce(completionImage(2)); // the one storyboard render

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
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const now = new Date().toISOString();
    const priorImage = makeAttachment({
      id: 'img0', name: 'illustration-0.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,REFIMAGE'
    });
    const handImage = makeAttachment({
      id: 'hand', name: 'memo.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,HANDIMAGE'
    });
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 5, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Prior direction.' }),
      makeNode({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', content: 'Prior chapter.', attachments: [priorImage] as never }),
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', content: 'A direction with a picture.', attachments: [handImage] as never }),
      makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'u0');
    chatService.setActiveChild('u0', 'a0');
    chatService.setActiveChild('a0', 'u1');
    chatService.setActiveChild('u1', 'a1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 5, created_at: now, updated_at: now },
      node: makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'storyboard-direct',
      vars: { count: 2, planDescriptions: false }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // no planning, one render
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    const serialized = JSON.stringify(body.messages);
    // The chat's TEXT context is still there, but NO images reach the model.
    for (const m of body.messages) {
      expect(typeof m.content).toBe('string');
    }
    expect(serialized).toContain('A direction with a picture'); // text context kept
    expect(serialized).not.toContain('image_url');
    expect(serialized).not.toContain('REFIMAGE');
    expect(serialized).not.toContain('HANDIMAGE');
  });

  it('render-full does NOT send attachments to the image model either', async () => {
    // Full-chat context: the render model can read images and the path carries
    // both a prior illustration and a hand-attached image — but render-full
    // must forward the chat TEXT only (context + anchor), never binaries.
    api.models = [
      makeModel({
        id: 'img', displayName: 'Image', modelId: 'vendor/image',
        architecture: { input_modalities: ['image'], output_modalities: ['image'] }
      }),
      makeModel({ id: 'txt', displayName: 'Texter', modelId: 'vendor/text' })
    ];
    fetchMock.mockResolvedValueOnce(completionImage(1)); // the single render

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
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const now = new Date().toISOString();
    const priorImage = makeAttachment({
      id: 'img0', name: 'illustration-0.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,REFIMAGE'
    });
    const handImage = makeAttachment({
      id: 'hand', name: 'memo.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,HANDIMAGE'
    });
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Prior direction.' }),
      makeNode({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', content: 'Prior chapter.', attachments: [priorImage] as never }),
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', content: 'A direction with a picture.', attachments: [handImage] as never }),
      makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'u0');
    chatService.setActiveChild('u0', 'a0');
    chatService.setActiveChild('a0', 'u1');
    chatService.setActiveChild('u1', 'a1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now },
      node: makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'render-full',
      vars: { count: 1, historyMode: 'full' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    const serialized = JSON.stringify(body.messages);
    // The chat's TEXT context survives, but no image payload reaches the model.
    for (const m of body.messages) {
      expect(typeof m.content).toBe('string');
    }
    expect(serialized).toContain('A direction with a picture'); // text context kept
    expect(serialized).toContain('A chapter.'); // the anchor
    expect(serialized).not.toContain('image_url');
    expect(serialized).not.toContain('REFIMAGE');
    expect(serialized).not.toContain('HANDIMAGE');
  });

  it('render-node does NOT send attachments to the image model either', async () => {
    // Current-node only, but the render model can read images and the path
    // carries an illustration + a hand-attached image — the render must still
    // send ONLY the anchor text prompt (no reference/attachment images).
    api.models = [
      makeModel({
        id: 'img', displayName: 'Image', modelId: 'vendor/image',
        architecture: { input_modalities: ['image'], output_modalities: ['image'] }
      }),
      makeModel({ id: 'txt', displayName: 'Texter', modelId: 'vendor/text' })
    ];
    fetchMock.mockResolvedValueOnce(completionImage(1)); // the single render

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
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const now = new Date().toISOString();
    const priorImage = makeAttachment({
      id: 'img0', name: 'illustration-0.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,REFIMAGE'
    });
    const handImage = makeAttachment({
      id: 'hand', name: 'memo.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,HANDIMAGE'
    });
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Prior direction.' }),
      makeNode({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', content: 'Prior chapter.', attachments: [priorImage] as never }),
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', content: 'A direction with a picture.', attachments: [handImage] as never }),
      makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'u0');
    chatService.setActiveChild('u0', 'a0');
    chatService.setActiveChild('a0', 'u1');
    chatService.setActiveChild('u1', 'a1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now },
      node: makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'render-node',
      vars: { count: 1 }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    const serialized = JSON.stringify(body.messages);
    for (const m of body.messages) {
      expect(typeof m.content).toBe('string');
    }
    expect(serialized).toContain('A chapter.'); // the anchor prompt text
    expect(serialized).not.toContain('image_url');
    expect(serialized).not.toContain('REFIMAGE');
    expect(serialized).not.toContain('HANDIMAGE');
  });

  it('keeps previously collected images when one scene is refused (partial survival)', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern."]}'));
    fetchMock.mockResolvedValueOnce(completionImage(1));
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'I cannot draw that' } }] }) } as unknown as Response
    );

    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), { provide: CHAT_API, useValue: api }]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 2 }
    });

    // Scene 1 collected, scene 2 refused → 1 image survives.
    expect(slots.images?.value).toHaveLength(1);
    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard[0].refused).toBe(false);
    expect(storyboard[1].refused).toBe(true);
    // The refused prompt stays findable via the postprocessor.
    const post = TestBed.inject(LlmPostprocessorService);
    const plan = post.plan(slots, { chat: { id: 'chat-1' } as never, node: makeNode({ id: aid, role: 'assistant' }) as never, usecase: 'planned-scenes', vars: {} });
    expect(plan?.attachments.some(a => a.name === 'refused-prompt-2.txt')).toBe(true);
    expect(plan?.summary.partial).toBe(true);
  });
});

describe('LLM orchestration — image-generation (explicit single picture)', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'img', displayName: 'Image', modelId: 'vendor/image', architecture: { input_modalities: [], output_modalities: ['image'] } }
      ]
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('renders ONE picture from vars.promptText, no storytelling planning', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,IMG0' } }] } }] })
    } as unknown as Response);

    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), { provide: CHAT_API, useValue: api }]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'Raw direction full of prose.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'Chapter full of prose.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'Chapter full of prose.', isCurrent: true }),
      usecase: 'image-generation',
      vars: { promptText: 'Assistant:\nA softer scene, lit by torchlight', count: 1 }
    });

    // Exactly one image-generation call — no planning pass.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard).toHaveLength(1);
    expect(slots.images?.value).toHaveLength(1);
    // The scene = drawing instruction + the EXPLICIT promptText (the node's
    // saved content must NOT leak into the scene).
    const prompt = storyboard[0].prompt;
    expect(prompt).toContain('Illustrate this beat');
    expect(prompt).toContain('A softer scene, lit by torchlight');
    expect(prompt).not.toContain('Chapter full of prose');
    expect(storyboard[0].refused).toBe(false);

    // Postprocess → illustration-1 + prompt-1 records.
    const post = TestBed.inject(LlmPostprocessorService);
    const plan = post.plan(slots, { chat: { id: 'chat-1' } as never, node: makeNode({ id: aid, role: 'assistant' }) as never, usecase: 'image-generation', vars: {} });
    expect(plan).not.toBeNull();
    expect(plan?.attachments.some(a => a.name === 'illustration-1.png')).toBe(true);
    expect(plan?.attachments.some(a => a.name === 'prompt-1.txt')).toBe(true);
  });
});

describe('LLM orchestration — orchestrator does not throw (error → slots)', () => {
  let orch: LlmOrchestratorService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('turns a network failure into refused image slots', async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient()]
    }).compileComponents();
    orch = TestBed.inject(LlmOrchestratorService);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' } as unknown as Response);

    const model = makeModel({ architecture: { input_modalities: [], output_modalities: ['image'] } });
    const provider = makeProvider();
    const slots = await orch.completeImage(
      { chat: { id: 'c', title: 't' } as never },
      { model, provider, messages: [{ role: 'user', content: 'x' }] },
      { expect: 'images' }
    );
    expect(slots.images?.status).toBe('refused');
    expect((slots.images as unknown as { reason?: string }).reason).toContain('boom');
  });
});