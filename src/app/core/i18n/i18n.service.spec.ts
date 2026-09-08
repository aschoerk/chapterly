import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';

describe('I18nService', () => {
  let i18n: I18nService;

  beforeEach(() => {
    localStorage.removeItem('chat.view.locale');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [I18nService] });
    i18n = TestBed.inject(I18nService);
    i18n.setLocale('en');
  });

  it('resolves nested keys and falls back to English', () => {
    expect(i18n.t('config.providers.empty')).toBe('No providers configured yet.');
    i18n.setLocale('de');
    expect(i18n.t('config.providers.empty')).toBe('Noch keine Anbieter eingerichtet.');
    expect(i18n.t('config.providers.missing.key')).toBe('config.providers.missing.key');
  });

  it('interpolates parameters', () => {
    i18n.setLocale('de');
    expect(i18n.t('config.models.modelWorks', { modelId: 'gpt-4o' }))
      .toBe('Modell \u201egpt-4o\u201c funktioniert');
  });

  it('persists the locale and exposes a BCP 47 tag for pipes', () => {
    i18n.setLocale('de');
    expect(localStorage.getItem('chat.view.locale')).toBe('de');
    expect(i18n.localeId()).toBe('de-DE');
    expect(i18n.formatNumber(1234.5, { maximumFractionDigits: 1 })).toMatch(/1\.234/);
  });
});
