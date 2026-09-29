import { ChatMessage, ChatNode, NodeAttachment } from '../../models/chat';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

const TEXT_EMBED_LIMIT = 80_000;

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  jsx: 'text/plain',
  py: 'text/x-python',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  kt: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  cc: 'text/plain',
  hpp: 'text/plain',
  cs: 'text/plain',
  php: 'text/plain',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  log: 'text/plain',
  sql: 'text/plain',
  rtf: 'text/rtf'
};

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function inferMimeType(name: string, mimeType?: string | null): string {
  const given = (mimeType || '').trim().toLowerCase();
  if (given && given !== 'application/octet-stream') return given;

  const fromName = EXT_MIME[fileExtension(name)];
  if (fromName) return fromName;

  const fromDataUrl = mimeFromDataUrl(typeof mimeType === 'string' && mimeType.startsWith('data:') ? mimeType : '');
  return fromDataUrl || given || 'application/octet-stream';
}

export function mimeFromDataUrl(dataUrl?: string | null): string | null {
  if (!dataUrl) return null;
  const match = /^data:([^;,]+)/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() || null;
}

export function resolvedMime(attachment: Pick<NodeAttachment, 'name' | 'mimeType' | 'dataUrl'>): string {
  return inferMimeType(
    attachment.name,
    attachment.mimeType || mimeFromDataUrl(attachment.dataUrl) || ''
  );
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

export function isTextualMime(mime: string): boolean {
  if (mime.startsWith('text/')) return true;
  return [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/yaml',
    'application/x-yaml',
    'application/toml',
    'application/sql',
    'application/rtf'
  ].includes(mime);
}

// ---------------------------------------------------------------------------
// Image-generation responses
// ---------------------------------------------------------------------------

/** One image returned by an image-capable chat completion. */
export interface LlmImagePart {
  /** `data:…;base64,…` or `https://…` URL of the generated image. */
  url: string;
  /** Optional provider-supplied caption / alt text. */
  altText?: string;
}

/**
 * OpenAI-style refusal: when a model declines to generate (e.g. a content
 * policy refusal), some providers return a 200 whose message carries a
 * `refusal` field instead of content. Read it so the user can see WHY nothing
 * was drawn.
 */
export function extractLlmRefusal(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const root = json as Record<string, unknown>;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const choice = choices[0];
  if (!choice || typeof choice !== 'object') return '';
  const message = (choice as Record<string, unknown>)['message'];
  if (!message || typeof message !== 'object') return '';
  const refusal = (message as Record<string, unknown>)['refusal'];
  return typeof refusal === 'string' ? refusal.trim() : '';
}

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif'
};

function isImageUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(data:|https?:\/\/)/i.test(value);
}

/**
 * Pull image URLs out of free-text content. Several gateways (notably
 * OpenRouter and some Gemini/GLM image models) return the generated image not
 * as a structured part but as a markdown link (`![…](https://…)`) or a bare
 * URL inside the assistant text. Deduplicates and keeps usable URLs only.
 */
function extractImageUrlsFromText(text: string): string[] {
  const out: string[] = [];
  const md = /!\[[^\]]*\]\(\s*['"]?([^'")>\s]+)['"]?\s*\)/g;
  const bare = /https?:\/\/[^\s<)"'`]+/g;
  let m: RegExpExecArray | null;
  while ((m = md.exec(text))) {
    const u = m[1];
    if (isImageUrl(u) && !out.includes(u)) out.push(u);
  }
  for (const u of text.match(bare) ?? []) {
    if (isImageUrl(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Pull generated images out of a non-stream chat-completion payload.
 *
 * Image-capable models reply with `choices[].message.content` as an array of
 * parts, including `{ type: 'image_url', image_url: { url } }`. Some gateways
 * use `images` arrays, root-level `data[].url` / `b64_json`, an OpenRouter-
 * style `output` list, or — very commonly — a markdown/plain URL inside a
 * plain string `content`. We scan all of those shapes and keep only images
 * that can actually be rendered (data: or http(s) URLs).
 */
export function extractLlmImages(json: unknown): LlmImagePart[] {
  if (!json || typeof json !== 'object') return [];
  const out: LlmImagePart[] = [];

  const pushUrl = (u: unknown, alt?: unknown): void => {
    if (isImageUrl(u)) out.push({ url: u, altText: typeof alt === 'string' ? alt : undefined });
  };

  const pushTextUrls = (text: unknown): void => {
    if (typeof text !== 'string') return;
    for (const url of extractImageUrlsFromText(text)) {
      out.push({ url });
    }
  };

  /** Scan one message/content array whose items are part objects (or URLs). */
  const scanParts = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const part of list) {
      if (typeof part === 'string') {
        pushTextUrls(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p['image_url'] && typeof p['image_url'] === 'object') {
        const iu = p['image_url'] as Record<string, unknown>;
        pushUrl(iu['url'], iu['alt_text'] ?? iu['alt']);
      } else if (p['image_url'] !== undefined) {
        pushUrl(p['image_url'], p['alt']);
      } else if (isImageUrl(p['url'])) {
        pushUrl(p['url'], p['alt_text'] ?? p['alt']);
      } else if (isImageUrl(p['data_url']) || isImageUrl(p['data'])) {
        pushUrl(p['data_url'] ?? p['data'], p['alt'] ?? p['alt_text']);
      } else if (typeof p['b64_json'] === 'string') {
        out.push({ url: `data:image/png;base64,${p['b64_json']}` });
      }
    }
  };

  /** Scan content that may be a string (markdown/URL) or a parts array. */
  const scanContent = (content: unknown): void => {
    if (typeof content === 'string') {
      pushTextUrls(content);
      return;
    }
    scanParts(content);
  };

  const choices = (json as Record<string, unknown>)['choices'];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Record<string, unknown>;
      const message = c['message'];
      if (message && typeof message === 'object') {
        const m = message as Record<string, unknown>;
        scanContent(m['content']);
        scanParts(m['images']);
      }
      scanParts(c['images']);
    }
  }

  const root = json as Record<string, unknown>;
  scanParts(root['images']);

  const data = root['data'];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') {
        pushTextUrls(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const d = item as Record<string, unknown>;
      pushUrl(d['url'], d['alt_text'] ?? d['alt']);
      if (isImageUrl(d['data_url']) || isImageUrl(d['data'])) {
        pushUrl(d['data_url'] ?? d['data'], d['alt'] ?? d['alt_text']);
      }
      if (typeof d['b64_json'] === 'string') {
        out.push({ url: `data:image/png;base64,${d['b64_json']}` });
      }
    }
  }
  if (typeof root['b64_json'] === 'string') {
    out.push({ url: `data:image/png;base64,${root['b64_json']}` });
  }

  const output = root['output'];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string') {
        pushTextUrls(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      scanContent(o['content']);
      pushUrl(o['url'], o['alt_text'] ?? o['alt']);
      scanParts(o['images']);
    }
  }

  return out;
}

/** Estimate the byte size of a data/caption URL (used for attachment.size). */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl.length;
  const payload = dataUrl.slice(comma + 1);
  const header = dataUrl.slice(0, comma);
  if (header.includes(';base64')) {
    return Math.round((payload.length * 3) / 4);
  }
  return payload.length;
}

/**
 * Convert a returned image part into a `NodeAttachment` so it can be stored on
 * a chat node and rendered by the existing attachment UI. The `id` is left
 * empty — the caller assigns a persistent one via `newId()`.
 */
export function imagePartToAttachment(part: LlmImagePart, index: number): NodeAttachment {
  const mime = mimeFromDataUrl(part.url) || (part.url.startsWith('https://') ? 'image/png' : 'application/octet-stream');
  const ext = IMAGE_MIME_EXT[mime] ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'png';
  return {
    id: '',
    name: `illustration-${index + 1}.${ext}`,
    mimeType: mime,
    size: estimateDataUrlBytes(part.url),
    dataUrl: part.url
  };
}

/**
 * Turn a plain-text string (e.g. the exact prompt used to generate an image)
 * into a `text/plain` NodeAttachment so it can be stored on the same node as
 * the picture and found later — and so the prompt used for a REFUSED image is
 * preserved even when the model returned nothing. `id` is left empty — the
 * caller assigns a persistent one via `newId()`.
 */
export function textPromptAttachment(name: string, text: string): NodeAttachment {
  const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  return {
    id: '',
    name,
    mimeType: 'text/plain',
    size: text.length,
    dataUrl
  };
}

export function decodeDataUrlToText(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;

  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const base64 = /;base64/i.test(header);

  try {
    if (base64) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

function clipText(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEXT_EMBED_LIMIT) return { text, truncated: false };
  return {
    text: text.slice(0, TEXT_EMBED_LIMIT) + `\n\n[truncated, original ${text.length} characters]`,
    truncated: true
  };
}

function hasUsableDataUrl(dataUrl?: string | null): dataUrl is string {
  return !!dataUrl && dataUrl.startsWith('data:') && dataUrl.includes(',');
}

/**
 * Convert a chat node into OpenAI-compatible message content.
 * Images become image_url parts. Text-like files are inlined. Other files
 * are sent as file parts so providers that accept document input can read them.
 */
export function nodeToMessageContent(
  node: Pick<ChatNode, 'content' | 'attachments'>
): string | MessagePart[] {
  const attachments = node.attachments || [];
  if (attachments.length === 0) {
    return node.content || '';
  }

  const images: NodeAttachment[] = [];
  const textual: NodeAttachment[] = [];
  const files: NodeAttachment[] = [];

  for (const raw of attachments) {
    const mime = resolvedMime(raw);
    if (isImageMime(mime) && hasUsableDataUrl(raw.dataUrl)) {
      images.push(raw);
    } else if (isTextualMime(mime) && hasUsableDataUrl(raw.dataUrl)) {
      textual.push(raw);
    } else if (hasUsableDataUrl(raw.dataUrl)) {
      files.push(raw);
    } else {
      files.push(raw);
    }
  }

  const textChunks: string[] = [];
  if (node.content?.trim()) textChunks.push(node.content);

  for (const file of textual) {
    const decoded = decodeDataUrlToText(file.dataUrl);
    if (decoded != null) {
      const { text } = clipText(decoded);
      textChunks.push(`--- attached file: ${file.name} (${resolvedMime(file)}) ---\n${text}`);
    } else {
      textChunks.push(`--- attached file: ${file.name} (${resolvedMime(file)}) [could not decode] ---`);
    }
  }

  const missing = files.filter(f => !hasUsableDataUrl(f.dataUrl));
  const sendableFiles = files.filter(f => hasUsableDataUrl(f.dataUrl));

  if (missing.length) {
    textChunks.push(
      '[Attached files missing data]\n' +
      missing.map(a => `- ${a.name} (${resolvedMime(a)})`).join('\n')
    );
  }

  if (sendableFiles.length) {
    textChunks.push(
      '[Attached files]\n' +
      sendableFiles.map(a => `- ${a.name} (${resolvedMime(a)})`).join('\n')
    );
  }

  const parts: MessagePart[] = [];
  const text = textChunks.join('\n\n');
  if (text.trim()) {
    parts.push({ type: 'text', text });
  }

  for (const img of images) {
    parts.push({
      type: 'image_url',
      image_url: { url: img.dataUrl }
    });
  }

  for (const file of sendableFiles) {
    parts.push({
      type: 'file',
      file: {
        filename: file.name,
        file_data: file.dataUrl
      }
    });
  }

  if (parts.length === 0) {
    return node.content || '';
  }
  if (parts.length === 1 && parts[0].type === 'text') {
    return parts[0].text;
  }
  return parts;
}

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (typeof message.content === 'string') return message;
    if (!Array.isArray(message.content)) return { ...message, content: '' };

    const parts: MessagePart[] = [];
    for (const raw of message.content as MessagePart[]) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.type === 'text') {
        const text = raw.text ?? '';
        if (text.length) parts.push({ type: 'text', text });
        continue;
      }
      if (raw.type === 'image_url') {
        const url = raw.image_url?.url;
        if (hasUsableDataUrl(url) || (typeof url === 'string' && /^https?:\/\//i.test(url))) {
          parts.push({ type: 'image_url', image_url: { url } });
        }
        continue;
      }
      if (raw.type === 'file') {
        const filename = raw.file?.filename;
        const fileData = raw.file?.file_data;
        if (filename && hasUsableDataUrl(fileData)) {
          parts.push({ type: 'file', file: { filename, file_data: fileData } });
        }
      }
    }

    const hasMedia = parts.some(p => p.type === 'image_url' || p.type === 'file');
    const hasText = parts.some(p => p.type === 'text' && p.text.trim());
    if (hasMedia && !hasText) {
      parts.unshift({ type: 'text', text: 'See the attached file(s).' });
    }

    if (parts.length === 0) return { ...message, content: '' };
    if (parts.length === 1 && parts[0].type === 'text') {
      return { ...message, content: parts[0].text };
    }
    return { ...message, content: parts };
  });
}
