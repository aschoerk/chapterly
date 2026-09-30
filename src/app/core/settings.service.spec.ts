import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ProviderConfig } from '../models/chat-config';
import { CHAT_API } from '../api/chat-api.token';
import { SettingsService } from './settings.service';
import { InMemoryChatApi } from '../../../test-helpers/in-memory-chat-api';

describe('SettingsService.fetchModels', () => {
  let settings: SettingsService;
  let api: InMemoryChatApi;
  let http: HttpTestingController;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    settings = TestBed.inject(SettingsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  async function addOpenRouterProvider(): Promise<ProviderConfig> {
    return settings.addProvider({
      name: 'OpenRouter',
      type: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test-1234',
      enabled: true
    });
  }

  /** Flush the pending proxied request and let the awaited continuation run,
   *  so the next request (if any) is issued before the next expectOne. */
  async function flushAndNext(urlPart: string, body: unknown, error?: { status: number; statusText: string }) {
    const req = http.expectOne(r => r.url.endsWith(urlPart));
    if (error) {
      req.flush({}, { status: error.status, statusText: error.statusText });
    } else {
      req.flush(body as any);
    }
    await new Promise(r => setTimeout(r, 0));
  }

  it('merges the OpenRouter image catalog so image-only models are fetched', async () => {
    const provider = await addOpenRouterProvider();

    const fetchPromise = settings.fetchModels(provider);

    await flushAndNext('/proxy/models', {
      data: [
        {
          id: 'openai/gpt-4o-mini',
          name: 'OpenAI: GPT-4o mini',
          architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] }
        }
      ]
    });
    await flushAndNext('/proxy/images/models', {
      data: [
        {
          id: 'x-ai/grok-imagine-image-2.0',
          name: 'xAI: Grok Imagine Image 2.0',
          description: 'Image generation model',
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] }
        }
      ]
    });

    await fetchPromise;

    const models = settings.models();
    const image = models.find(m => m.modelId === 'x-ai/grok-imagine-image-2.0');
    expect(image).toBeTruthy();
    expect(image?.providerId).toBe(provider.id);
    expect(image?.architecture?.output_modalities).toContain('image');
    // Newly fetched models are added disabled so the user can enable them explicitly.
    expect(image?.enabled).toBe(false);
    expect(models.some(m => m.modelId === 'openai/gpt-4o-mini')).toBe(true);
  });

  it('prefers the chat catalog entry when a model exists in both', async () => {
    await addOpenRouterProvider();

    const fetchPromise = settings.fetchModels(
      settings.providers().find(p => p.type === 'openrouter')!
    );

    await flushAndNext('/proxy/models', {
      data: [
        {
          id: 'x-ai/grok-4.7',
          name: 'xAI: Grok 4.7',
          architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
          top_provider: { context_length: 131072, max_completion_tokens: 128000, is_moderated: true }
        }
      ]
    });
    await flushAndNext('/proxy/images/models', {
      data: [
        {
          id: 'x-ai/grok-4.7',
          name: 'xAI: Grok 4.7 (image)',
          architecture: { input_modalities: ['image'], output_modalities: ['image'] }
        }
      ]
    });

    await fetchPromise;

    const model = settings.models().find(m => m.modelId === 'x-ai/grok-4.7');
    // Richer chat entry (name + text architecture) wins over the image entry.
    expect(model?.displayName).toBe('xAI: Grok 4.7');
    expect(model?.architecture?.input_modalities).toEqual(['text']);
    expect(model?.architecture?.output_modalities).toEqual(['text']);
  });

  it('does not query an image catalog for non-OpenRouter providers', async () => {
    const provider = await settings.addProvider({
      name: 'Local',
      type: 'custom',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'abc-1234',
      enabled: true
    });

    const fetchPromise = settings.fetchModels(provider);

    await flushAndNext('/proxy/models', {
      data: [{ id: 'llama3', name: 'Llama 3' }]
    });

    await fetchPromise;

    expect(settings.models().some(m => m.modelId === 'llama3')).toBe(true);
  });

  it('tolerates a missing image catalog (404) for OpenRouter', async () => {
    await addOpenRouterProvider();

    const fetchPromise = settings.fetchModels(
      settings.providers().find(p => p.type === 'openrouter')!
    );

    await flushAndNext('/proxy/models', {
      data: [{ id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini' }]
    });
    await flushAndNext('/proxy/images/models', {}, { status: 404, statusText: 'Not Found' });

    await fetchPromise;

    expect(settings.models().some(m => m.modelId === 'openai/gpt-4o-mini')).toBe(true);
  });
});