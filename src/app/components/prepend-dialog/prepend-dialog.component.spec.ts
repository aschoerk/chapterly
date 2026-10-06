import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { PrependDialogService } from '../../core/prepend-dialog.service';
import { PrependDialogComponent } from './prepend-dialog.component';

describe('PrependDialogComponent', () => {
  let fixture: ComponentFixture<PrependDialogComponent>;
  let component: PrependDialogComponent;
  let dialog: PrependDialogService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PrependDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    dialog = TestBed.inject(PrependDialogService);
    fixture = TestBed.createComponent(PrependDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is hidden when the dialog is closed', () => {
    expect(fixture.nativeElement.querySelector('.prepend-dialog')).toBeNull();
  });

  it('shows the proposed director text prefilled for editing', async () => {
    const p = dialog.open('Narrate how these events came to be as an outside first person.', false);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(fixture.nativeElement.querySelector('.prepend-dialog')).not.toBeNull();
    expect(textarea).not.toBeNull();
    expect(textarea.value).toContain('Narrate how these events came to be');

    dialog.cancel();
    await p;
  });

  it('uses the edit hint when a director already exists', async () => {
    const p = dialog.open('existing text', true);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Edit the director instruction');
    dialog.cancel();
    await p;
  });

  it('submit resolves with the edited text and closes', async () => {
    const p = dialog.open('original director text', false);
    fixture.detectChanges();

    component.text.set('My edited first-person director instruction.');
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toBe('My edited first-person director instruction.');
    expect(fixture.nativeElement.querySelector('.prepend-dialog')).toBeNull();
  });

  it('submit with empty text clears the director', async () => {
    const p = dialog.open('original director text', true);
    fixture.detectChanges();

    component.text.set('');
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toBe('');
  });

  it('cancel resolves null without closing state changes', async () => {
    const p = dialog.open('original', false);
    fixture.detectChanges();
    dialog.cancel();
    await expect(p).resolves.toBeNull();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.prepend-dialog')).toBeNull();
  });

  it('Escape closes the dialog and resolves null (same as cancel)', async () => {
    const p = dialog.open('original', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.prepend-dialog')).not.toBeNull();

    component.onDocumentKey({
      key: 'Escape',
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent);
    fixture.detectChanges();

    await expect(p).resolves.toBeNull();
    expect(fixture.nativeElement.querySelector('.prepend-dialog')).toBeNull();
  });

  it('ignores Escape while the dialog is closed', () => {
    const preventDefault = vi.fn();
    component.onDocumentKey({ key: 'Escape', preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.prepend-dialog')).toBeNull();
  });
});