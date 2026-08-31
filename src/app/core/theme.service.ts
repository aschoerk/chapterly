import { Injectable, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const LS_THEME = 'chat.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(ThemeService.readStored());
  readonly resolved = signal<ResolvedTheme>('light');

  private readonly media: MediaQueryList | null =
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  constructor() {
    this.apply(this.preference());
    this.media?.addEventListener('change', () => {
      if (this.preference() === 'system') this.apply('system');
    });
  }

  setPreference(preference: ThemePreference): void {
    this.preference.set(preference);
    localStorage.setItem(LS_THEME, preference);
    this.apply(preference);
  }

  private apply(preference: ThemePreference): void {
    const resolved: ResolvedTheme =
      preference === 'system'
        ? (this.media?.matches ? 'dark' : 'light')
        : preference;
    this.resolved.set(resolved);
    const root = document.documentElement;
    root.dataset['theme'] = resolved;
    root.style.colorScheme = resolved;
  }

  private static readStored(): ThemePreference {
    const raw = localStorage.getItem(LS_THEME);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
    return 'system';
  }
}
