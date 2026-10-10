import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ProvidersComponent } from './providers.component';
import { CHAT_API } from '../../../api/chat-api.token';
import { SettingsService } from '../../../core/settings.service';
import { I18nService } from '../../../core/i18n/i18n.service';
import { InMemoryChatApi } from '../../../../../test-helpers/in-memory-chat-api';

describe('ProvidersComponent', () => {
  let fixture: ComponentFixture<ProvidersComponent>;
  let component: ProvidersComponent;
  let api: InMemoryChatApi;
  let settings: SettingsService;
  let http: HttpTestingController;

  beforeEach(async () => {
    api = new InMemoryChatApi();
    localStorage.removeItem('chat.theme');
    localStorage.removeItem('chat.view.locale');

    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await TestBed.configureTestingModule({
      imports: [ProvidersComponent],
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
    TestBed.inject(I18nService).setLocale('en');

    fixture = TestBed.createComponent(ProvidersComponent);
    component = fixture.componentInstance;
    component.i18n.setLocale('en');
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

  it('switches providers chrome to German', () => {
    component.i18n.setLocale('de');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Noch keine Anbieter eingerichtet.');
    expect(text).toContain('Verfügbare Modelle / Voreinstellungen');
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
    component.saveProvider();
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

    component.deleteProvider(provider.id);
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
    await settings.addPreset('Claude', 'anthropic/claude', provider.id);
    const gpt = await settings.addPreset('GPT-4o', 'openai/gpt-4o', provider.id);
    await settings.toggleModelEnabled(gpt.id); // gpt disabled
    fixture.detectChanges();

    expect(component.filteredModels().map(m => m.displayName)).toEqual(['Claude', 'GPT-4o']);

    component.searchTerm.set('gpt');
    expect(component.filteredModels().map(m => m.displayName)).toEqual(['Claude', 'GPT-4o']);
    // default view: enabled stay visible, search only applies to disabled

    component.searchTerm.set('');
    component.setEnabledOnly(true);
    expect(component.filteredModels().map(m => m.displayName)).toEqual(['Claude']);

    component.setDisabledOnly(true);
    expect(component.showEnabledOnly()).toBe(false);
    expect(component.filteredModels().map(m => m.displayName)).toEqual(['GPT-4o']);
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

  function escapeEvent(): KeyboardEvent {
    return { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent;
  }

  it('Escape closes the add-provider modal (same as its Cancel button)', () => {
    component.openAddProvider();
    expect(component.showAddProvider()).toBe(true);

    component.onDocumentKeydown(escapeEvent());

    expect(component.showAddProvider()).toBe(false);
  });

  it('Escape closes the add/edit preset modal (same as its Cancel button)', async () => {
    await settings.addProvider({
      name: 'OR',
      type: 'openrouter',
      baseUrl: 'https://example',
      apiKey: 'key-xxxxxx',
      enabled: true
    });
    await settings.loadAll();
    component.openAddPreset();
    expect(component.showAddPreset()).toBe(true);

    component.onDocumentKeydown(escapeEvent());

    expect(component.showAddPreset()).toBe(false);
  });

  it('Escape closes the fetched-params modal (same as its Cancel button)', () => {
    component.showFetchedParams.set(true);
    expect(component.showFetchedParams()).toBe(true);

    component.onDocumentKeydown(escapeEvent());

    expect(component.showFetchedParams()).toBe(false);
  });

  const uuid = (prefix: string) => `${prefix}-e29b-41d4-a716-446655440000`;

  it('flags duplicate provider names and extracts the uuid id prefix', async () => {
    api.providers = [
      { id: uuid('550e8400'), name: 'OR', type: 'openrouter', baseUrl: 'https://a', apiKey: 'k', enabled: true },
      { id: uuid('6ba7b810'), name: 'OR', type: 'openrouter', baseUrl: 'https://b', apiKey: 'k', enabled: true }
    ];
    await settings.loadAll();
    fixture.detectChanges();

    expect(component.duplicateProviderNames()).toEqual(new Set(['OR']));
    expect(component.providerIdPrefix(api.providers[0].id)).toBe('550e8400');
    expect(component.providerIdPrefix(api.providers[1].id)).toBe('6ba7b810');
    expect(component.needsDisambiguation(api.providers[0].id)).toBe(true);
    expect(component.needsDisambiguation(api.providers[1].id)).toBe(true);
  });

  it('renders the uuid id prefix left of the provider name when names collide', async () => {
    api.providers = [
      { id: uuid('550e8400'), name: 'OR', type: 'openrouter', baseUrl: 'https://a', apiKey: 'k', enabled: true },
      { id: uuid('6ba7b810'), name: 'OR', type: 'openrouter', baseUrl: 'https://b', apiKey: 'k', enabled: true }
    ];
    await settings.loadAll();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const prefixes = el.querySelectorAll('.provider-id-prefix');
    expect(prefixes.length).toBe(2);
    expect((prefixes[0] as HTMLElement).textContent).toBe('550e8400');
    expect((prefixes[1] as HTMLElement).textContent).toBe('6ba7b810');
    expect(el.textContent).toContain('OR');
  });

  it('shows a second line under the provider name in the models table when names collide', async () => {
    api.providers = [
      { id: uuid('550e8400'), name: 'OR', type: 'openrouter', baseUrl: 'https://a', apiKey: 'k', enabled: true },
      { id: uuid('6ba7b810'), name: 'OR', type: 'openrouter', baseUrl: 'https://b', apiKey: 'k', enabled: true }
    ];
    api.models = [
      { id: 'm1', displayName: 'Alpha', modelId: 'model/a', providerId: api.providers[0].id, type: 'preset', enabled: true },
      { id: 'm2', displayName: 'Beta', modelId: 'model/b', providerId: api.providers[1].id, type: 'preset', enabled: true }
    ];
    await settings.loadAll();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const prefixes = el.querySelectorAll('.models-table .provider-prefix');
    expect(prefixes.length).toBe(2);
    expect((prefixes[0] as HTMLElement).textContent).toBe('550e8400');
    expect((prefixes[1] as HTMLElement).textContent).toBe('6ba7b810');
  });

  it('does not show the id prefix when provider names are unique', async () => {
    api.providers = [
      { id: uuid('550e8400'), name: 'OR', type: 'openrouter', baseUrl: 'https://a', apiKey: 'k', enabled: true },
      { id: uuid('6ba7b810'), name: 'Local', type: 'custom', baseUrl: 'https://b', apiKey: 'k', enabled: true }
    ];
    api.models = [
      { id: 'm1', displayName: 'Alpha', modelId: 'model/a', providerId: api.providers[0].id, type: 'preset', enabled: true }
    ];
    await settings.loadAll();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.provider-id-prefix').length).toBe(0);
    expect(el.querySelectorAll('.models-table .provider-prefix').length).toBe(0);
  });
});