// mark-fragment.ts
//
// Robustly locate a rendered (DOM-selected) text fragment inside a markdown
// source.
//
// Rendering is lossy: whitespace collapses (newlines → spaces) and markdown
// syntax (`**bold**`, `*em*`, inline code, links, headings, lists, …)
// disappears from the text the user sees and selects. A plain text search of
// the source can therefore miss multi-paragraph or formatted selections —
// which used to end in "the marked text could not be located" and a lost
// rewrite.
//
// Instead of searching the source text directly, we keep MARKERS of the
// original content: a normalized plain-text form of the source where every
// normalized character remembers the exact source offset it came from
// (`markerMapOf`). A match in normalized space maps straight back to the
// source range to replace, so formatting can never hide the fragment.

export interface FragmentLoc {
  /** Source offset of the first character of the fragment. */
  index: number;
  /** Source length covered by the fragment. */
  length: number;
}

export interface MarkerMap {
  /** Normalized plain text (whitespace collapsed to single spaces). */
  text: string;
  /** sourceOf[i] = source index that produced text[i]. */
  sourceOf: number[];
  /**
   * Source offsets that markdown stripped away (delimiter runs, fences,
   * brackets, heading hashes, …). Used to fold emphasis markers into a
   * replacement range without touching literal delimiters (e.g. `\*`).
   */
  stripped: Set<number>;
}

const isWord = (ch: string | undefined): boolean =>
  !!ch && /[A-Za-z0-9_\u00C0-\u017F]/.test(ch);

const isDelimiter = (ch: string | undefined): boolean =>
  ch === '*' || ch === '_' || ch === '~' || ch === '`';

/** Collapse whitespace the way markdown rendering does. */
export function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Build the marker map for a markdown source: the normalized text a reader
 * would see (markdown syntax removed, whitespace collapsed) together with the
 * source offset of every normalized character.
 */
export function markerMapOf(source: string): MarkerMap {
  const text: string[] = [];
  const sourceOf: number[] = [];
  const stripped = new Set<number>();
  const n = source.length;

  let pendingSpace = false;
  let pendingSpaceIdx = 0;

  const markStripped = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k++) stripped.add(k);
  };

  const push = (src: number, ch: string): void => {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (!pendingSpace) {
        pendingSpace = true;
        pendingSpaceIdx = src;
      }
      return;
    }
    if (pendingSpace) {
      if (text.length > 0) {
        text.push(' ');
        sourceOf.push(pendingSpaceIdx);
      }
      pendingSpace = false;
    }
    text.push(ch);
    sourceOf.push(src);
  };

  const lineEndAt = (pos: number): number => {
    const e = source.indexOf('\n', pos);
    return e === -1 ? n : e;
  };

  const lineStart = (pos: number): boolean =>
    pos === 0 || source[pos - 1] === '\n';

  let i = 0;
  let inFence = false;

  while (i < n) {
    const ch = source[i];

    // Fenced code blocks: the fence lines (``` / ~~~) are structure, the
    // content inside is kept verbatim (backticks, stars, … are literal).
    if (lineStart(i)) {
      const end = lineEndAt(i);
      const line = source.slice(i, end);
      const fenceM = /^(```+|~~~+)/.exec(line);
      if (fenceM) {
        const isClose = inFence && /^(```+|~~~+)\s*$/.test(line);
        if (!inFence || isClose) {
          markStripped(i, end);
          inFence = !inFence;
          i = end + (end < n ? 1 : 0);
          pendingSpace = true;
          pendingSpaceIdx = i > 0 ? i - 1 : 0;
          continue;
        }
      }
    }

    if (inFence) {
      push(i, ch);
      i++;
      continue;
    }

    // Inline code spans: `code` / ``code`` — content is kept verbatim.
    if (ch === '`') {
      let j = i;
      while (j < n && source[j] === '`') j++;
      const ticks = j - i;
      const closer = source.indexOf('`'.repeat(ticks), j);
      if (closer !== -1) {
        markStripped(i, j);
        for (let k = j; k < closer; k++) push(k, source[k]);
        markStripped(closer, closer + ticks);
        i = closer + ticks;
        continue;
      }
      push(i, ch);
      i++;
      continue;
    }

    // Backslash escapes: \x renders as x (the backslash is stripped, the
    // escaped character is kept and is therefore NOT marked stripped).
    if (ch === '\\' && i + 1 < n) {
      markStripped(i, i + 1);
      push(i + 1, source[i + 1]);
      i += 2;
      continue;
    }

    // Links / images: [label](url) / [label][ref] / ![alt](url) → label only.
    if (ch === '[' || (ch === '!' && source[i + 1] === '[')) {
      const labelStart = ch === '[' ? i + 1 : i + 2;
      const cb = source.indexOf(']', labelStart);
      if (cb !== -1) {
        markStripped(i, labelStart);
        for (let k = labelStart; k < cb; k++) push(k, source[k]);
        const k = cb + 1;
        if (source[k] === '(') {
          const cp = source.indexOf(')', k);
          if (cp !== -1) {
            markStripped(cb, cp + 1);
            i = cp + 1;
            continue;
          }
        } else if (source[k] === '[') {
          const cr = source.indexOf(']', k);
          if (cr !== -1) {
            markStripped(cb, cr + 1);
            i = cr + 1;
            continue;
          }
        }
        markStripped(cb, cb + 1);
        i = cb + 1;
        continue;
      }
    }

    // Line-start structure: headings, blockquotes, lists, horizontal rules.
    if (lineStart(i)) {
      if (ch === '#') {
        let j = i;
        while (j < n && source[j] === '#') j++;
        const after = j < n ? source[j] : ' ';
        if (j - i <= 6 && (after === ' ' || j >= n)) {
          markStripped(i, after === ' ' ? j + 1 : j);
          i = after === ' ' ? j + 1 : j;
          continue;
        }
      }
      if (ch === '>') {
        let j = i;
        while (j < n && (source[j] === '>' || source[j] === ' ')) j++;
        markStripped(i, j);
        i = j;
        continue;
      }
      const listMatch = source.slice(i, i + 6).match(/^(?:[-+*]|\d+[.)])\s/);
      if (listMatch) {
        markStripped(i, i + listMatch[0].length);
        i += listMatch[0].length;
        continue;
      }
      if (/^[-=_*]{3,}\s*$/.test(source.slice(i, lineEndAt(i)))) {
        const end = lineEndAt(i);
        markStripped(i, end);
        i = end + (end < n ? 1 : 0);
        pendingSpace = true;
        pendingSpaceIdx = i > 0 ? i - 1 : 0;
        continue;
      }
    }

    // Emphasis / strikethrough delimiters: **, __, ~~ (two+ chars vanish).
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = i;
      while (run < n && source[run] === ch) run++;
      const cnt = run - i;
      if (cnt >= 2) {
        markStripped(i, run);
        i = run;
        continue;
      }
      // Single * / _ only act as emphasis when NOT inside a word (word-internal
      // underscores like snake_case and plain multiplication signs survive
      // rendering and must be kept).
      const prev = i > 0 ? source[i - 1] : ' ';
      const nxt = run < n ? source[run] : ' ';
      if (!(isWord(prev) && isWord(nxt))) {
        markStripped(i, run);
        i = run;
        continue;
      }
    }

    push(i, ch);
    i++;
  }

  return { text: text.join(''), sourceOf, stripped };
}

/**
 * Locate a fragment selected from the rendered content inside the markdown
 * source. Returns the exact source range to replace, or null when the fragment
 * cannot be mapped back (caller decides how to handle that case).
 */
export function markFragmentInSource(source: string, fragment: string): FragmentLoc | null {
  if (!source || !fragment.trim()) return null;

  const map = markerMapOf(source);
  const nf = squash(fragment);
  if (!nf) return null;

  const idx = map.text.indexOf(nf);
  if (idx < 0) return null;

  let index = map.sourceOf[idx];
  let length = map.sourceOf[idx + nf.length - 1] - index + 1;
  if (length <= 0) return null;

  // Fold a matching emphasis wrapper into the range: when the fragment sits
  // between the SAME markdown-stripped delimiter on both sides (e.g.
  // `**text**`), remove both markers together so no dangling syntax is left
  // behind after replacement. Literal delimiters (escaped `\*`, code content)
  // are not in the stripped set and are left untouched.
  const baseEnd = index + length;
  if (index > 0 && baseEnd < source.length) {
    const lead = source[index - 1];
    const tail = source[baseEnd];
    if (isDelimiter(lead) && lead === tail &&
        map.stripped.has(index - 1) && map.stripped.has(baseEnd)) {
      let li = index - 1;
      while (li > 0 && source[li - 1] === lead && map.stripped.has(li - 1)) li--;
      let te = baseEnd + 1;
      while (te < source.length && source[te] === tail && map.stripped.has(te)) te++;
      index = li;
      length = te - li;
    }
  }

  // Second pass — the selection may continue past an emphasis whose closing
  // marker sits INSIDE the range (e.g. "**bold** and more" where the closing
  // `**` is consumed by the range but the opening one would dangle). When the
  // fragment starts right after a stripped delimiter and a matching closing
  // delimiter exists at/after its start, pull the opening marker into the
  // range as well, leaving both markers removed by the replacement.
  if (index > 0) {
    const d = source[index - 1];
    if (isDelimiter(d) && map.stripped.has(index - 1)) {
      const lim = Math.min(source.length, index + length + 4);
      let c = index;
      while (c < lim && !(source[c] === d && map.stripped.has(c))) c++;
      if (c < lim) {
        let li = index - 1;
        while (li > 0 && source[li - 1] === d && map.stripped.has(li - 1)) li--;
        const end = Math.max(index + length, c + 1);
        index = li;
        length = end - li;
      }
    }
  }

  return { index, length };
}