import { describe, it, expect } from 'vitest';
import { markFragmentInSource, markerMapOf, squash } from './mark-fragment';

function replaced(source: string, fragment: string, rewrite: string): string {
  const loc = markFragmentInSource(source, fragment);
  if (!loc) return source; // no match — mirrors the append fallback elsewhere
  return source.slice(0, loc.index) + rewrite + source.slice(loc.index + loc.length);
}

describe('markFragmentInSource (marker-map), no text-search of the raw source', () => {
  it('locates a plain single-line fragment', () => {
    const source = 'The hero enters the old tower.';
    const loc = markFragmentInSource(source, 'the old tower');
    expect(loc).toEqual({ index: source.indexOf('the old tower'), length: 'the old tower'.length });
  });

  it('collapses whitespace like rendering (newlines → space)', () => {
    const source = 'The hero enters\nthe old tower.';
    const loc = markFragmentInSource(source, 'enters the old tower');
    expect(loc).not.toBeNull();
    expect(source.slice(loc!.index, loc!.index + loc!.length)).toBe('enters\nthe old tower');
  });

  it('spans multiple paragraphs (multi blank-line separation)', () => {
    const source = 'First paragraph of the mark.\n\nSecond paragraph ends the mark.';
    const loc = markFragmentInSource(source, 'First paragraph of the mark.\nSecond paragraph');
    expect(loc).not.toBeNull();
    expect(replaced(source, 'First paragraph of the mark.\nSecond paragraph', 'REWRITE'))
      .toBe('REWRITE ends the mark.');
  });

  it('ignores markdown emphasis markers (bold / italics)', () => {
    const source = 'The hero enters **the old tower** and climbs.';
    const loc = markFragmentInSource(source, 'the old tower');
    expect(loc).not.toBeNull();
    // Both ** markers are folded in, so no dangling syntax is left behind.
    expect(replaced(source, 'the old tower', 'a ruined keep'))
      .toBe('The hero enters a ruined keep and climbs.');
  });

  it('pulls in the opening marker when the selection continues past the closing one', () => {
    const source = 'The hero enters **the old tower** and rests.\n\nThen he climbs the stairs.';
    const loc = markFragmentInSource(source, 'the old tower and rests. Then he climbs');
    expect(loc).not.toBeNull();
    expect(replaced(source, 'the old tower and rests. Then he climbs', 'REWRITE'))
      .toBe('The hero enters REWRITE the stairs.');
  });

  it('keeps word-internal underscores but strips italic underscores', () => {
    expect(markerMapOf('foo_bar baz').text).toBe('foo_bar baz');
    expect(markerMapOf('_em_ plain').text.trim()).toBe('em plain');
  });

  it('keeps inline code content without its backticks', () => {
    const source = 'Use `npm install` to start.';
    expect(replaced(source, 'npm install', 'npm i')).toBe('Use npm i to start.');
  });

  it('keeps link labels and preserves their URL wrappers', () => {
    const source = 'See [the docs](https://example.com) for details.';
    // Locating the rendered label keeps the surrounding link syntax intact.
    expect(replaced(source, 'the docs', 'README')).toBe('See [README](https://example.com) for details.');
  });

  it('skips heading and list markers', () => {
    const source = '# Title\n- first item\n- second item';
    expect(replaced(source, 'Title', 'Heading')).toBe('# Heading\n- first item\n- second item');
    expect(replaced(source, 'second item', 'last item')).toBe('# Title\n- first item\n- last item');
  });

  it('keeps escaped markdown characters escaped in the source', () => {
    const source = 'Literal \\*star\\* here.';
    // The escaped asterisks stay escaped so they still render literally;
    // only the marked word is replaced.
    expect(replaced(source, 'star', 'asterisk')).toBe('Literal \\*asterisk\\* here.');
  });

  it('keeps content inside fenced code blocks verbatim', () => {
    const source = 'Before\n\n```js\nconst x = 1;\n```\n\nAfter';
    expect(replaced(source, 'const x = 1;', 'let y = 2;'))
      .toBe('Before\n\n```js\nlet y = 2;\n```\n\nAfter');
  });
});

describe('squash', () => {
  it('collapses whitespace and trims', () => {
    expect(squash('a\n\n  b\t c ')).toBe('a b c');
  });
});