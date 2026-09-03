import { describe, expect, it } from 'vitest';
import {
  decodeDataUrlToText,
  inferMimeType,
  nodeToMessageContent,
  normalizeChatMessages,
  type MessagePart
} from './llm-message';
import { ChatMessage, NodeAttachment } from '../models/chat';

function dataUrl(mime: string, text: string, base64 = true): string {
  if (!base64) return `data:${mime},${encodeURIComponent(text)}`;
  return `data:${mime};base64,${btoa(text)}`;
}

function attach(partial: Partial<NodeAttachment> & Pick<NodeAttachment, 'name' | 'dataUrl'>): NodeAttachment {
  return {
    id: partial.id ?? partial.name,
    mimeType: partial.mimeType ?? '',
    size: partial.size ?? 10,
    ...partial
  };
}

describe('inferMimeType', () => {
  it('keeps an explicit non-octet mime', () => {
    expect(inferMimeType('x.bin', 'image/png')).toBe('image/png');
  });

  it('falls back to the file extension when mime is missing or octet-stream', () => {
    expect(inferMimeType('notes.md', '')).toBe('text/markdown');
    expect(inferMimeType('doc.pdf', 'application/octet-stream')).toBe('application/pdf');
  });
});

describe('decodeDataUrlToText', () => {
  it('decodes base64 and URL-encoded payloads', () => {
    expect(decodeDataUrlToText(dataUrl('text/plain', 'hello'))).toBe('hello');
    expect(decodeDataUrlToText(dataUrl('text/plain', 'a b', false))).toBe('a b');
  });

  it('returns null for garbage', () => {
    expect(decodeDataUrlToText('not-a-data-url')).toBeNull();
  });
});

describe('nodeToMessageContent — no attachments', () => {
  it('returns the raw string, including empty', () => {
    expect(nodeToMessageContent({ content: 'Hi', attachments: [] })).toBe('Hi');
    expect(nodeToMessageContent({ content: '', attachments: undefined })).toBe('');
  });
});

describe('nodeToMessageContent — images', () => {
  const png = dataUrl('image/png', 'PNG');

  it('returns multimodal parts: text + image_url', () => {
    const content = nodeToMessageContent({
      content: 'look',
      attachments: [attach({ name: 'a.png', mimeType: 'image/png', dataUrl: png })]
    });
    expect(Array.isArray(content)).toBe(true);
    const parts = content as MessagePart[];
    expect(parts[0]).toEqual({ type: 'text', text: 'look' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: png } });
  });

  it('omits the text part when the node has no caption', () => {
    const content = nodeToMessageContent({
      content: '   ',
      attachments: [attach({ name: 'a.png', mimeType: 'image/png', dataUrl: png })]
    }) as MessagePart[];
    expect(partsTypes(content)).toEqual(['image_url']);
  });

  it('sends several images in attachment order', () => {
    const a = dataUrl('image/jpeg', 'A');
    const b = dataUrl('image/webp', 'B');
    const content = nodeToMessageContent({
      content: 'two',
      attachments: [
        attach({ name: 'a.jpg', mimeType: 'image/jpeg', dataUrl: a }),
        attach({ name: 'b.webp', mimeType: 'image/webp', dataUrl: b })
      ]
    }) as MessagePart[];
    expect(content.filter(p => p.type === 'image_url')).toHaveLength(2);
  });
});

describe('nodeToMessageContent — textual files', () => {
  it('inlines decoded text under an attached-file banner', () => {
    const content = nodeToMessageContent({
      content: 'please read',
      attachments: [attach({
        name: 'note.txt',
        mimeType: 'text/plain',
        dataUrl: dataUrl('text/plain', 'secret lore')
      })]
    });
    expect(typeof content).toBe('string');
    expect(content).toContain('please read');
    expect(content).toContain('--- attached file: note.txt (text/plain) ---');
    expect(content).toContain('secret lore');
  });

  it('inlines json by mime, not by name', () => {
    const content = nodeToMessageContent({
      content: '',
      attachments: [attach({
        name: 'stats.json',
        mimeType: 'application/json',
        dataUrl: dataUrl('application/json', '{"hp":3}')
      })]
    }) as string;
    expect(content).toContain('{"hp":3}');
  });
});

describe('nodeToMessageContent — binary files (pdf etc.)', () => {
  const pdf = dataUrl('application/pdf', '%PDF-1.4');

  it('adds a file part and lists the name in the text', () => {
    const content = nodeToMessageContent({
      content: 'see pdf',
      attachments: [attach({ name: 'brief.pdf', mimeType: 'application/pdf', dataUrl: pdf })]
    }) as MessagePart[];
    expect(partsTypes(content)).toEqual(['text', 'file']);
    expect((content[0] as { text: string }).text).toContain('[Attached files]');
    expect((content[0] as { text: string }).text).toContain('brief.pdf');
    expect(content[1]).toEqual({
      type: 'file',
      file: { filename: 'brief.pdf', file_data: pdf }
    });
  });

  it('lists attachments that have no usable data url', () => {
    const content = nodeToMessageContent({
      content: '',
      attachments: [attach({ name: 'gone.bin', mimeType: 'application/octet-stream', dataUrl: '' })]
    }) as string;
    expect(content).toContain('[Attached files missing data]');
    expect(content).toContain('gone.bin');
  });
});

describe('nodeToMessageContent — mixed bag', () => {
  it('orders text (caption + inlined files + file lists), then images, then file parts', () => {
    const img = dataUrl('image/png', 'IMG');
    const pdf = dataUrl('application/pdf', 'PDF');
    const txt = dataUrl('text/plain', 'TXTBODY');
    const content = nodeToMessageContent({
      content: 'caption',
      attachments: [
        attach({ name: 'pic.png', mimeType: 'image/png', dataUrl: img }),
        attach({ name: 'note.txt', mimeType: 'text/plain', dataUrl: txt }),
        attach({ name: 'doc.pdf', mimeType: 'application/pdf', dataUrl: pdf })
      ]
    }) as MessagePart[];
    expect(partsTypes(content)).toEqual(['text', 'image_url', 'file']);
    const text = (content[0] as { text: string }).text;
    expect(text.startsWith('caption')).toBe(true);
    expect(text).toContain('TXTBODY');
    expect(text).toContain('[Attached files]');
    expect(text).toContain('doc.pdf');
  });
});

describe('normalizeChatMessages', () => {
  it('passes string content through', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(normalizeChatMessages(msgs)).toEqual(msgs);
  });

  it('collapses a lone text part back to a string', () => {
    const msgs: ChatMessage[] = [{
      role: 'assistant',
      content: [{ type: 'text', text: 'only' }] as never
    }];
    expect(normalizeChatMessages(msgs)[0].content).toBe('only');
  });

  it('prepends a placeholder when media has no text', () => {
    const png = dataUrl('image/png', 'x');
    const msgs: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: png } }] as never
    }];
    const out = normalizeChatMessages(msgs)[0].content as MessagePart[];
    expect(out[0]).toEqual({ type: 'text', text: 'See the attached file(s).' });
    expect(out[1].type).toBe('image_url');
  });

  it('drops empty or malformed parts', () => {
    const msgs: ChatMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: '' },
        { type: 'image_url', image_url: { url: 'not-a-url' } },
        { type: 'file', file: { filename: 'x', file_data: 'nope' } }
      ] as never
    }];
    expect(normalizeChatMessages(msgs)[0].content).toBe('');
  });
});

function partsTypes(parts: MessagePart[]): string[] {
  return parts.map(p => p.type);
}
