import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode } from '../../../../test-helpers/factories';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings.service';
import { CreateImageDialogService } from '../../core/create-image-dialog.service';
import { CreateImageDialogComponent } from './create-image-dialog.component';

describe('CreateImageDialogComponent', () => {
  let fixture: ComponentFixture<CreateImageDialogComponent>;
  let component: CreateImageDialogComponent;
  let dialog: CreateImageDialogService;

  function openState() {
    return dialog.open({
      chatId: 'chat-1',
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 1, created_at: '', updated_at: '' },
      node: makeNode({ id: 'a1', role: 'assistant', content: 'The hero enters the old tower.' }),
      script: 'the old tower',
      modelId: 'alpha/image',
      providerId: 'prov-1'
    });
  }

  beforeEach(async () => {
    localStorage.clear();
    const api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        {
          id: 'm-img', displayName: 'Image Cap', modelId: 'alpha/image',
          architecture: { input_modalities: ['text'], output_modalities: ['image'] }
        },
        {
          id: 'm-txt', displayName: 'Texter', modelId: 'beta/text',
          architecture: { input_modalities: ['text'], output_modalities: ['text'] }
        }
      ]
    });
    await TestBed.configureTestingModule({
      imports: [CreateImageDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    dialog = TestBed.inject(CreateImageDialogService);
    fixture = TestBed.createComponent(CreateImageDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is hidden when the dialog is closed', () => {
    expect(fixture.nativeElement.querySelector('.cimg-dialog')).toBeNull();
  });

  it('opens prefilled with the per-chat constant, marked text, model and reference images', async () => {
    localStorage.setItem('chat.createImage.constantByChatId', JSON.stringify({ 'chat-1': 'noir ink drawing' }));
    localStorage.setItem('chat.createImage.imagesByChatId', JSON.stringify({
      'chat-1': [{ id: 'r1', name: 'memo.png', mimeType: 'image/png', size: 12, dataUrl: 'data:image/png;base64,UkVG' }]
    }));

    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cimg-dialog')).not.toBeNull();
    expect(component.constant()).toBe('noir ink drawing');
    expect(component.script()).toBe('the old tower');
    expect(component.modelId()).toBe('alpha/image');
    expect(component.images()).toHaveLength(1);

    const textareas = fixture.nativeElement.querySelectorAll('textarea') as NodeListOf<HTMLTextAreaElement>;
    expect(textareas[0].value).toBe('noir ink drawing');
    expect(textareas[1].value).toBe('the old tower');
    dialog.cancel();
    await p;
  });

  it('lists only image-capable models in the select', async () => {
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const options = Array.from(fixture.nativeElement.querySelectorAll('select option')) as HTMLOptionElement[];
    const values = options.map(o => o.value);
    expect(values).toContain('alpha/image');
    expect(values).not.toContain('beta/text');
    dialog.cancel();
    await p;
  });

  it('keeps providerId in sync when the model changes', async () => {
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.onModelChange('alpha/image');
    expect(component.providerId()).toBe('prov-1');
    dialog.cancel();
    await p;
  });

  it('submit() resolves the combined values; alerts when both text and images are empty', async () => {
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    component.constant.set('');
    component.script.set('');
    component.images.set([]);
    component.submit();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Nothing to send'));
    expect(component.combinedPrompt()).toBe('');

    // With text (or an image) it resolves.
    component.script.set('a ruined keep');
    component.submit();
    const result = await p;
    expect(result).toEqual({
      constant: '',
      script: 'a ruined keep',
      images: [],
      modelId: 'alpha/image',
      providerId: 'prov-1'
    });
    expect(component.combinedPrompt()).toBe('a ruined keep');
  });

  it('cancel() resolves null', async () => {
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    dialog.cancel();
    await expect(p).resolves.toBeNull();
    expect(component.images()).toHaveLength(0);
  });
});