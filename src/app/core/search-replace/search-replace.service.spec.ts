import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SearchReplaceService, SearchReplaceSession } from './search-replace.service';
import { SearchUnit } from './search-replace.service';

function sessionTestBed(): SearchReplaceService {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), SearchReplaceService],
  });
  return TestBed.inject(SearchReplaceService);
}

/** A minimal session with a fixed set of units. */
function fakeSession(units: SearchUnit[]): SearchReplaceSession {
  const applied: { key: string; text: string }[] = [];
  const session: SearchReplaceSession = {
    scopes: () => [
      { id: 'node', labelKey: 'search.scope.node' },
      { id: 'chat', labelKey: 'search.scope.chat' },
    ],
    unitsFor: (scope) => (scope === 'node' ? units.slice(0, 1) : units),
    navigate: () => {},
    apply: async (updates) => {
      applied.push(...updates);
    },
  };
  (session as any).applied = applied;
  return session;
}

describe('SearchReplaceService', () => {
  let service: SearchReplaceService;

  beforeEach(() => {
    service = sessionTestBed();
  });

  it('finds no occurrences before a term is set', () => {
    service.setSession(fakeSession([{ key: 'a', text: 'hello world' }]));
    expect(service.total()).toBe(0);
    service.setTerm('hello');
    expect(service.total()).toBe(1);
  });

  it('counts occurrences across all units in the current scope', () => {
    const session = fakeSession([
      { key: 'a', text: 'cat dog' },
      { key: 'b', text: 'cat' },
      { key: 'c', text: 'parrot' },
    ]);
    service.setSession(session);
    service.setTerm('cat');
    expect(service.scope()).toBe('node');
    // node scope → only the first unit
    expect(service.total()).toBe(1);
    service.setScope('chat');
    expect(service.total()).toBe(2);
  });

  it('recognises whole-word and case-sensitive options', () => {
    service.setSession(fakeSession([{ key: 'a', text: 'Cat cat scatter' }]));
    service.setTerm('cat');
    expect(service.total()).toBe(3); // Cat + cat + inside 'scatter'
    service.setWholeWord(true);
    expect(service.total()).toBe(2); // only whole-word Cat + cat
    service.setCaseSensitive(true);
    expect(service.total()).toBe(1); // only lowercase cat
  });

  it('supports regex search and surfaces invalid patterns', () => {
    service.setSession(fakeSession([{ key: 'a', text: 'v1=1;v2=2;' }]));
    service.setUseRegex(true);
    service.setTerm('=(\\d+);');
    expect(service.total()).toBe(2);
    service.setTerm('(');
    expect(service.invalidRegex()).toBe(true);
    expect(service.total()).toBe(0);
  });

  it('navigates next/prev with wrap-around', () => {
    const nav: string[] = [];
    service.setSession({
      scopes: () => [{ id: 'chat', labelKey: 'search.scope.chat' }],
      unitsFor: () => [{ key: 'a', text: 'x x x' }],
      navigate: (occ) => nav.push(occ.unit.key + ':' + occ.match.start),
      apply: async () => {},
    });
    service.setScope('chat');
    service.setTerm('x');
    expect(service.currentIndex()).toBe(0);
    service.findNext();
    expect(service.currentIndex()).toBe(1);
    service.findNext();
    expect(service.currentIndex()).toBe(2);
    service.findNext();
    expect(service.currentIndex()).toBe(0); // wraps
    service.findPrev();
    expect(service.currentIndex()).toBe(2); // wraps back
  });

  it('replaceCurrent persists the updated unit and continues', async () => {
    const session = fakeSession([{ key: 'a', text: 'a b a' }]);
    service.setSession(session);
    service.setTerm('a');
    service.setReplaceTerm('X');
    await service.replaceCurrent();
    const applied = (session as any).applied as { key: string; text: string }[];
    expect(applied).toEqual([{ key: 'a', text: 'X b a' }]);
  });

  it('replaceAndFindNext moves to the next match after replacing', async () => {
    const session = fakeSession([{ key: 'a', text: 'a a' }]);
    service.setSession(session);
    service.setTerm('a');
    service.setReplaceTerm('X');
    await service.replaceAndFindNext();
    const applied = (session as any).applied as { key: string; text: string }[];
    expect(applied).toEqual([{ key: 'a', text: 'X a' }]);
    expect(service.currentIndex()).toBe(1);
  });

  it('replaceAll replaces every match across all units', async () => {
    const session = fakeSession([
      { key: 'a', text: 'apple pie' },
      { key: 'b', text: 'apple' },
    ]);
    service.setSession(session);
    service.setScope('chat');
    service.setTerm('apple');
    service.setReplaceTerm('pear');
    await service.replaceAll();
    const applied = (session as any).applied as { key: string; text: string }[];
    expect(applied).toContainEqual({ key: 'a', text: 'pear pie' });
    expect(applied).toContainEqual({ key: 'b', text: 'pear' });
  });

  it('replaceAll expands regex groups', async () => {
    const session = fakeSession([{ key: 'a', text: 'v1=1;' }]);
    service.setSession(session);
    service.setUseRegex(true);
    service.setTerm('=(\\d+);');
    service.setReplaceTerm('=$1$1;');
    await service.replaceAll();
    const applied = (session as any).applied as { key: string; text: string }[];
    expect(applied).toContainEqual({ key: 'a', text: 'v1=11;' });
  });
});