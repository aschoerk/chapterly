/**
 * search-replace.service.ts
 *
 * Shared state + controller for the search/replace dialog. Used by both the
 * chat page (scopes: node / chat) and the reader page (scope: reader). The
 * ACTIVE page registers a SearchReplaceSession that maps a scope to text
 * units (nodes) and knows how to navigate to / persist a match.
 *
 * The service is intentionally small: the adapter owns everything page
 * specific (which nodes belong to a scope, how to scroll to a node, and how
 * to write a replacement back through the API).
 */
import { Injectable, computed, signal } from '@angular/core';
import {
  SearchMatch,
  SearchOptions,
  findAll,
  isValidRegex,
  replaceAllInText,
  replaceOneMatch,
} from './search-utils';

export type SearchScopeId = 'node' | 'chat' | 'reader';

export interface SearchScopeDef {
  id: SearchScopeId;
  labelKey: string;
}

/** One searchable text unit, typically a chat node's content. */
export interface SearchUnit {
  /** Stable identity (node id). */
  key: string;
  /** The raw text that gets searched. */
  text: string;
}

/** A single occurrence of the search term inside a unit plus which unit. */
export interface SearchOccurrence {
  unit: SearchUnit;
  match: SearchMatch;
  /** 0-based index of this occurrence within its unit (for DOM highlighting). */
  localNth: number;
}

export interface SearchReplaceUpdate {
  key: string;
  text: string;
}

/** Page-provided glue that connects the dialog to the real node tree. */
export interface SearchReplaceSession {
  /** Available scopes in the order they appear in the selector. */
  scopes(): SearchScopeDef[];
  /** Units that belong to a given scope (reactive). */
  unitsFor(scope: SearchScopeId): SearchUnit[];
  /**
   * Navigate to + highlight the current occurrence. `occ.localNth` is the
   * occurrence's index within the unit, so the page can mark exactly one
   * match as current.
   */
  navigate(occ: SearchOccurrence): void;
  /** Persist replacement(s) for the given units. */
  apply(updates: SearchReplaceUpdate[]): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class SearchReplaceService {
  readonly open = signal(false);
  readonly term = signal('');
  readonly replaceTerm = signal('');

  readonly caseSensitive = signal(false);
  readonly wholeWord = signal(false);
  readonly useRegex = signal(false);

  private readonly session = signal<SearchReplaceSession | null>(null);
  readonly scope = signal<SearchScopeId>('node');
  readonly currentIndex = signal(0);

  /** Register the active page's session (called on init / destroy). */
  setSession(session: SearchReplaceSession | null): void {
    this.session.set(session);
    this.currentIndex.set(0);
    const scopes = session?.scopes() ?? [];
    // Reset to the first available scope when a new page registers.
    if (scopes.length > 0 && !scopes.some((s) => s.id === this.scope())) {
      this.scope.set(scopes[0].id);
    } else if (scopes.length === 0) {
      this.scope.set('node');
    }
  }

  readonly scopes = computed(() => this.session()?.scopes() ?? []);

  readonly options = computed<SearchOptions>(() => ({
    caseSensitive: this.caseSensitive(),
    wholeWord: this.wholeWord(),
    useRegex: this.useRegex(),
  }));

  /** True when regex mode is on but the term is not a valid pattern. */
  readonly invalidRegex = computed(
    () => this.useRegex() && !isValidRegex(this.term())
  );

  /** All occurrences across the current scope's units (document order). */
  readonly occurrences = computed<SearchOccurrence[]>(() => {
    const term = this.term().trim();
    if (!term) return [];
    const opts = this.options();
    const units = this.session()?.unitsFor(this.scope()) ?? [];
    const out: SearchOccurrence[] = [];
    for (const unit of units) {
      const matches = findAll(unit.text, term, opts);
      for (let nth = 0; nth < matches.length; nth++) {
        out.push({ unit, match: matches[nth], localNth: nth });
      }
    }
    return out;
  });

  readonly total = computed(() => this.occurrences().length);

  /** Clamped current occurrence (or null when there are none). */
  readonly current = computed<SearchOccurrence | null>(() => {
    const list = this.occurrences();
    if (list.length === 0) return null;
    const i = Math.min(Math.max(this.currentIndex(), 0), list.length - 1);
    return list[i];
  });

  openDialog(): void {
    this.open.set(true);
    this.currentIndex.set(0);
  }

  close(): void {
    this.open.set(false);
  }

  toggleOpen(): void {
    this.open.set(!this.open());
  }

  setTerm(term: string): void {
    this.term.set(term);
    this.currentIndex.set(0);
  }

  setReplaceTerm(term: string): void {
    this.replaceTerm.set(term);
  }

  setCaseSensitive(on: boolean): void {
    this.caseSensitive.set(on);
    this.currentIndex.set(0);
  }

  setWholeWord(on: boolean): void {
    this.wholeWord.set(on);
    this.currentIndex.set(0);
  }

  setUseRegex(on: boolean): void {
    this.useRegex.set(on);
    this.currentIndex.set(0);
  }

  setScope(scope: SearchScopeId): void {
    this.scope.set(scope);
    this.currentIndex.set(0);
  }

  /** Find the next occurrence (wrap-around). Always navigates to it. */
  findNext(): void {
    const list = this.occurrences();
    if (list.length === 0) return;
    const next = (this.currentIndex() + 1) % list.length;
    this.currentIndex.set(next);
    this.navigateToCurrent();
  }

  findPrev(): void {
    const list = this.occurrences();
    if (list.length === 0) return;
    const prev = (this.currentIndex() - 1 + list.length) % list.length;
    this.currentIndex.set(prev);
    this.navigateToCurrent();
  }

  /** Highlight/scoll the current occurrence in the page. */
  navigateToCurrent(): void {
    const occ = this.current();
    if (!occ) return;
    this.session()?.navigate(occ);
  }

  async replaceCurrent(): Promise<void> {
    const occ = this.current();
    if (!occ || !this.term().trim()) return;
    const opts = this.options();
    const newText = replaceOneMatch(occ.unit.text, occ.match, this.replaceTerm(), opts);
    await this.commitAndResume(occ, newText, occ.match.start);
  }

  async replaceAndFindNext(): Promise<void> {
    const occ = this.current();
    if (!occ || !this.term().trim()) return;
    const opts = this.options();
    const newText = replaceOneMatch(occ.unit.text, occ.match, this.replaceTerm(), opts);
    await this.commitAndResume(occ, newText, occ.match.start);
    this.findNext();
  }

  async replaceAll(): Promise<void> {
    const list = this.occurrences();
    if (list.length === 0) return;
    const opts = this.options();
    const byKey = new Map<string, string>();
    for (const occ of list) {
      const unit = occ.unit;
      const current = byKey.get(unit.key) ?? unit.text;
      byKey.set(unit.key, replaceAllInText(current, this.term().trim(), this.replaceTerm(), opts).text);
    }
    const updates = [...byKey.entries()].map(([key, text]) => ({ key, text }));
    await this.session()?.apply(updates);
    this.currentIndex.set(0);
  }

  /**
   * Apply a single-unit replacement, keep the dialog in sync, and position
   * the cursor on the occurrence that follows the replaced range.
   */
  private async commitAndResume(
    occ: SearchOccurrence,
    newText: string,
    replacedStart: number
  ): Promise<void> {
    await this.session()?.apply([{ key: occ.unit.key, text: newText }]);
    // After apply() the units change, so the occurrence list is stale. Pick
    // the first occurrence at/after the replaced range so the user continues
    // where they left off.
    const list = this.occurrences();
    if (list.length === 0) {
      this.currentIndex.set(0);
      return;
    }
    let next = list.findIndex((o) => o.unit.key !== occ.unit.key || o.match.start >= replacedStart);
    if (next === -1) next = 0;
    this.currentIndex.set(next);
  }
}