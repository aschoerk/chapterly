import { describe, it, expect } from 'vitest';
import {
  buildSearchRegExp,
  defaultSearchOptions,
  expandReplace,
  findAll,
  highlightMatchesIn,
  isValidRegex,
  replaceAllInText,
  replaceOneMatch,
} from './search-utils';

const opts = defaultSearchOptions();

describe('buildSearchRegExp', () => {
  it('escapes literal text in non-regex mode', () => {
    const re = buildSearchRegExp('a.b', { ...opts, useRegex: false });
    expect(re).not.toBeNull();
    // 'a.b' must match literally, not as a wildcard
    expect(re!.test('axb')).toBe(false);
    expect(re!.test('a.b')).toBe(true);
  });

  it('uses the raw pattern in regex mode', () => {
    const re = buildSearchRegExp('a.b', { ...opts, useRegex: true });
    expect(re!.test('axb')).toBe(true);
  });

  it('returns null for empty term', () => {
    expect(buildSearchRegExp('', opts)).toBeNull();
  });

  it('returns null for an invalid regex', () => {
    expect(buildSearchRegExp('(', { ...opts, useRegex: true })).toBeNull();
  });

  it('adds word boundaries in whole-word mode', () => {
    const re = buildSearchRegExp('cat', { ...opts, wholeWord: true });
    expect(re!.test('scat')).toBe(false);
    expect(re!.test('cat')).toBe(true);
    expect(re!.test('the cat sat')).toBe(true);
  });

  it('is case-insensitive by default', () => {
    const re = buildSearchRegExp('Cat', opts);
    expect(re!.test('cat')).toBe(true);
  });

  it('respects case sensitivity', () => {
    const re = buildSearchRegExp('Cat', { ...opts, caseSensitive: true });
    expect(re!.test('cat')).toBe(false);
    expect(re!.test('Cat')).toBe(true);
  });
});

describe('isValidRegex', () => {
  it('accepts real patterns and rejects garbage', () => {
    expect(isValidRegex('\\d+')).toBe(true);
    expect(isValidRegex('(')).toBe(false);
  });
});

describe('findAll', () => {
  it('finds all matches with offsets and lengths', () => {
    const ms = findAll('aaa bbb aaa', 'aaa', opts);
    expect(ms.map((m) => [m.start, m.length, m.text])).toEqual([
      [0, 3, 'aaa'],
      [8, 3, 'aaa'],
    ]);
  });

  it('returns [] for empty term', () => {
    expect(findAll('text', '', opts)).toEqual([]);
  });

  it('returns [] for invalid regex', () => {
    expect(findAll('text', '(', { ...opts, useRegex: true })).toEqual([]);
  });

  it('captures regex groups', () => {
    const ms = findAll('hello 2024 goodbye', '(\\d+)-(\\d+)', {
      ...opts,
      useRegex: true,
    });
    expect(ms).toEqual([]);
    const grouped = findAll('12-34', '(\\d+)-(\\d+)', { ...opts, useRegex: true });
    expect(grouped[0].groups).toEqual(['12', '34']);
  });

  it('end-to-end group capture into matches', () => {
    const ms = findAll('price: 12 euros', 'price: (\\d+) euros', {
      ...opts,
      useRegex: true,
    });
    expect(ms.length).toBe(1);
    expect(ms[0].groups).toEqual(['12']);
    expect(ms[0].start).toBe(0);
    expect(ms[0].length).toBe('price: 12 euros'.length);
  });
});

describe('expandReplace', () => {
  const m = { text: '12-34', groups: ['12', '34'], prefix: 'hi ', suffix: ' bye' };

  it('keeps $ literal when not in regex mode', () => {
    expect(expandReplace('$1', m, false)).toBe('$1');
  });

  it('expands groups in regex mode', () => {
    expect(expandReplace('$2-$1', m, true)).toBe('34-12');
    expect(expandReplace('$1', m, true)).toBe('12');
  });

  it('supports $& and $0 for the whole match', () => {
    expect(expandReplace('[$&]', m, true)).toBe('[12-34]');
    expect(expandReplace('$0', m, true)).toBe('12-34');
  });

  it('supports $$ for a literal dollar', () => {
    expect(expandReplace('$$', m, true)).toBe('$');
  });

  it('supports prefix/suffix references', () => {
    expect(expandReplace('$`', m, true)).toBe('hi ');
    expect(expandReplace("$'", m, true)).toBe(' bye');
  });

  it('uses empty string for missing groups', () => {
    expect(expandReplace('a$9b', m, true)).toBe('ab');
  });
});

describe('replaceOneMatch', () => {
  it('replaces a single match at its exact position', () => {
    expect(replaceOneMatch('foo bar foo', { start: 4, length: 3, text: 'bar', groups: [] }, 'X', opts))
      .toBe('foo X foo');
  });

  it('uses group references in the replacement', () => {
    const ms = findAll('a=12;b', '=(\\d+);', { ...opts, useRegex: true });
    expect(ms.length).toBe(1);
    expect(replaceOneMatch('a=12;b', ms[0], ':$1:', { ...opts, useRegex: true }))
      .toBe('a:12:b');
  });
});

describe('replaceAllInText', () => {
  it('replaces every occurrence and returns count', () => {
    const r = replaceAllInText('apple apple pie apple', 'apple', 'pear', opts);
    expect(r.text).toBe('pear pear pie pear');
    expect(r.count).toBe(3);
  });

  it('does not touch the text when nothing matches', () => {
    const r = replaceAllInText('nothing here', 'x', 'y', opts);
    expect(r.text).toBe('nothing here');
    expect(r.count).toBe(0);
  });

  it('expands groups on every regex match', () => {
    const r = replaceAllInText('v1=1;v2=2;', '=(\\d+);', '-$1-', { ...opts, useRegex: true });
    expect(r.text).toBe('v1-1-v2-2-');
    expect(r.count).toBe(2);
  });

  it('is a no-op for invalid regex', () => {
    const r = replaceAllInText('x', '(', 'y', { ...opts, useRegex: true });
    expect(r.text).toBe('x');
    expect(r.count).toBe(0);
  });
});

describe('highlightMatchesIn', () => {
  function mount(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  it('wraps matching text nodes in <mark class="sr-hl">', () => {
    const el = mount('cat and dog and cat');
    const count = highlightMatchesIn(el, 'cat', opts, 1);
    expect(count).toBe(2);
    const marks = el.querySelectorAll('mark.sr-hl');
    expect(marks.length).toBe(2);
    expect(marks[1].classList.contains('sr-current')).toBe(true);
    expect(el.textContent).toBe('cat and dog and cat');
    el.remove();
  });

  it('removes previous marks before re-highlighting', () => {
    const el = mount('cat');
    highlightMatchesIn(el, 'cat', opts, 0);
    highlightMatchesIn(el, 'dog', opts, 0);
    expect(el.querySelectorAll('mark.sr-hl').length).toBe(0);
    expect(el.textContent).toBe('cat');
    el.remove();
  });

  it('returns 0 when nothing matches', () => {
    const el = mount('nothing');
    expect(highlightMatchesIn(el, 'zzz', opts, 0)).toBe(0);
    el.remove();
  });
});