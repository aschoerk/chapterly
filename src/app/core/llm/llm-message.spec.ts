import { describe, expect, it } from 'vitest';
import {
  decodeDataUrlToText,
  estimateDataUrlBytes,
  extractLlmImages,
  extractLlmRefusal,
  imagePartToAttachment,
  inferMimeType,
  isGeneratedImageAttachment,
  isPromptRecordAttachment,
  nodeToMessageContent,
  normalizeChatMessages,
  textPromptAttachment,
  type MessagePart
} from './llm-message';
import { ChatMessage, NodeAttachment } from '../../models/chat';

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

describe('nodeToMessageContent — recorded image prompts are excluded from story context', () => {
  it('isPromptRecordAttachment matches prompt-N.txt / refused-prompt-N.txt', () => {
    expect(isPromptRecordAttachment({ name: 'prompt-1.txt' })).toBe(true);
    expect(isPromptRecordAttachment({ name: 'refused-prompt-3.txt' })).toBe(true);
    expect(isPromptRecordAttachment({ name: 'refused-prompt.txt' })).toBe(true);
    expect(isPromptRecordAttachment({ name: 'prompt.txt' })).toBe(true);
    expect(isPromptRecordAttachment({ name: 'notes.txt' })).toBe(false);
    expect(isPromptRecordAttachment({ name: 'a.png' })).toBe(false);
  });

  it('drops the prompt record attachment from the message content', () => {
    const content = nodeToMessageContent({
      content: 'chapter text',
      attachments: [
        attach({
          name: 'prompt-1.txt',
          mimeType: 'text/plain',
          dataUrl: dataUrl('text/plain', 'PAYLOAD_THAT_MUST_NOT_LEAK')
        }),
        attach({
          name: 'refused-prompt-2.txt',
          mimeType: 'text/plain',
          dataUrl: dataUrl('text/plain', 'Model reply: refused')
        })
      ]
    });
    expect(content).toBe('chapter text');
    expect(String(content)).not.toContain('PAYLOAD_THAT_MUST_NOT_LEAK');
    expect(String(content)).not.toContain('refused');
  });

  it('excludes generated illustrations (illustration-N.*) and their prompt files', () => {
    const png = dataUrl('image/png', 'PNG');
    const content = nodeToMessageContent({
      content: '',
      attachments: [
        attach({ name: 'prompt-1.txt', mimeType: 'text/plain', dataUrl: dataUrl('text/plain', 'x') }),
        attach({ name: 'illustration-1.png', mimeType: 'image/png', dataUrl: png })
      ]
    });
    // Both the companion prompt file AND the generated picture are internal
    // metadata — a node that only carries them has no story payload.
    expect(content).toBe('');
  });

  it('keeps hand-attached images while dropping generated illustrations', () => {
    const generated = dataUrl('image/png', 'GEN');
    const hand = dataUrl('image/jpeg', 'HAND');
    const content = nodeToMessageContent({
      content: '',
      attachments: [
        attach({ name: 'illustration-2.png', mimeType: 'image/png', dataUrl: generated }),
        attach({ name: 'reference.jpg', mimeType: 'image/jpeg', dataUrl: hand })
      ]
    }) as MessagePart[];
    // Only the hand-attached image is sent as an image_url part.
    expect(partsTypes(content)).toEqual(['image_url']);
    expect((content[0] as { image_url: { url: string } }).image_url.url).toBe(hand);
  });

  it('isGeneratedImageAttachment matches illustration-N.* but not arbitrary images', () => {
    expect(isGeneratedImageAttachment({ name: 'illustration-1.png' })).toBe(true);
    expect(isGeneratedImageAttachment({ name: 'illustration-12.jpg' })).toBe(true);
    expect(isGeneratedImageAttachment({ name: 'illustration.webp' })).toBe(false);
    expect(isGeneratedImageAttachment({ name: 'reference.jpg' })).toBe(false);
    expect(isGeneratedImageAttachment({ name: 'a.png' })).toBe(false);
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

describe('extractLlmImages', () => {
  const png = dataUrl('image/png', 'PNGDATA');

  it('extracts image_url parts from choices[0].message.content', () => {
    const json = {
      choices: [{
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Here you go' },
            { type: 'image_url', image_url: { url: png, alt_text: 'the train' } }
          ]
        }
      }]
    };
    expect(extractLlmImages(json)).toEqual([
      { url: png, altText: 'the train' }
    ]);
  });

  it('accepts https URLs as well as data URLs', () => {
    const json = {
      choices: [{ message: { content: [
        { type: 'image_url', image_url: { url: 'https://cdn.example/img.png' } }
      ] } }]
    };
    const [img] = extractLlmImages(json);
    expect(img.url).toMatch(/^https:\/\//);
  });

  it('reads a root-level data[].url / b64_json (OpenAI images style)', () => {
    const json = {
      data: [
        { url: 'https://cdn.example/a.png' },
        { b64_json: 'QUJD' }
      ]
    };
    const imgs = extractLlmImages(json);
    expect(imgs[0].url).toBe('https://cdn.example/a.png');
    expect(imgs[1].url).toBe('data:image/png;base64,QUJD');
  });

  it('returns [] for text-only payloads and garbage', () => {
    expect(extractLlmImages(null)).toEqual([]);
    expect(extractLlmImages({ choices: [{ message: { content: 'just text' } }] })).toEqual([]);
    expect(extractLlmImages({})).toEqual([]);
  });

  it('skips parts that are not usable image URLs', () => {
    const json = {
      choices: [{ message: { content: [
        { type: 'image_url', image_url: { url: 'ftp://nope' } },
        { type: 'file', file: { filename: 'x', file_data: 'y' } }
      ] } }]
    };
    expect(extractLlmImages(json)).toEqual([]);
  });

  it('extracts a markdown image link from a string content (OpenRouter/Gemini)', () => {
    const json = {
      choices: [{
        message: {
          content: 'Here is your painting: \n\n![Mara on the night train](https://cdn.example/paint.png "train")'
        }
      }]
    };
    expect(extractLlmImages(json)[0].url).toBe('https://cdn.example/paint.png');
  });

  it('extracts a bare https URL from string content', () => {
    const json = {
      choices: [{ message: { content: 'Image: https://cdn.example/a.png' } }]
    };
    expect(extractLlmImages(json)[0].url).toBe('https://cdn.example/a.png');
  });

  it('reads data_url entries (Anthropic-ish part shape)', () => {
    const png = dataUrl('image/png', 'QQ==');
    const json = {
      choices: [{ message: { content: [{ type: 'image', data_url: png }] } }]
    };
    expect(extractLlmImages(json)[0].url).toBe(png);
  });

  it('handles string entries in output.data style lists', () => {
    const json = { data: ['https://cdn.example/a.png'] };
    expect(extractLlmImages(json)[0].url).toBe('https://cdn.example/a.png');
  });
});

describe('extractLlmRefusal', () => {
  it('reads message.refusal from the first choice', () => {
    const json = {
      choices: [{
        message: {
          refusal: "I can't generate that image because it violates content policy.",
          content: ''
        }
      }]
    };
    expect(extractLlmRefusal(json)).toBe(
      "I can't generate that image because it violates content policy."
    );
  });

  it('returns empty when there is no refusal/choice', () => {
    expect(extractLlmRefusal(null)).toBe('');
    expect(extractLlmRefusal({ choices: [{ message: { content: 'ok' } }] })).toBe('');
    expect(extractLlmRefusal({})).toBe('');
  });
});

describe('imagePartToAttachment / estimateDataUrlBytes', () => {
  it('builds a NodeAttachment with mime + inferred extension + base64 size', () => {
    const png = dataUrl('image/png', 'PNGDATA');
    const a = imagePartToAttachment({ url: png }, 0);
    expect(a.mimeType).toBe('image/png');
    expect(a.name).toBe('illustration-1.png');
    expect(a.dataUrl).toBe(png);
    expect(a.id).toBe('');
    expect(a.size).toBe(estimateDataUrlBytes(png));
    expect(a.size).toBeGreaterThan(0);
  });

  it('defaults to image/png for https URLs where the mime cannot be inferred', () => {
    const a = imagePartToAttachment({ url: 'https://cdn.example/a.jpeg' }, 2);
    expect(a.mimeType).toBe('image/png');
    expect(a.name).toBe('illustration-3.png');
  });
});

describe('textPromptAttachment', () => {
  it('builds a text/plain attachment whose content round-trips', () => {
    const prompt = 'A quiet night train, Mara at the window.';
    const a = textPromptAttachment('prompt-1.txt', prompt);
    expect(a.name).toBe('prompt-1.txt');
    expect(a.mimeType).toBe('text/plain');
    expect(a.id).toBe('');
    expect(a.size).toBe(prompt.length);
    expect(decodeDataUrlToText(a.dataUrl)).toBe(prompt);
  });

  it('escapes special characters in the prompt', () => {
    const a = textPromptAttachment('refused-1.txt', 'heads & tails, "quoted" <angle> 100%');
    expect(decodeDataUrlToText(a.dataUrl)).toBe('heads & tails, "quoted" <angle> 100%');
  });
});

function partsTypes(parts: MessagePart[]): string[] {
  return parts.map(p => p.type);
}
