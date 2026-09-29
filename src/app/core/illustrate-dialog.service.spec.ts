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
    expect(service.last()).toEqual({ count: 1, style: '', storyboardPrompt: '' });
    expect(service.current()).toBeNull();
  });

  it('open() seeds from the last-used options and resolves on submit', async () => {
    service.submit({
      count: 12,
      style: 'comic style',
      storyboardPrompt: 'no explicit images'
    });

    const promise = service.open();
    expect(service.current()).not.toBeNull();
    // Dialog editor displays the persisted values.
    expect(service.current()?.count).toBe(12);
    expect(service.current()?.style).toBe('comic style');

    service.submit({
      count: 3,
      style: ' ink ',
      storyboardPrompt: '  hide behind shadows  '
    });

    await expect(promise).resolves.toEqual({
      count: 3,
      style: 'ink',
      storyboardPrompt: 'hide behind shadows'
    });
    expect(service.current()).toBeNull();
    expect(service.last()).toEqual({ count: 3, style: 'ink', storyboardPrompt: 'hide behind shadows' });
  });

  it('cancel() resolves null and leaves last() untouched', async () => {
    service.submit({ count: 5, style: 'x', storyboardPrompt: 'y' });
    const promise = service.open();
    service.cancel();

    await expect(promise).resolves.toBeNull();
    expect(service.current()).toBeNull();
    expect(service.last().count).toBe(5);
  });

  it('clamps count into 1..64', async () => {
    const promise = service.open();
    service.submit({ count: 999, style: '', storyboardPrompt: '' });
    await expect(promise).resolves.toMatchObject({ count: 64 });

    const promise2 = service.open();
    service.submit({ count: 0, style: '', storyboardPrompt: '' });
    await expect(promise2).resolves.toMatchObject({ count: 1 });
  });

  it('persists last-used options to localStorage', () => {
    service.submit({ count: 7, style: 'a', storyboardPrompt: 'b' });
    expect(JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')).toEqual({
      count: 7,
      style: 'a',
      storyboardPrompt: 'b'
    });
  });

  it('restores persisted options on construction', () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ count: 4, style: 'pastel', storyboardPrompt: 'none' })
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
    expect(reloaded.last()).toEqual({ count: 4, style: 'pastel', storyboardPrompt: 'none' });
    expect(reloaded.current()).toBeNull();
  });
});