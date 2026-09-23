import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AppearanceComponent } from './appearance.component';
import { ThemeService } from '../../../core/theme.service';
import { I18nService } from '../../../core/i18n/i18n.service';

describe('AppearanceComponent', () => {
  let fixture: ComponentFixture<AppearanceComponent>;
  let component: AppearanceComponent;

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
    localStorage.removeItem('chat.theme');
    localStorage.removeItem('chat.view.locale');

    await TestBed.configureTestingModule({
      imports: [AppearanceComponent],
      providers: [provideZonelessChangeDetection()]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');

    fixture = TestBed.createComponent(AppearanceComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders theme and language pickers', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Appearance');
    expect(text).toContain('English');
  });

  it('switches settings chrome to German', () => {
    component.i18n.setLocale('de');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Darstellung');
    expect(text).toContain('Stories, Eingaben und Modellantworten bleiben unverändert.');
  });

  it('stores the theme preference without touching the server', () => {
    const theme = TestBed.inject(ThemeService);
    component.theme.setPreference('dark');

    expect(theme.preference()).toBe('dark');
    expect(theme.resolved()).toBe('dark');
    expect(localStorage.getItem('chat.theme')).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});