import { Injectable, computed, signal } from '@angular/core';
import { EN } from './catalog-en';
import { DE } from './catalog-de';

export type AppLocale = 'en' | 'de';

const LS_LOCALE = 'chat.view.locale';
const CATALOGS: Record<AppLocale, Record<string, unknown>> = { en: EN, de: DE };

function detectLocale(): AppLocale {
  const stored = localStorage.getItem(LS_LOCALE);
  if (stored === 'en' || stored === 'de') return stored;
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('de') ? 'de' : 'en';
}

function lookup(tree: Record<string, unknown>, path: string): string | undefined {
  let cur: unknown = tree;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{\{\w+\}\}/g, (match) => {
    const key = match.slice(2, -2);
    return params[key] === undefined ? match : String(params[key]);
  });
}

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly locale = signal<AppLocale>(detectLocale());
  /** BCP 47 tag for DatePipe / DecimalPipe / Intl. */
  readonly localeId = computed(() => (this.locale() === 'de' ? 'de-DE' : 'en-US'));

  readonly locales: { id: AppLocale; label: string }[] = [
    { id: 'en', label: 'English' },
    { id: 'de', label: 'Deutsch' }
  ];

  constructor() {
    this.applyDocumentLang(this.locale());
  }

  setLocale(locale: AppLocale): void {
    this.locale.set(locale);
    localStorage.setItem(LS_LOCALE, locale);
    this.applyDocumentLang(locale);
  }

  t(key: string, params?: Record<string, string | number>): string {
    const raw =
      lookup(CATALOGS[this.locale()], key) ??
      lookup(CATALOGS.en, key) ??
      key;
    return interpolate(raw, params);
  }

  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.localeId(), options).format(value);
  }

  formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(this.localeId(), options).format(date);
  }

  private applyDocumentLang(locale: AppLocale): void {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = locale === 'de' ? 'de' : 'en';
  }
}
