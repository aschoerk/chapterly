import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ConfigComponent } from './config.component';
import { CHAT_API } from '../../api/chat-api.token';
import { SettingsService } from '../../core/settings.service';
import { ThemeService } from '../../core/theme.service';
import {InMemoryChatApi} from '../../../../test-helpers/in-memory-chat-api';



describe('ConfigComponent', () => {
  let fixture: ComponentFixture<ConfigComponent>;
  let component: ConfigComponent;
  let api: InMemoryChatApi;
  let settings: SettingsService;
  let http: HttpTestingController;

  function stubMatchMedia(matches = false) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    });
  }

  beforeEach(async () => {
    stubMatchMedia(false);
    api = new InMemoryChatApi();
    localStorage.removeItem('chat.theme');

    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await TestBed.configureTestingModule({
      imports: [ConfigComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    settings = TestBed.inject(SettingsService);
    http = TestBed.inject(HttpTestingController);

    fixture = TestBed.createComponent(ConfigComponent);
    component = fixture.componentInstance;
    await settings.loadAll();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows an empty providers hint when nothing is stored', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('No providers configured yet.');
  });

  it('refuses to save a provider without an API key', () => {
    component.openAddProvider();
    component.newProvider.apiKey = '   ';
    component.saveProvider();

    expect(window.alert).toHaveBeenCalled();
    expect(api.providers.length).toBe(0);
    expect(component.showAddProvider()).toBe(true);
  });

  it('saves a provider through SettingsService and renders the card', async () => {
    component.openAddProvider();
    component.newProvider = {
      name: 'OpenRouter',
      type: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test-1234567890',
      enabled: true
    };
    await component.saveProvider();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.providers.length).toBe(1);
    expect(api.providers[0].apiKey).toBe('sk-test-1234567890');
    expect(settings.providers().length).toBe(1);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('OpenRouter');
    expect(el.textContent).toContain('1234567890'.slice(-6));
    expect(component.showAddProvider()).toBe(false);
  });

  it('deletes a provider and its models after confirm', async () => {
    const provider = await settings.addProvider({
      name: 'Local',
      type: 'custom',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'abc1234567',
      enabled: true
    });
    await settings.addPreset('Llama', 'llama3', provider.id);
    fixture.detectChanges();

    await component.deleteProvider(provider.id);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(window.confirm).toHaveBeenCalled();
    expect(settings.providers()).toEqual([]);
    expect(settings.models()).toEqual([]);
  });

  it('filters models by search and enabled/disabled toggles', async () => {
    const provider = await settings.addProvider({
      name: 'OR',
      type: 'openrouter',
      baseUrl: 'https://example',
      apiKey: 'key-xxxxxx',
      enabled: true
    });
    const claude = await settings.addPreset('Claude', 'anthropic/claude', provider.id);
    const gpt = await settings.addPreset('GPT-4o', 'openai/gpt-4o', provider.id);
    await settings.toggleModelEnabled(gpt.id); // gpt disabled
    fixture.detectChanges();

    expect(component.filteredModels().map(m => m.displayName)).toEqual(['Claude', 'GPT-4o']);

    component.searchTerm.set('gpt');
    expect(component.filteredModels().map(m => m.displayName)).toEqual(['Claude', 'GPT-4o']);
    // default view: enabled stay visible, search only applies to disabled

    component.setEnabledOnly(true);
    expect(component.filteredModels().map(m => m.displayName)).toEqual(['GPT-4o']);

    component.setDisabledOnly(true);
    expect(component.showEnabledOnly()).toBe(false);
    expect(component.filteredModels().map(m => m.displayName)).toEqual(['Claude']);
  });

  it('creates a preset against the selected provider', async () => {
    const provider = await settings.addProvider({
      name: 'OR',
      type: 'openrouter',
      baseUrl: 'https://example',
      apiKey: 'key-xxxxxx',
      enabled: true
    });
    await settings.loadAll();

    component.openAddPreset();
    component.newPreset.displayName = 'Coder';
    component.newPreset.modelId = 'qwen/qwen3';
    component.newPreset.providerId = provider.id;
    component.toggleInputModality('text');
    component.toggleOutputModality('text');

    await component.savePreset();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(settings.models().length).toBe(1);
    expect(settings.models()[0]).toEqual(expect.objectContaining({
      displayName: 'Coder',
      modelId: 'qwen/qwen3',
      type: 'preset',
      enabled: true,
      providerId: provider.id
    }));
    expect(settings.models()[0].architecture?.modality).toBe('text->text');
    expect(component.showAddPreset()).toBe(false);
  });

  it('toggles a model enabled flag', async () => {
    const provider = await settings.addProvider({
      name: 'OR',
      type: 'openrouter',
      baseUrl: 'https://example',
      apiKey: 'key-xxxxxx',
      enabled: true
    });
    const model = await settings.addPreset('Claude', 'anthropic/claude', provider.id);
    expect(model.enabled).toBe(true);

    await component.toggleEnabled(model.id);
    expect(settings.models()[0].enabled).toBe(false);
  });

  it('stores the theme preference without touching the server', () => {
    const theme = TestBed.inject(ThemeService);
    component.theme.setPreference('dark');

    expect(theme.preference()).toBe('dark');
    expect(theme.resolved()).toBe('dark');
    expect(localStorage.getItem('chat.theme')).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('tests a provider via the proxy HttpClient mock, not the chat-server', async () => {
    const provider = await settings.addProvider({
      name: 'OR',
      type: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-live',
      enabled: true
    });

    const pending = component.testProvider(provider);
    const req = http.expectOne(r => r.url.includes('/proxy/models'));
    expect(req.request.headers.get('Authorization')).toBe('Bearer sk-live');
    expect(req.request.headers.get('x-target-base')).toBe(provider.baseUrl);
    req.flush({ data: [] });

    await pending;
    fixture.detectChanges();

    expect(component.testResult()).toEqual({
      id: provider.id,
      ok: true,
      message: 'Connection successful'
    });
  });

  it('validates a preset test without calling a real model', async () => {
    component.openAddPreset();
    component.newPreset.modelId = '';
    await component.testPreset();

    expect(component.presetTestResult()?.ok).toBe(false);
    expect(component.presetTestResult()?.message).toMatch(/Model ID/i);
    http.expectNone(() => true);
  });
});
