import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { LlmService } from './llm.service';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { ChatMessage, ChatNode } from '../../models/chat';
import { ModelEntry } from '../../models/chat-config';
import { ResolvedChatParameters } from '../../models/chat-parameters';

/**
 * Focused unit tests for LlmService.generateImage's one-shot storyboard mode.
 *
 * The service talks to the LLM through `fetch` (the /chat/completions proxy),
 * so we stub `global.fetch` and spy on `resolveForCurrentChat` / `toLlmExtras`
 * to keep the whole test hermetic (no real chat/project/topic state needed).
 */

const MODEL: ModelEntry = {
  id: 'img-1',
  displayName: 'Image model',
  modelId: 'openai/gpt-image-1',
  providerId: 'prov-1',
  type: 'fetched',
  enabled: true,
  architecture: { input_modalities: [], output_modalities: ['image'] }
};

const RESOLVED: ResolvedChatParameters = {
  source: 'default',
  temperature: null,
  topK: null,
  topM: null,
  stream: false,
  thinking: false,
  thinkingLevel: 'none',
  layers: []
};

/** A chat-completions response carrying `imageCount` image parts in one choice. */
function completionResponse(imageCount: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: Array.from({ length: imageCount }).map((_, i) => ({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,IMG${i}` }
          }))
        }
      }]
    })
  } as unknown as Response;
}

describe('LlmService.generateImage — one-shot storyboard (singleCall)', () => {
  let service: LlmService;
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: InMemoryChatApi;

  beforeEach(async () => {
    api = new InMemoryChatApi();
    TestBed.resetTestingModule();
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    service = TestBed.inject(LlmService);
    vi.spyOn(service, 'resolveForCurrentChat').mockResolvedValue(RESOLVED);
    vi.spyOn(service, 'toLlmExtras').mockReturnValue({ stream: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the whole storyboard in ONE completion when the model returns every image', async () => {
    // The model returns all 3 images in a single response.
    fetchMock.mockResolvedValueOnce(completionResponse(3));

    const result = await service.generateImage(
      { baseUrl: 'https://provider', apiKey: 'sk-test' },
      MODEL,
      [user('First'), user('Second')],
      undefined,
      {
        count: 3,
        storyboardPrompt: 'hide behind bystanders',
        singleCall: true
      }
    );

    // Exactly ONE network call happened — the whole storyboard in one go.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // All three images came back.
    expect(result.images).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(result.images[i].url).toBe(`data:image/png;base64,IMG${i}`);
    }
    // Recorded as a single scene (one prompt file + illustration-1..N).
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].refused).toBe(false);
    expect(result.scenes[0].prompt).toContain('Storyboard one-shot');
    expect(result.scenes[0].prompt).toContain('create EXACTLY 3 pictures');
    // The storyboard rules are folded into the one-shot prompt.
    expect(result.scenes[0].prompt).toContain('hide behind bystanders');
  });

  it('falls back to per-scene calls when the model returns fewer images than requested', async () => {
    // Every call (the one-shot attempt AND each per-scene call) returns 1 image.
    fetchMock.mockResolvedValue(completionResponse(1));

    const result = await service.generateImage(
      { baseUrl: 'https://provider', apiKey: 'sk-test' },
      MODEL,
      [user('First'), user('Second')],
      undefined,
      { count: 3, singleCall: true }
    );

    // 1 (discarded one-shot) + 3 per-scene = 4 network calls.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The per-scene fallback collected one image per scene.
    expect(result.images).toHaveLength(3);
    expect(result.scenes).toHaveLength(3);
    expect(result.scenes.every(s => !s.refused)).toBe(true);
  });

  it('does not attempt a one-shot batch for a single picture', async () => {
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    const result = await service.generateImage(
      { baseUrl: 'https://provider', apiKey: 'sk-test' },
      MODEL,
      [user('Solo')],
      undefined,
      { count: 1, singleCall: true }
    );

    // singleCall is only meaningful for count > 1 → a single ordinary call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.images).toHaveLength(1);
  });
});

function user(text: string): ChatMessage {
  return { role: 'user', content: text };
}