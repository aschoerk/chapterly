import { describe, it, expect } from 'vitest';
import { ChatNode } from '../models/chat';
import { makeNode } from '../../../test-helpers/factories';
import {
  buildDocxBlob,
  buildMarkdown,
  classifyStructure,
  enumerateDocumentPaths,
  pickDocumentPath,
} from './docx-export';

function node(o: Partial<ChatNode>): ChatNode {
  return makeNode(o);
}

// ---------------------------------------------------------------------------
// Document enumeration / selection (shared youngest-version algorithm)
// ---------------------------------------------------------------------------

describe('docx-export · document selection', () => {
  it('enumerates only the youngest version of an answer family', () => {
    const nodes = [
      node({ id: 'q1', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      // a1 is retired by a2 (same logical beat, newer version)
      node({
        id: 'a1', chatId: 'c1', parentId: 'q1', role: 'assistant',
        content: 'Short chapter', version: 1, isCurrent: false,
        createdAt: '2025-01-01T00:00:00Z',
      }),
      node({
        id: 'a2', chatId: 'c1', parentId: 'q1', role: 'assistant',
        content: 'This is a much longer chapter with more words in it than the old one',
        previousVersionId: 'a1', version: 2, isCurrent: true,
        createdAt: '2025-01-02T00:00:00Z',
      }),
    ];

    const paths = enumerateDocumentPaths(nodes);
    // the younger version replaces the older one — a single document
    expect(paths).toHaveLength(1);
    expect(paths[0].map(n => n.id)).toContain('a2');
    expect(paths[0].some(n => n.id === 'a1')).toBe(false);
    // the most-recent path is the only candidate
    expect(pickDocumentPath(paths).map(n => n.id)).toContain('a2');
  });

  it('picks the document containing the most recent node', () => {
    const nodes = [
      node({ id: 'q1', chatId: 'c1', parentId: null, role: 'user', content: 'Q', createdAt: '2025-01-01T00:00:00Z' }),
      node({ id: 'b1', chatId: 'c1', parentId: 'q1', role: 'assistant', content: 'Branch one', version: 1, createdAt: '2025-01-02T00:00:00Z' }),
      node({ id: 'b2', chatId: 'c1', parentId: 'q1', role: 'assistant', content: 'Branch two', version: 1, createdAt: '2025-01-03T00:00:00Z' }),
    ];
    const paths = enumerateDocumentPaths(nodes);
    expect(paths).toHaveLength(2);
    expect(pickDocumentPath(paths).map(n => n.id)).toEqual(['q1', 'b2']);
  });

  it('honours an explicit candidate index', () => {
    const nodes = [
      node({ id: 'q1', chatId: 'c1', parentId: null, role: 'user', content: 'Q', createdAt: '2025-01-01T00:00:00Z' }),
      node({ id: 'b1', chatId: 'c1', parentId: 'q1', role: 'assistant', content: 'Branch one', version: 1, createdAt: '2025-01-02T00:00:00Z' }),
      node({ id: 'b2', chatId: 'c1', parentId: 'q1', role: 'assistant', content: 'Branch two', version: 1, createdAt: '2025-01-03T00:00:00Z' }),
    ];
    const paths = enumerateDocumentPaths(nodes);
    expect(pickDocumentPath(paths, 0).map(n => n.id)).toEqual(['q1', 'b1']);
    expect(pickDocumentPath(paths, 99).map(n => n.id)).toEqual(['q1', 'b2']); // invalid → most recent
  });
});

// ---------------------------------------------------------------------------
// Structure classification
// ---------------------------------------------------------------------------

describe('docx-export · classifyStructure', () => {
  it('uses the first structural node as title and last as introduction', () => {
    const path = [
      node({ id: 'sTitle', parentId: 'q0', role: 'structural', content: 'My Great Book' }),
      node({ id: 'q1', parentId: 'sTitle', role: 'user', content: 'Q' }),
      node({ id: 'h1', parentId: 'q1', role: 'structural', content: 'Chapter the First' }),
      node({ id: 'a1', parentId: 'h1', role: 'assistant', content: 'Once upon a time…' }),
      node({ id: 'q2', parentId: 'a1', role: 'user', content: 'Q' }),
      node({ id: 'h2', parentId: 'q2', role: 'structural', content: 'Chapter the Second' }),
      node({ id: 'a2', parentId: 'h2', role: 'assistant', content: 'And then…' }),
      node({ id: 'sIntro', parentId: 'a2', role: 'structural', content: 'This is the introduction.' }),
    ];

    const doc = classifyStructure(path, 'Fallback Title');

    expect(doc.title).toBe('My Great Book');
    expect(doc.intro).toBe('This is the introduction.');
    expect(doc.chapters).toEqual([
      { heading: 'Chapter the First', content: path.find(n => n.id === 'a1')! },
      { heading: 'Chapter the Second', content: path.find(n => n.id === 'a2')! },
    ]);
  });

  it('falls back to the chat title when there is no structural first node', () => {
    const path = [
      node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Chapter body' }),
    ];
    const doc = classifyStructure(path, 'Chat Title');
    expect(doc.title).toBe('Chat Title');
    expect(doc.intro).toBeNull();
    expect(doc.chapters).toEqual([{ heading: '', content: path.find(n => n.id === 'a1')! }]);
  });

  it('treats a structural directly before a chapter as its heading', () => {
    const path = [
      node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'h', parentId: 'q1', role: 'structural', content: 'A Heading' }),
      node({ id: 'a1', parentId: 'h', role: 'assistant', content: 'body' }),
    ];
    const doc = classifyStructure(path, '');
    expect(doc.chapters[0].heading).toBe('A Heading');
  });
});

// ---------------------------------------------------------------------------
// DOCX / ZIP output
// ---------------------------------------------------------------------------

describe('docx-export · buildDocxBlob', () => {
  it('produces a ZIP OpenXML package containing the book', async () => {
    const nodes = [
      node({ id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'sTitle', chatId: 'c1', parentId: 'q0', role: 'structural', content: 'Book Title' }),
      node({ id: 'q1', chatId: 'c1', parentId: 'sTitle', role: 'user', content: 'Q' }),
      node({ id: 'h1', chatId: 'c1', parentId: 'q1', role: 'structural', content: 'Ch One' }),
      node({ id: 'a1', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'Story **bold** text.' }),
      node({ id: 'q2', chatId: 'c1', parentId: 'a1', role: 'user', content: 'Q' }),
      node({ id: 'a2', chatId: 'c1', parentId: 'q2', role: 'assistant', content: 'More of the story.' }),
      node({ id: 'sIntro', chatId: 'c1', parentId: 'a2', role: 'structural', content: 'Intro words.' }),
    ];

    const blob = buildDocxBlob('Fallback', nodes);
    expect(blob.type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    const buf = new Uint8Array(await blob.arrayBuffer());
    // ZIP magic: PK\x03\x04
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);

    const text = new TextDecoder().decode(buf);
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('word/document.xml');

    // stored entries appear verbatim in the byte stream
    expect(text).toContain('Book Title');
    expect(text).toContain('Ch One');
    expect(text).toContain('Story');
    expect(text).toContain('<w:b/>'); // bold run
    expect(text).toContain('Intro words.');
    expect(text).toContain('Heading1');
  });
});

describe('docx-export · buildMarkdown', () => {
  it('produces the same book structure as plain Markdown', () => {
    const nodes = [
      node({ id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'sTitle', chatId: 'c1', parentId: 'q0', role: 'structural', content: 'Book Title' }),
      node({ id: 'q1', chatId: 'c1', parentId: 'sTitle', role: 'user', content: 'Q' }),
      node({ id: 'h1', chatId: 'c1', parentId: 'q1', role: 'structural', content: 'Ch One' }),
      node({ id: 'a1', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'Story text.' }),
      node({ id: 'q2', chatId: 'c1', parentId: 'a1', role: 'user', content: 'Q' }),
      node({ id: 'a2', chatId: 'c1', parentId: 'q2', role: 'assistant', content: 'More of the story.' }),
      node({ id: 'sIntro', chatId: 'c1', parentId: 'a2', role: 'structural', content: 'Intro words.' }),
    ];

    const md = buildMarkdown('Fallback', nodes);

    expect(md).toContain('# Book Title');
    expect(md).toContain('## Introduction');
    expect(md).toContain('Intro words.');
    expect(md).toContain('# Ch One');
    expect(md).toContain('Story text.');
    expect(md).toContain('More of the story.');
  });

  it('picks the longest version', () => {
    const nodes = [
      node({ id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'a1', chatId: 'c1', parentId: 'q0', role: 'assistant', content: 'old', version: 1, isCurrent: false }),
      node({
        id: 'a2', chatId: 'c1', parentId: 'q0', role: 'assistant',
        content: 'a much longer chapter text', previousVersionId: 'a1', version: 2, isCurrent: true,
      }),
    ];

    const md = buildMarkdown('Title', nodes);
    expect(md).toContain('a much longer chapter text');
    expect(md).not.toContain('>old<');
    expect(md).not.toContain('\nold\n');
  });
});
