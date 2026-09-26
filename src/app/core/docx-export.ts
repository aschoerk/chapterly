/**
 * DOCX export for a single chapterly chat.
 *
 * Pure/mostly-pure helpers so the logic is unit-testable without Angular:
 *
 *  - `enumerateDocumentPaths` mirrors the chat-reader's document enumeration
 *    (version families + branches) so the exporter finds the SAME set of
 *    story versions the reader would page through.
 *  - `pickLongestVersion` returns the path with the most written content.
 *  - `classifyStructure` maps the linear path onto a book:
 *        first structural node            → title
 *        structural node before a chapter → chapter heading
 *        last structural node             → introduction part
 *  - `buildDocxBlob` produces a Word .docx (OpenXML in a stored-entry ZIP).
 */
import { marked, type Token } from 'marked';
import { ChatNode } from '../models/chat';

// ---------------------------------------------------------------------------
// Version selection (mirrors chat-reader.component.ts)
// ---------------------------------------------------------------------------

export function isUsableNode(n: ChatNode): boolean {
  return !!(n.content?.trim() || n.attachments?.length);
}

function childIdsByParent(nodes: ChatNode[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = map.get(n.parentId) ?? [];
    list.push(n.id);
    map.set(n.parentId, list);
  }
  return map;
}

function isEmptyLeaf(n: ChatNode, childIds: Map<string, string[]>): boolean {
  return !isUsableNode(n) && !(childIds.get(n.id)?.length);
}

function tsOf(n: ChatNode): number {
  const t = Date.parse(n.createdAt || n.updatedAt || '');
  return Number.isFinite(t) ? t : 0;
}

function familyOf(node: ChatNode, byId: Map<string, ChatNode>): ChatNode[] {
  const ids = new Set<string>();
  let cur: ChatNode | undefined = node;
  while (cur) {
    if (ids.has(cur.id)) break;
    ids.add(cur.id);
    cur = cur.previousVersionId ? byId.get(cur.previousVersionId) : undefined;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of byId.values()) {
      if (ids.has(n.id)) continue;
      if (n.previousVersionId && ids.has(n.previousVersionId)) {
        ids.add(n.id);
        changed = true;
      }
      if ([...ids].some(id => byId.get(id)?.previousVersionId === n.id)) {
        ids.add(n.id);
        changed = true;
      }
    }
  }
  return [...ids]
    .map(id => byId.get(id)!)
    .filter(Boolean)
    .sort((a, b) => (a.version ?? 0) - (b.version ?? 0) || tsOf(a) - tsOf(b));
}

function familyId(node: ChatNode, byId: Map<string, ChatNode>): string {
  const fam = familyOf(node, byId);
  return fam[0]?.id ?? node.id; // stable id = oldest version
}

/**
 * Every candidate "document" for a chat, exactly as the chat reader builds
 * them: combinations of version families and branches. Sorted oldest-combo
 * first (mirrors the reader's ordering).
 */
export function enumerateDocumentPaths(allNodes: ChatNode[]): ChatNode[][] {
  const childIds = childIdsByParent(allNodes);
  const nodes = allNodes.filter(n => !isEmptyLeaf(n, childIds));
  const byId = new Map(nodes.map(n => [n.id, n]));

  const familyKids = new Map<string, ChatNode[]>();
  const addKid = (parentFamilyId: string, child: ChatNode) => {
    const list = familyKids.get(parentFamilyId) ?? [];
    if (!list.some(n => n.id === child.id)) list.push(child);
    familyKids.set(parentFamilyId, list);
  };

  for (const n of nodes) {
    if (!n.parentId) continue;
    const parent = byId.get(n.parentId);
    if (!parent) continue;
    addKid(familyId(parent, byId), n);
    for (const rel of familyOf(parent, byId)) {
      addKid(familyId(rel, byId), n);
    }
  }

  const roots = nodes.filter(n => !n.parentId);
  const rootFamilies = new Map<string, ChatNode[]>();
  for (const r of roots) {
    const fid = familyId(r, byId);
    rootFamilies.set(fid, familyOf(r, byId));
  }

  const paths: ChatNode[][] = [];

  const walk = (famMembers: ChatNode[], acc: ChatNode[]) => {
    for (const pick of famMembers) {
      const structuralOnly = !isUsableNode(pick);
      const nextAcc = structuralOnly ? acc : [...acc, pick];
      const fid = familyId(pick, byId);
      const rawKids = familyKids.get(fid) ?? [];
      const kidFam = new Map<string, ChatNode[]>();
      for (const kid of rawKids) {
        const kfid = familyId(kid, byId);
        kidFam.set(kfid, familyOf(kid, byId));
      }
      if (kidFam.size === 0) {
        if (!structuralOnly && nextAcc.length) paths.push(nextAcc);
        continue;
      }
      for (const members of kidFam.values()) {
        walk(members, nextAcc);
      }
    }
  };

  for (const members of rootFamilies.values()) walk(members, []);

  paths.sort((a, b) => {
    const va = a.reduce((s, n) => s + (n.version ?? 1), 0);
    const vb = b.reduce((s, n) => s + (n.version ?? 1), 0);
    if (va !== vb) return va - vb;
    return Math.max(...a.map(n => tsOf(n))) - Math.max(...b.map(n => tsOf(n)));
  });
  return paths;
}

function pathLength(path: ChatNode[]): number {
  return path.reduce((s, n) => s + (n.content?.length ?? 0), 0);
}

/** The longest (most written content) version of the chat. */
export function pickLongestVersion(paths: ChatNode[][]): ChatNode[] {
  let best: ChatNode[] = [];
  let bestLen = -1;
  let bestTs = -1;
  for (const p of paths) {
    const len = pathLength(p);
    const ts = Math.max(...p.map(n => tsOf(n)));
    if (len > bestLen || (len === bestLen && ts > bestTs)) {
      best = p;
      bestLen = len;
      bestTs = ts;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Structure classification
// ---------------------------------------------------------------------------

export interface DocChapter {
  heading: string;
  content: ChatNode | null;
}

export interface DocStructure {
  title: string;
  intro: string | null;
  chapters: DocChapter[];
}

/** User-facing label used for the optional introduction section. */
export const INTRO_LABEL = 'Introduction';
/** User-facing label used when a bare structural node starts a section. */
export const SECTION_LABEL = 'Section';

/**
 * Turn the linear (longest) path into a book:
 *  - assistant nodes are chapters,
 *  - a structural node immediately before a chapter is its heading,
 *  - the FIRST structural node is the title,
 *  - the LAST structural node is the introduction part.
 */
export function classifyStructure(path: ChatNode[], fallbackTitle: string): DocStructure {
  const kept = path.filter(
    n => (n.role === 'assistant' || n.role === 'structural') && isUsableNode(n),
  );

  let title = fallbackTitle?.trim() || '';
  const first = kept.length ? kept[0] : undefined;
  if (first && first.role === 'structural') {
    title = (first.content || '').trim() || title;
  }

  let intro: string | null = null;
  const last = kept.length > 1 ? kept[kept.length - 1] : undefined;
  if (last && last.role === 'structural') {
    intro = last.content || null;
  }

  const chapters: DocChapter[] = [];
  for (let i = 0; i < kept.length; i++) {
    const n = kept[i];
    if (first && first.role === 'structural' && n.id === first.id) continue;
    if (last && last.role === 'structural' && n.id === last.id) continue;

    if (n.role === 'assistant') {
      const prev = i > 0 ? kept[i - 1] : undefined;
      const heading = prev && prev.role === 'structural' ? (prev.content || '').trim() : '';
      chapters.push({ heading, content: n });
    } else if (n.role === 'structural') {
      // Structural nodes directly in front of a chapter are that chapter's
      // heading (handled by the assistant entry above). Any other structural
      // node that is neither title/intro nor a chapter heading becomes a
      // standalone section divider so its text is never lost.
      const nextNode = kept[i + 1];
      const isChapterHeading = !!nextNode && nextNode.role === 'assistant';
      if (!isChapterHeading) {
        chapters.push({ heading: (n.content || '').trim() || SECTION_LABEL, content: null });
      }
    }
  }

  return { title, intro, chapters };
}

// ---------------------------------------------------------------------------
// OpenXML / OOXML helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

interface RunFormat {
  b?: boolean;
  i?: boolean;
  strike?: boolean;
  mono?: boolean;
  color?: string;
}

function run(text: string, fmt: RunFormat = {}): string {
  const rPr: string[] = [];
  if (fmt.b) rPr.push('<w:b/><w:bCs/>');
  if (fmt.i) rPr.push('<w:i/><w:iCs/>');
  if (fmt.strike) rPr.push('<w:strike/>');
  if (fmt.mono) {
    rPr.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
  }
  if (fmt.color) rPr.push(`<w:color w:val="${fmt.color}"/>`);
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
  const parts = String(text ?? '').split('\n');
  const tXml = parts
    .map((seg, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(seg)}</w:t>`)
    .join('');
  return `<w:r>${rPrXml}${tXml}</w:r>`;
}

function paragraph(runs: string, style?: string, extraPPr = ''): string {
  const pPr = style || extraPPr
    ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extraPPr}</w:pPr>`
    : '';
  return `<w:p>${pPr}${runs}</w:p>`;
}

/** Render inline markdown tokens into Word runs. */
function inlineRuns(tokens: Token[]): string {
  let xml = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        xml += run((t as any).text);
        break;
      case 'strong':
        xml += run(inlineText((t as any).tokens ?? []), { b: true });
        break;
      case 'em':
        xml += run(inlineText((t as any).tokens ?? []), { i: true });
        break;
      case 'del':
        xml += run(inlineText((t as any).tokens ?? []), { strike: true });
        break;
      case 'codespan':
        xml += run((t as any).text, { mono: true });
        break;
      case 'br':
        xml += '<w:r><w:br/></w:r>';
        break;
      case 'link':
        xml += inlineRuns((t as any).tokens ?? []);
        break;
      case 'image':
        xml += run((t as any).text || '');
        break;
      case 'escape':
      case 'html':
        xml += run((t as any).text ?? (t as any).raw ?? '');
        break;
      default: {
        const raw = (t as any).text ?? (t as any).raw ?? '';
        if (raw) xml += run(String(raw));
      }
    }
  }
  return xml;
}

function inlineText(tokens: Token[]): string {
  return (tokens ?? [])
    .map(t => {
      switch (t.type) {
        case 'text': return (t as any).text;
        case 'codespan': return (t as any).text;
        case 'br': return '\n';
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          return inlineText((t as any).tokens ?? []);
        default:
          return (t as any).text ?? (t as any).raw ?? '';
      }
    })
    .join('');
}

/** Render a markdown document into Word paragraphs. */
function markdownParagraphs(markdown: string, bodyStyle = 'BodyText'): string[] {
  const tokens = marked.lexer(markdown || '');
  const out: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const depth = (t as any).depth ?? 1;
        const hStyle =
          depth <= 1 ? 'Heading1' : depth === 2 ? 'Heading2' : depth === 3 ? 'Heading3' : 'Heading4';
        out.push(paragraph(inlineRuns((t as any).tokens ?? []), hStyle));
        break;
      }
      case 'paragraph':
        out.push(paragraph(inlineRuns((t as any).tokens ?? []), bodyStyle));
        break;
      case 'blockquote':
        out.push(paragraph(inlineRuns((t as any).tokens?.[0]?.tokens ?? []), 'Quote'));
        break;
      case 'code': {
        const code = (t as any).text ?? '';
        for (const line of code.split('\n')) {
          out.push(paragraph(run(line, { mono: true }), 'CodeBlock'));
        }
        break;
      }
      case 'list': {
        const list = t as any;
        (list.items ?? []).forEach((item: any, idx: number) => {
          const marker = list.ordered ? `${idx + 1}. ` : '• ';
          const paraTok = (item.tokens ?? []).find((x: any) => x.type === 'paragraph');
          const body = paraTok
            ? inlineRuns(paraTok.tokens ?? [])
            : run((item.text ?? '').trim());
          out.push(paragraph(run(marker) + body, list.ordered ? 'ListNumber' : 'ListBullet'));
        });
        break;
      }
      case 'hr':
        out.push(
          '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>',
        );
        break;
      case 'space':
        break;
      case 'html':
      case 'escape':
      case 'text':
        out.push(paragraph(run((t as any).text ?? (t as any).raw ?? ''), bodyStyle));
        break;
      case 'table': {
        const tbl = t as any;
        for (const row of tbl.rows ?? []) {
          const cells = (row ?? []).map((c: any) => c?.text ?? '').join(' | ');
          out.push(paragraph(run(`| ${cells} |`), bodyStyle));
        }
        break;
      }
      default: {
        const raw = (t as any).text ?? (t as any).raw ?? '';
        if (raw) out.push(paragraph(run(String(raw)), bodyStyle));
      }
    }
  }
  return out;
}

const PAGE_BREAK = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

function buildDocumentXml(doc: DocStructure): string {
  const body: string[] = [];

  if (doc.title) {
    body.push(paragraph(run(doc.title, { b: true }), 'Title'));
  }

  if (doc.intro) {
    body.push(PAGE_BREAK);
    body.push(paragraph(run(INTRO_LABEL, { b: true }), 'Heading1'));
    body.push(...markdownParagraphs(doc.intro, 'IntroText'));
  }

  doc.chapters.forEach((ch, i) => {
    if (i > 0) body.push(PAGE_BREAK);
    if (ch.heading) {
      body.push(paragraph(run(ch.heading, { b: true }), 'Heading1'));
    }
    if (ch.content) {
      body.push(...markdownParagraphs(ch.content.content || '', 'BodyText'));
    }
  });

  const sectPr =
    '<w:sectPr>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr>';

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join('')}${sectPr}</w:body>` +
    '</w:document>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="180" w:line="300" w:lineRule="auto"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/><w:color w:val="1F1F1F"/></w:rPr>' +
  '<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="360"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/><w:color w:val="1F3864"/></w:rPr>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="160"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/><w:color w:val="2E5395"/></w:rPr>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="220" w:after="120"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:i/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:i/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="595959"/></w:rPr>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:i/><w:color w:val="595959"/></w:rPr>' +
  '<w:pPr><w:ind w:left="360" w:right="360"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="IntroText"><w:name w:val="Intro Text"/><w:basedOn w:val="BodyText"/>' +
  '<w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="BodyText"/>' +
  '<w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="BodyText"/>' +
  '<w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr>' +
  '<w:pPr><w:shd w:val="clear" w:fill="F2F2F2"/><w:ind w:left="360"/></w:pPr></w:style>' +
  '</w:styles>';

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>';

const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

const DOCUMENT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

function coreXml(title: string, created: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title>` +
    `<dc:creator>Chapterly</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${esc(created)}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${esc(created)}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<Application>Chapterly</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
  '<Company>Chapterly</Company>' +
  '</Properties>';

// ---------------------------------------------------------------------------
// Minimal ZIP writer (stored entries, no compression) + CRC32
// ---------------------------------------------------------------------------

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed to extract
    local.setUint16(6, 0x0800, true); // general purpose flag: UTF-8 names
    local.setUint16(8, 0, true); // compression method: store
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra length
    localChunks.push(new Uint8Array(local.buffer), nameBytes, e.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); // central directory header
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); // method: store
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true); // extra length
    cd.setUint16(32, 0, true); // comment length
    cd.setUint16(34, 0, true); // disk number start
    cd.setUint16(36, 0, true); // internal attributes
    cd.setUint32(38, 0, true); // external attributes
    cd.setUint32(42, offset, true); // local header offset
    centralChunks.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + e.data.length;
  }

  const centralSize = centralChunks.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end of central directory
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // central dir disk
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralOffset, true);
  eocd.setUint16(20, 0, true); // comment length

  const total =
    localChunks.reduce((s, c) => s + c.length, 0) +
    centralChunks.reduce((s, c) => s + c.length, 0) +
    22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of [...localChunks, ...centralChunks, new Uint8Array(eocd.buffer)]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Shared: resolve the longest chat version into a book structure. */
export function resolveDocStructure(
  chatTitle: string,
  allNodes: ChatNode[],
): { path: ChatNode[]; doc: DocStructure } {
  const paths = enumerateDocumentPaths(allNodes);
  const path = pickLongestVersion(paths);
  return { path, doc: classifyStructure(path, chatTitle) };
}

/**
 * Build a .docx Blob for the longest version of a chat's assistant + structure
 * nodes. `allNodes` must contain every node (incl. prior versions) of the chat.
 */
export function buildDocxBlob(chatTitle: string, allNodes: ChatNode[]): Blob {
  const { doc } = resolveDocStructure(chatTitle, allNodes);
  const now = new Date().toISOString();

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: strBytes(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: strBytes(RELS_XML) },
    { name: 'word/document.xml', data: strBytes(buildDocumentXml(doc)) },
    { name: 'word/_rels/document.xml.rels', data: strBytes(DOCUMENT_RELS_XML) },
    { name: 'word/styles.xml', data: strBytes(STYLES_XML) },
    { name: 'docProps/core.xml', data: strBytes(coreXml(doc.title || chatTitle, now)) },
    { name: 'docProps/app.xml', data: strBytes(APP_XML) },
  ];

  const zip = buildZip(entries);
  return new Blob([zip as BlobPart], { type: DOCX_MIME });
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

/**
 * Build a plain Markdown document for the longest version of a chat's
 * assistant + structure nodes (same book structure as the DOCX export):
 *
 *     # Title
 *
 *     ## Introduction
 *     …
 *
 *     # Chapter heading
 *     …
 */
export function buildMarkdown(chatTitle: string, allNodes: ChatNode[]): string {
  const { doc } = resolveDocStructure(chatTitle, allNodes);
  const out: string[] = [];

  if (doc.title) {
    out.push(`# ${doc.title}`, '');
  }

  if (doc.intro) {
    out.push(`## ${INTRO_LABEL}`, '', doc.intro.trim(), '');
  }

  doc.chapters.forEach((ch) => {
    if (out.length > 0) out.push('---', '');
    if (ch.heading) {
      out.push(`# ${ch.heading}`, '');
    }
    if (ch.content?.content?.trim()) {
      out.push(ch.content.content.trim(), '');
    }
  });

  return out.join('\n').trim() + '\n';
}

function strBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
