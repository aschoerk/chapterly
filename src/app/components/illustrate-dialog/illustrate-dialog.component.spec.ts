import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { IllustrateDialogService } from '../../core/illustrate-dialog.service';
import { IllustrateDialogComponent } from './illustrate-dialog.component';

describe('IllustrateDialogComponent', () => {
  let fixture: ComponentFixture<IllustrateDialogComponent>;
  let component: IllustrateDialogComponent;
  let dialog: IllustrateDialogService;

  beforeEach(async () => {
    localStorage.removeItem('chat.illustrateOptions.v1');
    await TestBed.configureTestingModule({
      imports: [IllustrateDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    dialog = TestBed.inject(IllustrateDialogService);
    fixture = TestBed.createComponent(IllustrateDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('hidden when the dialog is closed', () => {
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).toBeNull();
  });

  it('shows count/style and hides storyboard rules for count 1', async () => {
    const p = dialog.open();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).not.toBeNull();

    // Storyboard rules are only shown for >1.
    expect(fixture.nativeElement.textContent).not.toContain('Storyboard rules');

    dialog.cancel();
    await p;
  });

  it('reveals storyboard rules when the count is raised above 1', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    component.count.set(12);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Storyboard rules');

    dialog.cancel();
    await p;
  });

  it('submit resolves with the entered values and closes', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    component.count.set(2);
    component.style.set('comic style');
    component.storyboardPrompt.set('no explicit images');
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toEqual({
      count: 2,
      style: 'comic style',
      storyboardPrompt: 'no explicit images',
      purePictures: false
    });
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).toBeNull();
  });

  it('toggles pure picture mode and submits it', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    const checkbox = fixture.nativeElement.querySelector('.ill-check input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    component.purePictures.set(true);
    fixture.detectChanges();
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toMatchObject({ purePictures: true });
  });

  it('seeds pure picture mode from the last-used options', async () => {
    dialog.submit({ count: 1, style: '', storyboardPrompt: '', purePictures: true });
    dialog.open();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.purePictures()).toBe(true);
    const checkbox = fixture.nativeElement.querySelector('.ill-check input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox?.checked).toBe(true);
    dialog.cancel();
  });

  it('shows the pure picture mode checkbox and its hint', async () => {
    dialog.open();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Pure picture mode');
    expect(text).toContain('never the raw story text');
    dialog.cancel();
  });

  it('cancel closes and resolves null', async () => {
    const p = dialog.open();
    fixture.detectChanges();
    dialog.cancel();
    fixture.detectChanges();
    await expect(p).resolves.toBeNull();
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).toBeNull();
  });
});