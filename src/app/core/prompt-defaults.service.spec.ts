import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PromptDefaultsService } from './prompt-defaults.service';
import { PROMPT_DEFAULTS, promptDefaultById } from '../models/prompt-default';

describe('PromptDefaultsService', () => {
  let service: PromptDefaultsService;

  beforeEach(async () => {
    localStorage.removeItem('chat.promptDefaults');
    TestBed.resetTestingModule();
    service = TestBed.inject(PromptDefaultsService);
  });

  afterEach(() => {
    localStorage.removeItem('chat.promptDefaults');
  });

  it('exposes every catalogued default', () => {
    expect(service.all()).toEqual(PROMPT_DEFAULTS);
    expect(service.byCategory('image').length).toBeGreaterThan(0);
    expect(service.effective('structure.title')).toBe('Generate a concise title for this story.');
    expect(service.isCustom('structure.title')).toBe(false);
  });

  it('catalogues the director prepend instructions', () => {
    const withChars = service.effective('structure.prepend');
    const basic = service.effective('structure.prepend-basic');
    // Both direct the model to a first-person retelling of already-occurred events.
    expect(withChars).toContain('first person');
    expect(withChars).toContain('{{characters}}');
    expect(basic).toContain('first person');
    // Only the characters variant references the named characters.
    expect(basic).not.toContain('{{characters}}');
  });

  it('returns empty for an unknown id', () => {
    expect(service.effective('nope')).toBe('');
    expect(service.def('nope')).toBeUndefined();
  });

  it('persists overrides and reloads them', () => {
    service.update('structure.title', 'A short and catchy title');

    // A fresh instance reads the same stored override.
    const second = TestBed.inject(PromptDefaultsService);
    expect(second.effective('structure.title')).toBe('A short and catchy title');
    expect(second.isCustom('structure.title')).toBe(true);
  });

  it('render() substitutes placeholders and leaves unknown ones intact', () => {
    expect(service.render('structure.elaborate', { chapter: 4 }))
      .toBe('elaborate on chapter 4');
    const withName = service.render('structure.elaborate-view', { chapter: 2, name: 'Anna' });
    expect(withName).toBe(
      'elaborate on chapter 2 out of the view of Anna in first person. Do never repeat text verbatim from previous views in the same chapter.'
    );
    expect(service.render('image.storyboard', { index: 1, total: 3 })).toContain(
      'render picture 1 of 3'
    );
  });

  it('resetAll clears every customization', () => {
    service.update('structure.title', 'X');
    service.update('image.create', 'Y');
    expect(service.customized().length).toBe(2);
    service.resetAll();
    expect(service.customized().length).toBe(0);
    expect(service.effective('structure.title'))
      .toBe(promptDefaultById('structure.title')!.default);
    expect(service.effective('image.create'))
      .toBe(promptDefaultById('image.create')!.default);
  });
});