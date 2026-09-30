import { Injectable, signal, WritableSignal } from '@angular/core';

export type SortMode = 'alpha' | 'updated';

export interface SortPrefs {
  mode: SortMode;
  alphaAsc: boolean;
  updatedDesc: boolean;
}

interface SortPrefsGroup {
  mode: WritableSignal<SortMode>;
  alphaAsc: WritableSignal<boolean>;
  updatedDesc: WritableSignal<boolean>;
}

const LS_SORT = 'chat.sort.prefs';

/** Default ordering: by age, newest first (most recent on top). */
const DEFAULT_PREFS: SortPrefs = { mode: 'updated', alphaAsc: true, updatedDesc: true };

/**
 * Per-page list-sorting preferences (sidebar, Topics page, Projects page).
 *
 * Each page keeps its own list-sort (A–Z / Z–A, newest / oldest first).
 * The pages are separate components that are created and destroyed on
 * navigation, so the sort state is shared through this service and persisted
 * to localStorage. That way switching between pages preserves each page's
 * ordering; pages without a stored preference fall back to the default
 * (by age, newest first).
 */
@Injectable({ providedIn: 'root' })
export class SortPreferencesService {
  private readonly groups = new Map<string, SortPrefsGroup>();
  private readonly prefs: Record<string, SortPrefs> = this.readStored();

  /** The sort-mode signal for a page (created on first use). */
  modeFor(page: string): WritableSignal<SortMode> {
    return this.groupFor(page).mode;
  }

  /** The alphabetical-direction signal for a page (created on first use). */
  alphaAscFor(page: string): WritableSignal<boolean> {
    return this.groupFor(page).alphaAsc;
  }

  /** The age-direction signal for a page (created on first use). */
  updatedDescFor(page: string): WritableSignal<boolean> {
    return this.groupFor(page).updatedDesc;
  }

  setMode(page: string, mode: SortMode): void {
    this.groupFor(page).mode.set(mode);
    this.persist(page);
  }

  setAlphaAsc(page: string, value: boolean): void {
    this.groupFor(page).alphaAsc.set(value);
    this.persist(page);
  }

  setUpdatedDesc(page: string, value: boolean): void {
    this.groupFor(page).updatedDesc.set(value);
    this.persist(page);
  }

  private groupFor(page: string): SortPrefsGroup {
    let group = this.groups.get(page);
    if (!group) {
      const saved = this.prefs[page] ?? { ...DEFAULT_PREFS };
      group = {
        mode: signal(saved.mode),
        alphaAsc: signal(saved.alphaAsc),
        updatedDesc: signal(saved.updatedDesc),
      };
      this.groups.set(page, group);
    }
    return group;
  }

  private persist(page: string): void {
    const group = this.groups.get(page);
    if (!group) return;
    this.prefs[page] = {
      mode: group.mode(),
      alphaAsc: group.alphaAsc(),
      updatedDesc: group.updatedDesc(),
    };
    try {
      localStorage.setItem(LS_SORT, JSON.stringify(this.prefs));
    } catch {
      /* ignore */
    }
  }

  private readStored(): Record<string, SortPrefs> {
    try {
      const raw = localStorage.getItem(LS_SORT);
      return raw ? (JSON.parse(raw) as Record<string, SortPrefs>) : {};
    } catch {
      return {};
    }
  }
}