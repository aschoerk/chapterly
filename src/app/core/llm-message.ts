import { ChatMessage, ChatNode, NodeAttachment } from '../models/chat';

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
