/**
 * search-utils.ts
 *
 * Pure search/replace engine — no Angular, no DOM. Search options mirror the
 * dialog's toggles; replacement in regex mode supports capture-group
 * references (`$1`, `$2`, …, `$0` / `$&` for the whole match, `$$` for a
 * literal `$`, `` $` `` for the prefix, `$'` for the suffix). In literal mode
 * `$` is plain text (groups only make sense with a regex).
 */

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export const defaultSearchOptions = (): SearchOptions => ({
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
});

export interface SearchMatch {
  /** Offset of the whole match in the searched text. */
  start: number;
  /** Length of the matched text. */
  length: number;
  /** The matched text itself. */
  text: string;
  /** Capture groups (regex mode only; empty array otherwise / no groups). */
  groups: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `term` (if treated as a regex) is a valid pattern. Always true for
 * literal search; used to surface a friendly error in regex mode.
 */
export function isValidRegex(term: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(term);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the RegExp used to find `term` in the searched text, honouring the
 * options. Returns null when the term is empty or (regex mode) invalid.
 */
export function buildSearchRegExp(
  term: string,
  opts: SearchOptions
): RegExp | null {
  if (!term) return null;
  let source = opts.useRegex ? term : escapeRegExp(term);
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  const flags = 'g' + (opts.caseSensitive ? '' : 'i');
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** All occurrences of `term` in `text`, respecting `opts`. `[]` when empty/invalid. */
export function findAll(
  text: string,
  term: string,
  opts: SearchOptions
): SearchMatch[] {
  const re = buildSearchRegExp(term, opts);
  if (!re) return [];
  const out: SearchMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, length: m[0].length, text: m[0], groups: m.slice(1) });
    if (m[0].length === 0) re.lastIndex++; // avoid infinite loop on empty matches
  }
  return out;
}

/** Expand a replacement template à la `String.replace` (groups only in regex mode). */
export function expandReplace(
  template: string,
  m: { text: string; groups: string[]; prefix: string; suffix: string },
  useRegex: boolean
): string {
  // In literal mode `$` has no special meaning.
  if (!useRegex) return template;
  return template.replace(/\$(?:\$|&|`|'|\d+)/g, (tok) => {
    switch (tok) {
      case '$$':
        return '$';
      case '$&':
        return m.text;
      case '$`':
        return m.prefix;
      case "$'":
        return m.suffix;
      default: {
        const digits = tok.slice(1);
        if (digits === '0') return m.text;
        const i = Number(digits);
        return m.groups[i - 1] ?? '';
      }
    }
  });
}

/** Replace a single match inside `text`. */
export function replaceOneMatch(
  text: string,
  match: SearchMatch,
  template: string,
  opts: SearchOptions
): string {
  const prefix = text.slice(0, match.start);
  const suffix = text.slice(match.start + match.length);
  const replacement = expandReplace(template, { text: match.text, groups: match.groups, prefix, suffix }, opts.useRegex);
  return prefix + replacement + suffix;
}

/** Replace every occurrence of `term` in `text`. */
export function replaceAllInText(
  text: string,
  term: string,
  template: string,
  opts: SearchOptions
): { text: string; count: number } {
  const re = buildSearchRegExp(term, opts);
  if (!re) return { text, count: 0 };
  let result = '';
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const prefix = text.slice(0, m.index);
    const suffix = text.slice(m.index + m[0].length);
    const replacement = expandReplace(template, { text: m[0], groups: m.slice(1), prefix, suffix }, opts.useRegex);
    result += text.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    count++;
  }
  result += text.slice(last);
  return { text: result, count };
}

/**
 * DOM-highlight every occurrence of `term` inside `root` in a `<mark>` with
 * class `sr-hl` (plus `sr-current` on the `currentNth` match, 0-based).
 * Removes any previous `sr-hl` marks first. Returns the number of matches.
 */
export function highlightMatchesIn(
  root: Element,
  term: string,
  opts: SearchOptions,
  currentNth = -1
): number {
  // Undo previous highlighting.
  root.querySelectorAll('mark.sr-hl').forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    const text = document.createTextNode(m.textContent ?? '');
    parent.replaceChild(text, m);
    parent.normalize();
  });

  const re = buildSearchRegExp(term, opts);
  if (!re) return 0;

  // Collect the original text nodes before mutating the tree.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  let nth = 0;
  let count = 0;
  for (const node of textNodes) {
    const data = node.data;
    if (!data) continue;
    let last = 0;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let m: RegExpExecArray | null;
    while ((m = re.exec(data)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (m.index > last) frag.appendChild(document.createTextNode(data.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'sr-hl';
      if (nth === currentNth) mark.classList.add('sr-current');
      mark.textContent = m[0];
      frag.appendChild(mark);
      nth++;
      count++;
      last = m.index + m[0].length;
    }
    if (frag.childNodes.length === 0) continue;
    if (last < data.length) frag.appendChild(document.createTextNode(data.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
  return count;
}