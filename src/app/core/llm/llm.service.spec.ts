import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { LlmService } from './llm.service';
import { LlmLogService } from './llm-log.service';
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

/** An error response carrying an OpenRouter-style JSON error message. */
function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    text: async () => message
  } as unknown as Response;
}

/** An OpenAI-Images-shaped success (data[] with b64_json), returned by `/images`. */
function imagesResponse(imageCount: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      created: 1730000000,
      data: Array.from({ length: imageCount }).map((_, i) => ({
        b64_json: `AAAA${i}`,
        media_type: 'image/png'
      })),
      usage: { prompt_tokens: 0, completion_tokens: 100, total_tokens: 100, cost: 0.02 }
    })
  } as unknown as Response;
}

/** A chat-completions response whose message content is a plain string. */
function textResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: text } }]
    })
  } as unknown as Response;
}

/** The last user-message content of the request body at fetch call `index`. */
function lastUserMessage(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const body = JSON.parse(fetchMock.mock.calls[index][1].body);
  const messages = body.messages as any[];
  return messages[messages.length - 1].content;
}

/** The JSON body of the most recent fetch call (the /chat/completions proxy). */
function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return JSON.parse(call[1].body);
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

  it('requests only the image modality for image-only models (no text)', async () => {
    // MODEL declares output_modalities: ['image'] — like x-ai/grok-imagine
    // image models fetched from OpenRouter's Image API catalog. Requesting
    // ['text','image'] would make OpenRouter's route filter return 404.
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('Draw a castle')],
      undefined,
      { count: 1 }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastRequestBody(fetchMock).modalities).toEqual(['image']);
  });

  it('retries with image-only modalities when OpenRouter rejects text+image', async () => {
    const mixed: ModelEntry = {
      ...MODEL,
      modelId: 'vendor/mixed-model',
      architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] }
    };
    // OpenRouter 404: the model's endpoints only serve image, so text+image
    // matches no route. The second call (image-only) succeeds.
    fetchMock.mockResolvedValueOnce(errorResponse(
      404,
      '{"error":{"message":"No endpoints found that support the requested output modalities: text, image","code":404,"metadata":{"failed_routing_step":"Filter by Model Output Modalities"}}}'
    ));
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      mixed,
      [user('Draw a castle')],
      undefined,
      { count: 1 }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).modalities).toEqual(['text', 'image']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).modalities).toEqual(['image']);
    expect(result.images).toHaveLength(1);
  });

  it('treats a content-moderated 400 as a refused scene (single picture)', async () => {
    // OpenRouter wraps xAI's imagine:content-moderated in a 400
    // "Provider returned error"; the real reason lives in error.metadata.raw.
    fetchMock.mockResolvedValueOnce(errorResponse(400, MODERATED_ERROR));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('A violent scene')],
      undefined,
      { count: 1 }
    );

    // Not a hard error — a refused scene whose content carries the reason.
    expect(result.images).toHaveLength(0);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].refused).toBe(true);
    expect(result.scenes[0].content).toContain('Generated image rejected by content moderation');
    // Only one attempt — no pointless retry/fallback for a moderation hit.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks every storyboard scene refused when the one-shot call is moderated', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, MODERATED_ERROR));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('A violent scene')],
      undefined,
      { count: 3, singleCall: true }
    );

    // The per-scene fallback would be moderated too — so all 3 scenes come
    // back refused (prompts preserved) instead of re-calling the API.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.images).toHaveLength(0);
    expect(result.scenes).toHaveLength(3);
    expect(result.scenes.every(s => s.refused)).toBe(true);
    expect(result.scenes[0].content).toContain('Generated image rejected by content moderation');
  });

  it('falls back to the /images endpoint for models that reject chat/completions', async () => {
    // OpenRouter serves qwen-image-3 ONLY via /images — chat/completions
    // answers 404 pointing at that endpoint.
    fetchMock.mockResolvedValueOnce(errorResponse(
      404,
      '{"error":{"message":"qwen/qwen-image-3 is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.","code":404},"user_id":"u1"}'
    ));
    fetchMock.mockResolvedValueOnce(imagesResponse(1));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('Draw a castle')],
      undefined,
      { count: 1 }
    );

    // First call = chat/completions (404), second = the images endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = fetchMock.mock.calls[0][0] as string;
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(firstUrl).toContain('/chat/completions');
    expect(secondUrl).toContain('/images');
    // The images call carries the OpenAI-Images body: model + prompt (no n).
    const imagesBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(imagesBody.model).toBe(MODEL.modelId);
    expect(imagesBody.prompt).toBe('Draw a castle');
    expect(imagesBody.n).toBeUndefined();
    // The OpenAI-Images data[].b64_json shape is parsed into the image.
    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toBe('data:image/png;base64,AAAA0');
    expect(result.scenes[0].refused).toBe(false);
  });

  it('turns an /images fallback failure into a REFUSED scene instead of losing the illustrate', async () => {
    // chat/completions says "use /images", but /images also fails. This is a
    // plain transport failure — it must NOT throw and lose the illustrate: it
    // is surfaced as a refused scene whose prompt stays re-renderable.
    fetchMock.mockResolvedValueOnce(errorResponse(
      404,
      '{"error":{"message":"qwen/qwen-image-3 cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.","code":404}}'
    ));
    fetchMock.mockResolvedValueOnce(errorResponse(503, 'upstream down'));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('Draw a castle')],
      undefined,
      { count: 1 }
    );

    // No rejection: one failed attempt = one refused scene (prompt preserved).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.images).toHaveLength(0);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].refused).toBe(true);
    expect(result.scenes[0].content).toContain('Image generation failed: 503');
    expect(result.scenes[0].prompt).toContain('Draw a castle');
  });

  it('sends ONLY the prepared prompt to the image model, never the story history', async () => {
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    const HISTORY = 'H-' + 'x'.repeat(200); // pretend a huge earlier chapter
    await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user(HISTORY), user('Draw a castle')],
      undefined,
      { count: 1 }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const renderBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(renderBody.messages).toHaveLength(1);
    expect(renderBody.messages[0].content).toBe('Draw a castle');
    // The prior chapter never reaches the image model.
    expect(JSON.stringify(renderBody)).not.toContain(HISTORY);
  });

  it('falls back to the /images endpoint when an image model runs out of context', async () => {
    // chat/completions is rejected because the request exceeds the model's
    // context window; the same prepared prompt must be retried via /images
    // instead of stopping the illustration.
    fetchMock.mockResolvedValueOnce(errorResponse(
      400,
      '{"error":{"message":"This endpoint\'s maximum context length is 65536 tokens. However, you requested about 78089 tokens (78089 of text input). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.","code":400,"metadata":{"provider_name":null}}}'
    ));
    fetchMock.mockResolvedValueOnce(imagesResponse(1));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('Draw a castle at dusk')],
      undefined,
      { count: 1 }
    );

    // First = chat/completions (400 context overflow), second = /images.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = fetchMock.mock.calls[0][0] as string;
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(firstUrl).toContain('/chat/completions');
    expect(secondUrl).toContain('/images');
    const imagesBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(imagesBody.prompt).toBe('Draw a castle at dusk');
    expect(result.images).toHaveLength(1);
    expect(result.scenes[0].refused).toBe(false);
  });

  it('drives a single picture from a derived scene description, not the raw assistant text', async () => {
    // Planning answers with ONE concrete description; the render returns one image.
    fetchMock.mockResolvedValueOnce(textResponse(
      '{"pictures":["A knight on horseback at dawn in a misty field."]}'
    ));
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    const CHAPTER = 'The castle loomed over the valley. Long paragraphs of prose that are the whole assistant chapter, repeated verbatim. The wind howled through the towers.';
    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user(CHAPTER)],
      undefined,
      {
        count: 1,
        planDescriptions: true,
        sceneInstruction: 'Illustrate this beat of the story.'
      }
    );

    // The recorded prompt is the instruction + the derived description —
    // it must NOT be the whole chapter text.
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].prompt).toContain('Illustrate this beat of the story.');
    expect(result.scenes[0].prompt).toContain('A knight on horseback at dawn in a misty field.');
    expect(result.scenes[0].prompt).not.toContain('The castle loomed over the valley');
    expect(result.scenes[0].prompt).not.toContain('verbatim');
    // And the actual render call (fetch call #1) received that description as
    // its final cue, not the chapter.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lastUser = String(lastUserMessage(fetchMock, 1));
    expect(lastUser).toContain('A knight on horseback at dawn in a misty field.');
    expect(lastUser).not.toContain('The castle loomed over the valley');
    expect(result.images).toHaveLength(1);
  });

  it('still renders single pictures from the anchor when no scene is derived', async () => {
    // Planning returns empty (nothing usable) → falls back to the anchor text.
    fetchMock.mockResolvedValueOnce(textResponse(''));
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('Draw a castle')],
      undefined,
      { count: 1, planDescriptions: true, sceneInstruction: 'Illustrate this.' }
    );

    expect(result.images).toHaveLength(1);
    expect(result.scenes[0].prompt).toContain('Draw a castle');
  });

  it('pure picture mode sends ONLY derived descriptions en-block (no raw prose)', async () => {
    // Planner returns two pure, temporal-free descriptions.
    fetchMock.mockResolvedValueOnce(textResponse(
      '{"pictures":["A lone rider on a dune at dusk.","An abandoned desert inn under moonlight."]}'
    ));
    // The image model returns both pictures in ONE en-block response.
    fetchMock.mockResolvedValueOnce(completionResponse(2));

    const CHAPTER = 'She had waited years to close the deal. The raw story prose contains intense, potentially sensitive dialogue and plot.';
    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user(CHAPTER)],
      undefined,
      {
        count: 2,
        planDescriptions: true,
        purePictures: true,
        sceneInstruction: 'Illustrate this beat of the story.'
      }
    );

    // ONE en-block network call (planning) + ONE render call = 2 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The render call body: the pure en-block prompt with descriptions and
    // consistency rules — and NONE of the raw story prose.
    const renderBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    const renderPrompt = String(renderBody.messages[renderBody.messages.length - 1].content);
    expect(renderPrompt).toContain('A lone rider on a dune at dusk.');
    expect(renderPrompt).toContain('An abandoned desert inn under moonlight.');
    expect(renderPrompt).toContain('ALL 2 pictures in ONE single response');
    expect(renderPrompt).toContain('Keep the SAME characters');
    expect(renderPrompt).not.toContain('waited years to close the deal');
    expect(renderPrompt).not.toContain('sensitive dialogue');
    // Both pictures came back as a single en-block scene.
    expect(result.images).toHaveLength(2);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].refused).toBe(false);
    expect(result.scenes[0].prompt).toContain('A lone rider on a dune at dusk.');
    expect(result.scenes[0].prompt).not.toContain('waited years to close the deal');
  });

  it('pure picture mode falls back to per-scene when the en-block returns too few images', async () => {
    // Planner gives two descriptions.
    fetchMock.mockResolvedValueOnce(textResponse(
      '{"pictures":["A bridge over a frozen river.","A lantern in a snowy window."]}'
    ));
    // En-block returns only 1 image → discarded; each per-scene call returns 1.
    fetchMock.mockResolvedValueOnce(completionResponse(1)); // en-block (discarded)
    fetchMock.mockResolvedValueOnce(completionResponse(1)); // per-scene 1
    fetchMock.mockResolvedValueOnce(completionResponse(1)); // per-scene 2

    const CHAPTER = 'The old story prose with its intense and potentially sensitive plot details that should never reach the image model.';
    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user(CHAPTER)],
      undefined,
      {
        count: 2,
        planDescriptions: true,
        purePictures: true,
        sceneInstruction: 'Illustrate this beat of the story.'
      }
    );

    // planning + en-block(1 img) + 2 per-scene = 4 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.images).toHaveLength(2);
    expect(result.scenes).toHaveLength(2);
    // Every scene prompt is driven by a description and never leaks the prose.
    for (const scene of result.scenes) {
      expect(scene.prompt).not.toContain('intense and potentially sensitive');
      expect(scene.prompt).not.toContain('old story prose');
    }
  });

  it('recovers from a moderated pure-picture en-block by rendering each description per-scene', async () => {
    // Planning answers with ONE pure description.
    fetchMock.mockResolvedValueOnce(textResponse(
      '{"pictures":["A bridge over a frozen river."]}'
    ));
    // The en-block batch is content-moderated — previously that refused the
    // WHOLE set immediately …
    fetchMock.mockResolvedValueOnce(errorResponse(400, MODERATED_ERROR));
    // …but the per-scene retry of the same description still succeeds.
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('A violent scene')],
      undefined,
      { count: 1, planDescriptions: true, purePictures: true, sceneInstruction: 'Draw.' }
    );

    // planning + moderated en-block + per-scene = 3 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The per-scene call sends the derived description — never raw prose.
    const perScenePrompt = String(lastUserMessage(fetchMock, 2));
    expect(perScenePrompt).toContain('A bridge over a frozen river.');
    expect(perScenePrompt).not.toContain('A violent scene');
    // One moderated batch must not refuse the picture.
    expect(result.images).toHaveLength(1);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].refused).toBe(false);
  });

  it('keeps generating the remaining scenes after ONE scene is content-moderated', async () => {
    // Planning answers with TWO concrete descriptions.
    fetchMock.mockResolvedValueOnce(textResponse(
      '{"pictures":["A knight at dawn.","A dragon over the city."]}'
    ));
    // Scene 1's description is content-moderated …
    fetchMock.mockResolvedValueOnce(errorResponse(400, MODERATED_ERROR));
    // …but scene 2's INDEPENDENT description still renders.
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('A story about a knight and a dragon.')],
      undefined,
      { count: 2, planDescriptions: true, sceneInstruction: 'Draw.' }
    );

    // planning + moderated scene 1 + successful scene 2 = 3 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // A single moderation no longer costs the second scene's picture.
    expect(result.images).toHaveLength(1);
    expect(result.scenes).toHaveLength(2);
    expect(result.scenes[0].refused).toBe(true);
    expect(result.scenes[0].prompt).toContain('A knight at dawn.');
    expect(result.scenes[0].content).toContain('Generated image rejected by content moderation');
    expect(result.scenes[1].refused).toBe(false);
    expect(result.scenes[1].prompt).toContain('A dragon over the city.');
  });

  it('never throws nor discards generated pictures when a later scene fails hard', async () => {
    // Planning answers with TWO descriptions.
    fetchMock.mockResolvedValueOnce(textResponse(
      '{"pictures":["A bridge at noon.","A castle at night."]}'
    ));
    // Scene 1 renders a picture; scene 2 hits a hard transport error (503).
    fetchMock.mockResolvedValueOnce(completionResponse(1));
    fetchMock.mockResolvedValueOnce(errorResponse(503, 'upstream down'));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('The bridge and the castle.')],
      undefined,
      { count: 2, planDescriptions: true, sceneInstruction: 'Draw.' }
    );

    // No rejection — the transport error is a REFUSED scene and the picture
    // already generated is preserved (never lost).
    expect(result.images).toHaveLength(1);
    expect(result.scenes).toHaveLength(2);
    expect(result.scenes[0].refused).toBe(false);
    expect(result.scenes[1].refused).toBe(true);
    expect(result.scenes[1].content).toContain('LLM request failed: 503');
    expect(result.scenes[1].prompt).toContain('A castle at night.');
  });

  // ------------------------------------------------------------------
  // Request logging
  // ------------------------------------------------------------------

  it('logs chat requests with message count and first/last content', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [
        { role: 'system', content: 'You are a storyteller.' },
        { role: 'user', content: 'Draw a castle' },
      ],
      undefined,
      { count: 1 }
    );

    const chatLogs = logSpy.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.includes('[llm:chat]'));
    expect(chatLogs.length).toBeGreaterThan(0);
    const line = chatLogs[0];
    // The image model only ever receives the prepared prompt — a single
    // user message, never the surrounding story history.
    expect(line).toContain('messages=1');
    expect(line).toContain('first={user/text → "Draw a castle"}');
    expect(line).toContain('last={user/text → "Draw a castle"}');
    logSpy.mockRestore();
  });

  it('logs the single prompt for the images endpoint (image LLM)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(errorResponse(
      404,
      '{"error":{"message":"qwen/qwen-image-3 cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.","code":404}}'
    ));
    fetchMock.mockResolvedValueOnce(imagesResponse(1));

    await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('Draw a castle at dusk')],
      undefined,
      { count: 1 }
    );

    const imageLogs = logSpy.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.includes('[llm:image]'));
    expect(imageLogs.length).toBeGreaterThan(0);
    const line = imageLogs[0];
    // Exactly one message (the picture prompt).
    expect(line).toContain('messages=1');
    expect(line).toContain('first={text → "Draw a castle at dusk"}');
    expect(line).toContain('last={text → "Draw a castle at dusk"}');
    logSpy.mockRestore();
  });

  it('never leaks parts payloads into the image/chat log (kind label only)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Use this reference' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRETPIXEL' } },
        ],
      }],
      undefined,
      { count: 1 }
    );

    const chatLogs = logSpy.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.includes('[llm:chat]'));
    const line = chatLogs[chatLogs.length - 1];
    expect(line).toContain('parts[2]:text+image_url');
    expect(line).toContain('Use this reference');
    expect(line).not.toContain('SECRETPIXEL');
    logSpy.mockRestore();
  });

  it('stores the FULL request body (all messages + the rest of the json) in the log buffer', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const longLast = 'L'.repeat(5000); // must be preserved in full
    fetchMock.mockResolvedValueOnce(completionResponse(1));

    await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: longLast },
      ],
      undefined,
      { count: 1 }
    );

    const llmLog = TestBed.inject(LlmLogService);
    await llmLog.flush();
    const chatEntries = llmLog.entries().filter(e => e.kind === 'chat');
    expect(chatEntries.length).toBeGreaterThan(0);
    const entry = chatEntries[chatEntries.length - 1];
    // The stored body carries the FULL last message verbatim…
    expect(entry.body?.['messages']).toBeTruthy();
    const bodyMessages = entry.body?.['messages'] as { role: string; content: unknown }[];
    expect(bodyMessages[bodyMessages.length - 1].content).toBe(longLast);
    // …and the rest of the JSON (stream, temperature, model) is present too.
    expect(entry.body?.['model']).toBe(MODEL.modelId);
    expect(entry.body).toHaveProperty('stream');
    logSpy.mockRestore();
  });

  it('records the chat/completions RESPONSE on the log entry (image generation)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(completionResponse(2));

    await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('Draw two castles')],
      undefined,
      { count: 2 }
    );

    const llmLog = TestBed.inject(LlmLogService);
    await llmLog.flush();
    const chatEntries = llmLog.entries().filter(e => e.kind === 'chat');
    const entry = chatEntries[chatEntries.length - 1];
    expect(entry.completed).toBe(true);
    expect(entry.error).toBeUndefined();
    // The stored response is the full raw JSON the provider returned.
    expect(entry.response).toBeTruthy();
    const resp = entry.response as { choices: { message: { content: unknown[] } }[] };
    expect(Array.isArray(resp.choices)).toBe(true);
    expect(Array.isArray(resp.choices[0].message.content)).toBe(true);
    logSpy.mockRestore();
  });

  it('records an ERROR (status + text) on the log entry when a call fails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // An images-only model is served by the /images endpoint: chat/completions
    // rejects with the "…use the /images endpoint instead" hint (which makes
    // callOnce fall back to /images), and that endpoint then fails with a 400
    // — the propagated error, with the underlying call still recorded.
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(errorResponse(
        400,
        'This model cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.'
      ))
      .mockResolvedValueOnce(errorResponse(
        400,
        '{"error":{"message":"bad request","code":400}}'
      ));

    const result = await service.generateImage(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
      MODEL,
      [user('Draw a castle')],
      undefined,
      { count: 1 }
    );

    // No rejection — the failed generation is a refused scene, never a thrown
    // error that would lose the illustrate.
    expect(result.images).toHaveLength(0);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].refused).toBe(true);
    expect(result.scenes[0].content).toContain('bad request');

    const llmLog = TestBed.inject(LlmLogService);
    await llmLog.flush();
    const imageEntries = llmLog.entries().filter(e => e.kind === 'image');
    const entry = imageEntries[imageEntries.length - 1];
    expect(entry.completed).toBe(true);
    expect(entry.error?.status).toBe(400);
    expect(entry.error?.text).toContain('bad request');
    expect(entry.response).toBeUndefined();
    logSpy.mockRestore();
  });
});

function user(text: string): ChatMessage {
  return { role: 'user', content: text };
}

/**
 * OpenRouter-shaped 400 for an xAI content-moderation rejection:
 * the provider's raw error is a JSON string under error.metadata.raw.
 */
const MODERATED_ERROR = JSON.stringify({
  error: {
    message: 'Provider returned error',
    code: 400,
    metadata: {
      raw: JSON.stringify({
        code: 'imagine:content-moderated',
        error: 'Generated image rejected by content moderation.',
        usage: { cost_in_usd_ticks: 500000000 }
      }),
      provider_name: 'xAI',
      is_byok: false
    }
  },
  user_id: 'user_39nXIXmWrSdmQIC29eZalLuPnE81'
});