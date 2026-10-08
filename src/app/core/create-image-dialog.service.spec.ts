import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../api/chat-api.token';
import { InMemoryChatApi } from '../../../test-helpers/in-memory-chat-api';
import { CreateImageDialogService } from './create-image-dialog.service';
import { makeNode } from '../../../test-helpers/factories';
import { NodeAttachment } from '../models/chat';

const LS_CONSTANT = 'chat.createImage.constantByChatId';
const LS_IMAGES = 'chat.createImage.imagesByChatId';
const LS_MODEL = 'chat.createImage.model.v1';

function clearStorage(): void {
  localStorage.removeItem(LS_CONSTANT);
  localStorage.removeItem(LS_IMAGES);
  localStorage.removeItem(LS_MODEL);
}

function makeImage(partial: Partial<NodeAttachment> = {}): NodeAttachment {
  return {
    id: 'img-1',
    name: 'memo.png',
    mimeType: 'image/png',
    size: 12,
    dataUrl: 'data:image/png;base64,QUJD',
    ...partial
  };
}

describe('CreateImageDialogService', () => {
  let service: CreateImageDialogService;

  beforeEach(() => {
    clearStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    });
    service = TestBed.inject(CreateImageDialogService);
  });

  afterEach(clearStorage);

  it('open() seeds from the per-chat store and resolves on submit', async () => {
    // A constant + reference images were persisted for chat-1 earlier.
    localStorage.setItem(LS_CONSTANT, JSON.stringify({ 'chat-1': 'noir ink drawing' }));
    localStorage.setItem(LS_IMAGES, JSON.stringify({
      'chat-1': [makeImage({ id: 'r1', dataUrl: 'data:image/png;base64,UkVG' })]
    }));

    const promise = service.open({
      chatId: 'chat-1',
      chat: null,
      node: makeNode({ role: 'assistant', content: 'A chapter.' }),
      script: 'the old tower',
      modelId: 'alpha/image',
      providerId: 'prov-1'
    });
    expect(service.current()).not.toBeNull();
    expect(service.current()?.constant).toBe('noir ink drawing');
    expect(service.current()?.script).toBe('the old tower');
    expect(service.current()?.images).toHaveLength(1);
    expect(service.current()?.modelId).toBe('alpha/image');

    service.submit({
      constant: '  watercolor, soft light  ',
      script: 'a ruined keep',
      images: [makeImage({ id: 'r2' })],
      modelId: 'beta/image',
      providerId: 'prov-1'
    });

    await expect(promise).resolves.toEqual({
      constant: '  watercolor, soft light  ',
      script: 'a ruined keep',
      images: [makeImage({ id: 'r2' })],
      modelId: 'beta/image',
      providerId: 'prov-1'
    });
    expect(service.current()).toBeNull();
    // The new constant + images were persisted for chat-1.
    expect(JSON.parse(localStorage.getItem(LS_CONSTANT)!)).toEqual({ 'chat-1': 'watercolor, soft light' });
    expect(JSON.parse(localStorage.getItem(LS_IMAGES)!)).toMatchObject({ 'chat-1': [{ id: 'r2' }] });
  });

  it('keeps the constant + images per chat (no leakage across chats)', async () => {
    // First submit stores for chat-1.
    const p1 = service.open({
      chatId: 'chat-1', chat: null, node: makeNode({ role: 'assistant' }), script: 'one',
      modelId: '', providerId: ''
    });
    service.submit({
      constant: 'only chat 1', script: 'one', images: [makeImage()], modelId: '', providerId: ''
    });
    await p1;

    // Opening for chat-2 must NOT see chat-1's constant/images.
    const p2 = service.open({
      chatId: 'chat-2', chat: null, node: makeNode({ role: 'assistant' }), script: 'two',
      modelId: '', providerId: ''
    });
    expect(service.current()?.constant).toBe('');
    expect(service.current()?.images).toHaveLength(0);
    service.cancel();
    await p2;

    // chat-1 still remembers its values.
    const p3 = service.open({
      chatId: 'chat-1', chat: null, node: makeNode({ role: 'assistant' }), script: 'one',
      modelId: '', providerId: ''
    });
    expect(service.current()?.constant).toBe('only chat 1');
    expect(service.current()?.images).toHaveLength(1);
    service.cancel();
    await p3;
  });

  it('cancel() resolves null without persisting', async () => {
    const promise = service.open({
      chatId: 'chat-1', chat: null, node: makeNode({ role: 'assistant' }), script: 'x',
      modelId: '', providerId: ''
    });
    service.cancel();

    await expect(promise).resolves.toBeNull();
    expect(service.current()).toBeNull();
    expect(localStorage.getItem(LS_CONSTANT)).toBeNull();
    expect(localStorage.getItem(LS_IMAGES)).toBeNull();
  });

  it('removes the persisted images for a chat when the set becomes empty', async () => {
    localStorage.setItem(LS_IMAGES, JSON.stringify({ 'chat-1': [makeImage()] }));
    const promise = service.open({
      chatId: 'chat-1', chat: null, node: makeNode({ role: 'assistant' }), script: 'x',
      modelId: '', providerId: ''
    });
    service.submit({
      constant: 'c', script: 'x', images: [], modelId: '', providerId: ''
    });
    await promise;
    expect(JSON.parse(localStorage.getItem(LS_IMAGES)!)).toEqual({});
  });

  it('remembers the last-selected model and prefers it on the next open', async () => {
    // The caller passes the settings default; the user then picks another model.
    const p1 = service.open({
      chatId: 'chat-1', chat: null, node: makeNode({ role: 'assistant' }), script: 'x',
      modelId: 'alpha/image', providerId: 'prov-1'
    });
    service.submit({
      constant: 'c', script: 'x', images: [], modelId: 'beta/image', providerId: 'prov-2'
    });
    await p1;

    // The chosen model is stored.
    expect(JSON.parse(localStorage.getItem(LS_MODEL)!)).toEqual({
      modelId: 'beta/image', providerId: 'prov-2'
    });

    // The next open (even with a different caller default) uses the remembered
    // model; the caller default is kept as the fallback.
    const p2 = service.open({
      chatId: 'chat-1', chat: null, node: makeNode({ role: 'assistant' }), script: 'y',
      modelId: 'alpha/image', providerId: 'prov-1'
    });
    expect(service.current()?.modelId).toBe('beta/image');
    expect(service.current()?.providerId).toBe('prov-2');
    expect(service.current()?.defaultModelId).toBe('alpha/image');
    expect(service.current()?.defaultProviderId).toBe('prov-1');
    service.cancel();
    await p2;
  });

  it('falls back to the caller default when no model was remembered yet', async () => {
    const promise = service.open({
      chatId: 'chat-1', chat: null, node: makeNode({ role: 'assistant' }), script: 'x',
      modelId: 'alpha/image', providerId: 'prov-1'
    });
    expect(service.current()?.modelId).toBe('alpha/image');
    expect(service.current()?.defaultModelId).toBe('alpha/image');
    service.cancel();
    await promise;
  });
});