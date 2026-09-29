import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { LightboxService } from '../../core/lightbox.service';
import { ImageLightboxComponent } from './image-lightbox.component';

describe('ImageLightboxComponent', () => {
  let fixture: ComponentFixture<ImageLightboxComponent>;
  let lightbox: LightboxService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ImageLightboxComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    lightbox = TestBed.inject(LightboxService);
    lightbox.close();
    fixture = TestBed.createComponent(ImageLightboxComponent);
    fixture.detectChanges();
  });

  it('hidden when the lightbox is closed', () => {
    expect(fixture.nativeElement.querySelector('.lightbox-backdrop')).toBeNull();
  });

  it('shows the selected image when opened', () => {
    lightbox.open(['data:image/png;base64,AAA', 'data:image/png;base64,BBB']);
    fixture.detectChanges();
    const backdrop = fixture.nativeElement.querySelector('.lightbox-backdrop');
    expect(backdrop).not.toBeNull();
    const img = fixture.nativeElement.querySelector('.lightbox-stage img');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(fixture.nativeElement.textContent).toContain('1 / 2');
  });

  it('navigates with the next button and updates the counter', () => {
    lightbox.open(['a', 'b', 'c']);
    fixture.detectChanges();
    const next = fixture.nativeElement.querySelector('.lightbox-nav.next');
    next.dispatchEvent(new Event('click'));
    fixture.detectChanges();
    expect(lightbox.current()!.index).toBe(1);
    const img = fixture.nativeElement.querySelector('.lightbox-stage img');
    expect(img.getAttribute('src')).toBe('b');
    expect(fixture.nativeElement.textContent).toContain('2 / 3');
  });

  it('closes on Escape and on backdrop click', () => {
    lightbox.open(['a']);
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(lightbox.current()).toBeNull();

    // Re-open and click the backdrop itself (not the image).
    lightbox.open(['a']);
    fixture.detectChanges();
    const backdrop = fixture.nativeElement.querySelector('.lightbox-backdrop');
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(lightbox.current()).toBeNull();
  });

  it('does not close when clicking inside the stage (not the backdrop)', () => {
    lightbox.open(['a']);
    fixture.detectChanges();
    const img = fixture.nativeElement.querySelector('.lightbox-stage img');
    img.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Target is the image, not the backdrop → stays open.
    expect(lightbox.current()).not.toBeNull();
  });
});