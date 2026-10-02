import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../api/chat-api.token';
import { InMemoryChatApi } from '../../../test-helpers/in-memory-chat-api';
import { IllustrateDialogService } from './illustrate-dialog.service';

const LS_KEY = 'chat.illustrateOptions.v1';

describe('IllustrateDialogService', () => {
  let service: IllustrateDialogService;

  beforeEach(() => {
    localStorage.removeItem(LS_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    });
    service = TestBed.inject(IllustrateDialogService);
  });

  afterEach(() => {
    localStorage.removeItem(LS_KEY);
  });

  it('starts with single-scene defaults', () => {
    expect(service.last()).toEqual({
      count: 1, style: '', storyboardPrompt: '', purePictures: false,
      modelId: '', providerId: '', historyMode: 'single', planDescriptions: true
    });
    expect(service.current()).toBeNull();
  });

  it('open() seeds from the last-used options and resolves on submit', async () => {
    service.submit({
      count: 12,
      style: 'comic style',
      storyboardPrompt: 'no explicit images',
      purePictures: true,
      modelId: 'alpha/image',
      providerId: 'prov-1',
      historyMode: 'full',
      planDescriptions: false // forced back on by pure mode
    });

    const promise = service.open();
    expect(service.current()).not.toBeNull();
    // Dialog editor displays the persisted values.
    expect(service.current()?.count).toBe(12);
    expect(service.current()?.style).toBe('comic style');
    expect(service.current()?.purePictures).toBe(true);
    expect(service.current()?.planDescriptions).toBe(true); // pure mode → planning on

    service.submit({
      count: 3,
      style: ' ink ',
      storyboardPrompt: '  hide behind shadows  ',
      purePictures: false,
      modelId: 'beta/image',
      providerId: 'prov-1',
      historyMode: 'full',
      planDescriptions: false
    });

    await expect(promise).resolves.toEqual({
      count: 3,
      style: 'ink',
      storyboardPrompt: 'hide behind shadows',
      purePictures: false,
      modelId: 'beta/image',
      providerId: 'prov-1',
      historyMode: 'full',
      planDescriptions: false
    });
    expect(service.current()).toBeNull();
    expect(service.last()).toEqual({
      count: 3, style: 'ink', storyboardPrompt: 'hide behind shadows', purePictures: false,
      modelId: 'beta/image', providerId: 'prov-1', historyMode: 'full', planDescriptions: false
    });
  });

  it('open() seed overrides the remembered model while keeping other fields', async () => {
    service.submit({
      count: 2,
      style: 'ink',
      storyboardPrompt: 'shadows',
      purePictures: false,
      modelId: 'old/image',
      providerId: 'prov-9',
      historyMode: 'single',
      planDescriptions: false
    });

    const promise = service.open({ modelId: 'new/image', providerId: 'prov-1' });
    expect(service.current()?.modelId).toBe('new/image');
    expect(service.current()?.providerId).toBe('prov-1');
    // Non-model fields still come from the remembered options.
    expect(service.current()?.count).toBe(2);
    expect(service.current()?.style).toBe('ink');
    expect(service.current()?.planDescriptions).toBe(false);

    service.cancel();
    await promise;
  });

  it('cancel() resolves null and leaves last() untouched', async () => {
    service.submit({ count: 5, style: 'x', storyboardPrompt: 'y', purePictures: true, modelId: '', providerId: '', historyMode: 'single', planDescriptions: false });
    const promise = service.open();
    service.cancel();

    await expect(promise).resolves.toBeNull();
    expect(service.current()).toBeNull();
    expect(service.last().count).toBe(5);
    expect(service.last().purePictures).toBe(true);
    // Submit with pure mode forced planning on at the service layer.
    expect(service.last().planDescriptions).toBe(true);
  });

  it('clamps count into 1..64', async () => {
    const promise = service.open();
    service.submit({ count: 999, style: '', storyboardPrompt: '', purePictures: false, modelId: '', providerId: '', historyMode: 'single', planDescriptions: true });
    await expect(promise).resolves.toMatchObject({ count: 64 });

    const promise2 = service.open();
    service.submit({ count: 0, style: '', storyboardPrompt: '', purePictures: false, modelId: '', providerId: '', historyMode: 'single', planDescriptions: true });
    await expect(promise2).resolves.toMatchObject({ count: 1 });
  });

  it('normalizes purePictures to a boolean', async () => {
    const promise = service.open();
    service.submit({ count: 2, style: '', storyboardPrompt: '', purePictures: 'yes' as any, modelId: '', providerId: '', historyMode: 'single', planDescriptions: false });
    await expect(promise).resolves.toMatchObject({ purePictures: true, planDescriptions: true });
  });

  it('persists last-used options to localStorage', () => {
    service.submit({ count: 7, style: 'a', storyboardPrompt: 'b', purePictures: true, modelId: 'alpha/image', providerId: 'prov-1', historyMode: 'full', planDescriptions: false });
    expect(JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')).toEqual({
      count: 7,
      style: 'a',
      storyboardPrompt: 'b',
      purePictures: true,
      modelId: 'alpha/image',
      providerId: 'prov-1',
      historyMode: 'full',
      planDescriptions: true // pure mode forced planning back on
    });
  });

  it('restores persisted options on construction', () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ count: 4, style: 'pastel', storyboardPrompt: 'none', purePictures: true })
    );
    // Fresh injector → fresh root service that reads localStorage on boot.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    });
    const reloaded = TestBed.inject(IllustrateDialogService);
    expect(reloaded.last()).toEqual({ count: 4, style: 'pastel', storyboardPrompt: 'none', purePictures: true, modelId: '', providerId: '', historyMode: 'single', planDescriptions: true });
    expect(reloaded.current()).toBeNull();
  });

  it('is backward compatible with stored options missing purePictures', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ count: 2, style: 'x', storyboardPrompt: 'y' }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    });
    const reloaded = TestBed.inject(IllustrateDialogService);
    expect(reloaded.last()).toEqual({ count: 2, style: 'x', storyboardPrompt: 'y', purePictures: false, modelId: '', providerId: '', historyMode: 'single', planDescriptions: true });
  });

  it('is backward compatible with stored options missing historyMode and planDescriptions', () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ count: 1, style: 'x', storyboardPrompt: 'y', purePictures: false, modelId: 'm', providerId: 'p' })
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    });
    const reloaded = TestBed.inject(IllustrateDialogService);
    expect(reloaded.last().historyMode).toBe('single');
  });

  it('normalizes an invalid persisted historyMode to single', () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ count: 1, style: '', storyboardPrompt: '', purePictures: false, modelId: '', providerId: '', historyMode: 'bogus' })
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    });
    const reloaded = TestBed.inject(IllustrateDialogService);
    expect(reloaded.last()).toEqual({
      count: 1, style: '', storyboardPrompt: '', purePictures: false,
      modelId: '', providerId: '', historyMode: 'single', planDescriptions: true
    });
  });

  it('is backward compatible with stored options missing planDescriptions', () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ count: 1, style: 'x', storyboardPrompt: 'y', purePictures: false, modelId: 'm', providerId: 'p', historyMode: 'single' })
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    });
    const reloaded = TestBed.inject(IllustrateDialogService);
    // Default planning ON when it was never stored.
    expect(reloaded.last().historyMode).toBe('single');
    expect(reloaded.last().planDescriptions).toBe(true);
  });

  it('forces planning back on when a stored pure-mode option tried to disable it', () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ count: 1, style: '', storyboardPrompt: '', purePictures: true, modelId: '', providerId: '', historyMode: 'single', planDescriptions: false })
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    });
    const reloaded = TestBed.inject(IllustrateDialogService);
    expect(reloaded.last().planDescriptions).toBe(true);
  });
});