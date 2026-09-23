import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../api/chat-api.token';
import { InMemoryChatApi } from '../../../test-helpers/in-memory-chat-api';
import { makeProvider, makeModel } from '../../../test-helpers/factories';
import { SettingsService } from './settings.service';
import { GenerationSettingsService } from './generation-settings.service';
import { GenerationTaskKind } from '../models/generation-task';

const LS_KEY = 'chat.generationTasks';
const ALL_KINDS: GenerationTaskKind[] = ['title', 'headings', 'overview', 'image-create', 'image-interpret'];

const empty = (kind: GenerationTaskKind) => ({ kind, providerId: '', modelId: '', prompt: '' });

describe('GenerationSettingsService', () => {
  let api: InMemoryChatApi;
  let settings: SettingsService;
  let generation: GenerationSettingsService;

  beforeEach(async () => {
    localStorage.removeItem(LS_KEY);
    api = new InMemoryChatApi();
    api.providers.push(makeProvider());
    api.models.push(
      makeModel({ id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model', providerId: 'prov-1', enabled: true }),
      makeModel({ id: 'm-2', displayName: 'Beta', modelId: 'beta/model', providerId: 'prov-2', enabled: true }),
      makeModel({ id: 'm-3', displayName: 'Off', modelId: 'off/model', providerId: 'prov-1', enabled: false })
    );

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    generation = TestBed.inject(GenerationSettingsService);
  });

  afterEach(() => {
    localStorage.removeItem(LS_KEY);
  });

  it('starts with empty defaults for every task', () => {
    for (const kind of ALL_KINDS) {
      expect(generation.get(kind)).toEqual(empty(kind));
    }
  });

  it('update() merges a patch and persists to localStorage', () => {
    generation.update('title', { providerId: 'prov-1', modelId: 'alpha/model', prompt: 'Make a title' });

    expect(generation.get('title')).toEqual({
      kind: 'title',
      providerId: 'prov-1',
      modelId: 'alpha/model',
      prompt: 'Make a title'
    });

    const stored = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    expect(stored.title).toEqual(expect.objectContaining({ providerId: 'prov-1', modelId: 'alpha/model' }));

    // other tasks untouched
    expect(generation.get('overview')).toEqual(empty('overview'));
  });

  it('reset() clears only the requested task', () => {
    generation.update('headings', { providerId: 'prov-1', modelId: 'beta/model', prompt: 'H' });
    generation.update('title', { providerId: 'prov-2', modelId: 'beta/model' });

    generation.reset('headings');

    expect(generation.get('headings')).toEqual(empty('headings'));
    expect(generation.get('title').providerId).toBe('prov-2');
  });

  it('resolves provider and model entries via SettingsService', () => {
    generation.update('title', { providerId: 'prov-1', modelId: 'alpha/model' });

    expect(generation.providerFor('title')?.name).toBe('OpenRouter');
    expect(generation.providerFor('title')?.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(generation.modelFor('title')?.displayName).toBe('Alpha');
  });

  it('providerFor / modelFor return null for unset or unknown refs', () => {
    expect(generation.providerFor('title')).toBeNull();
    expect(generation.modelFor('title')).toBeNull();

    generation.update('title', { providerId: 'nope', modelId: 'does-not-exist' });
    expect(generation.providerFor('title')).toBeNull();
    expect(generation.modelFor('title')).toBeNull();
  });

  it('modelsForProvider returns only enabled models of that provider', () => {
    const list = generation.modelsForProvider('prov-1');
    expect(list.map(m => m.modelId)).toEqual(['alpha/model']);

    expect(generation.modelsForProvider('')).toEqual([]);
  });

  it('persist() writes the current state', () => {
    generation.update('image-create', { providerId: 'prov-2', modelId: 'beta/model', prompt: 'Paint' });
    const stored = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    expect(stored['image-create']).toEqual(expect.objectContaining({ prompt: 'Paint' }));
  });
});

describe('GenerationSettingsService boot restore', () => {
  afterEach(() => {
    localStorage.removeItem(LS_KEY);
  });

  it('reads persisted configs from localStorage at construction', async () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        title: { providerId: 'prov-1', modelId: 'alpha/model', prompt: 'T' }
      })
    );

    const api = new InMemoryChatApi();
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    const generation = TestBed.inject(GenerationSettingsService);
    expect(generation.get('title')).toEqual({ kind: 'title', providerId: 'prov-1', modelId: 'alpha/model', prompt: 'T' });
    // every other task falls back to defaults
    expect(generation.get('overview')).toEqual(empty('overview'));
  });

  it('ignores corrupted JSON and falls back to defaults', async () => {
    localStorage.setItem(LS_KEY, '{not valid json');

    const api = new InMemoryChatApi();
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    const generation = TestBed.inject(GenerationSettingsService);
    expect(generation.get('title')).toEqual(empty('title'));
  });
});