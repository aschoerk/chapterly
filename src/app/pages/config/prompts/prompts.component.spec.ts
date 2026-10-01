import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { PromptsComponent } from './prompts.component';
import { PromptDefaultsService } from '../../../core/prompt-defaults.service';
import { PROMPT_DEFAULTS } from '../../../models/prompt-default';

describe('PromptsComponent', () => {
  let fixture: ComponentFixture<PromptsComponent>;
  let component: PromptsComponent;
  let defaults: PromptDefaultsService;

  beforeEach(async () => {
    localStorage.removeItem('chat.promptDefaults');
    await TestBed.configureTestingModule({
      imports: [PromptsComponent],
      providers: [provideZonelessChangeDetection()]
    }).compileComponents();

    defaults = TestBed.inject(PromptDefaultsService);

    fixture = TestBed.createComponent(PromptsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.removeItem('chat.promptDefaults');
  });

  it('renders every prompt default with its built-in text', () => {
    const native = fixture.nativeElement as HTMLElement;
    const text = native.textContent ?? '';
    // Category headings.
    expect(text).toContain('Structure & writing');
    expect(text).toContain('Image generation');
    expect(text).toContain('Language');
    // Textarea values hold the built-in defaults (set via [ngModel], so they
    // are NOT part of textContent).
    const values = Array.from(native.querySelectorAll<HTMLTextAreaElement>('textarea'))
      .map(t => t.value);
    for (const def of PROMPT_DEFAULTS) {
      expect(text).toContain(def.label);
      expect(values.some(v => v.startsWith(def.default.slice(0, 40)))).toBe(true);
    }
  });

  it('edits a template and marks it customized; Reset restores the default', () => {
    const textarea = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();

    component.onInput('structure.title', 'Give this story a punchy title.');
    fixture.detectChanges();

    expect(defaults.effective('structure.title')).toBe('Give this story a punchy title.');
    expect(defaults.isCustom('structure.title')).toBe(true);
    expect(component.customizedCount()).toBe(1);
    // Persisted.
    const stored = JSON.parse(localStorage.getItem('chat.promptDefaults') ?? '{}');
    expect(stored['structure.title']).toBe('Give this story a punchy title.');

    component.reset('structure.title');
    fixture.detectChanges();
    expect(defaults.effective('structure.title')).toBe(
      PROMPT_DEFAULTS.find(d => d.id === 'structure.title')!.default
    );
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(component.customizedCount()).toBe(0);
  });

  it('restores the default when the user types the exact default text', () => {
    const def = PROMPT_DEFAULTS.find(d => d.id === 'structure.title')!;
    component.onInput('structure.title', 'Custom');
    expect(defaults.isCustom('structure.title')).toBe(true);

    // Typing the exact default clears the override.
    component.onInput('structure.title', def.default);
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(defaults.effective('structure.title')).toBe(def.default);
  });

  it('Reset all clears every customization', () => {
    component.onInput('structure.title', 'T1');
    component.onInput('image.create', 'Draw differently.');
    fixture.detectChanges();
    expect(component.customizedCount()).toBe(2);

    component.resetAll();
    fixture.detectChanges();
    expect(component.customizedCount()).toBe(0);
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(defaults.isCustom('image.create')).toBe(false);
  });

  it('render() fills placeholders from the effective template', () => {
    defaults.update('structure.elaborate', 'Chapter {{chapter}} — go!');
    expect(defaults.render('structure.elaborate', { chapter: 7 }))
      .toBe('Chapter 7 — go!');

    // Default template keeps the built-in placeholders working.
    defaults.reset('structure.elaborate');
    expect(defaults.render('structure.elaborate', { chapter: 3 }))
      .toBe('elaborate on chapter 3');
  });
});