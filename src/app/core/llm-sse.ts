/**
 * Provider-agnostic SSE assembler for OpenAI-compatible (and near-compatible)
 * chat completion streams.
 *
 * The Angular service should feed raw bytes into LlmSseParser and not try to
 * split lines itself. All of the "missing letter" edge cases live here.
 */

export interface LlmChunk {
  content?: string;
  thinking?: string;
}

export interface LlmSseResult {
  content: string;
  thinking: string;
  skippedEvents: number;
  parseErrors: number;
}

export interface LlmSseParserOptions {
  /** If true, treat snapshot-style fields (output.text, result) as cumulative. */
  cumulativeSnapshots?: boolean;
}

const DONE = '[DONE]';

export class LlmSseParser {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private content = '';
  private thinking = '';
  private skippedEvents = 0;
  private parseErrors = 0;
  private lastSnapshotContent = '';
  private lastSnapshotThinking = '';
  private readonly cumulativeSnapshots: boolean;

  constructor(options: LlmSseParserOptions = {}) {
    this.cumulativeSnapshots = options.cumulativeSnapshots ?? false;
  }

  pushBytes(bytes: Uint8Array): LlmChunk[] {
    if (!bytes.length) return [];
    return this.pushText(this.decoder.decode(bytes, { stream: true }));
  }

  pushText(text: string): LlmChunk[] {
    if (!text) return [];
    this.buffer += text;
    return this.drain(false);
  }

  /**
   * Call when the HTTP body is finished. Flushes the TextDecoder and any
   * trailing SSE event that never received a final blank line.
   */
  flush(): LlmChunk[] {
    const tail = this.decoder.decode();
    if (tail) this.buffer += tail;
    return this.drain(true);
  }

  result(): LlmSseResult {
    return {
      content: this.content,
      thinking: this.thinking,
      skippedEvents: this.skippedEvents,
      parseErrors: this.parseErrors
    };
  }

  private drain(endOfStream: boolean): LlmChunk[] {
    const chunks: LlmChunk[] = [];
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    while (true) {
      const sep = this.buffer.indexOf('\n\n');
      if (sep < 0) break;
      const rawEvent = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const chunk = this.consumeEvent(rawEvent);
      if (chunk) chunks.push(chunk);
    }

    if (endOfStream && this.buffer.trim()) {
      const chunk = this.consumeEvent(this.buffer);
      this.buffer = '';
      if (chunk) chunks.push(chunk);
    }

    return chunks;
  }

  private consumeEvent(rawEvent: string): LlmChunk | null {
    const dataLines: string[] = [];

    for (const rawLine of rawEvent.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(':')) continue;
      if (
        line.startsWith('event:') ||
        line.startsWith('id:') ||
        line.startsWith('retry:')
      ) {
        continue;
      }

      const payload = dataPayload(line);
      if (payload === null) continue;
      if (payload.trim() === DONE) return null;
      dataLines.push(payload);
    }

    if (dataLines.length === 0) {
      this.skippedEvents += 1;
      return null;
    }

    const json = parseJsonFromDataLines(dataLines);
    if (json === undefined) {
      this.parseErrors += 1;
      return null;
    }

    const extracted = extractLlmDelta(json);
    const contentBit = this.normalizePiece(extracted.content, 'content');
    const thinkingBit = this.normalizePiece(extracted.thinking, 'thinking');
    if (!contentBit && !thinkingBit) return null;

    if (contentBit) this.content += contentBit;
    if (thinkingBit) this.thinking += thinkingBit;
    return {
      content: contentBit || undefined,
      thinking: thinkingBit || undefined
    };
  }

  private normalizePiece(piece: string, kind: 'content' | 'thinking'): string {
    if (!piece) return '';
    if (!this.cumulativeSnapshots) return piece;

    const prev = kind === 'content' ? this.lastSnapshotContent : this.lastSnapshotThinking;
    let delta = piece;
    if (piece.startsWith(prev)) {
      delta = piece.slice(prev.length);
    }
    if (kind === 'content') this.lastSnapshotContent = piece;
    else this.lastSnapshotThinking = piece;
    return delta;
  }
}

/**
 * SSE joins multi-line `data:` fields with a newline. LLM gateways also split a
 * single JSON object across `data:` lines at arbitrary offsets, including inside
 * strings. Try concatenation first, then the spec join.
 */
export function parseJsonFromDataLines(dataLines: string[]): unknown | undefined {
  const candidates = [dataLines.join(''), dataLines.join('\n')];
  const seen = new Set<string>();
  for (const payload of candidates) {
    if (seen.has(payload)) continue;
    seen.add(payload);
    try {
      return JSON.parse(payload);
    } catch {
      /* try next join */
    }
  }
  return undefined;
}

/** Strip a leading `data:` / `data: ` prefix. Returns null if the line is not data. */
export function dataPayload(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('data:')) return null;
  const after = trimmed.slice(5);
  return after.startsWith(' ') ? after.slice(1) : after;
}

export function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map(part =>
        asText(
          typeof part === 'string' ? part : (part as { text?: unknown; content?: unknown })?.text
            ?? (part as { content?: unknown })?.content
        )
      )
      .join('');
  }
  if (typeof value === 'object' && value) {
    const obj = value as { text?: unknown; content?: unknown };
    if ('text' in obj) return asText(obj.text);
    if ('content' in obj) return asText(obj.content);
  }
  return '';
}

export function extractThinking(source: Record<string, unknown> | undefined): string {
  if (!source) return '';
  return asText(
    source['reasoning_content'] ??
    source['reasoning'] ??
    source['thinking'] ??
    source['reasoning_text']
  );
}

/**
 * Pull incremental text out of one parsed SSE JSON object.
 * Covers OpenAI, many CN compat gateways, and a few snapshot fields.
 */
export function extractLlmDelta(json: unknown): { content: string; thinking: string } {
  if (!json || typeof json !== 'object') return { content: '', thinking: '' };
  const root = json as Record<string, unknown>;

  const choice = Array.isArray(root['choices'])
    ? (root['choices'][0] as Record<string, unknown> | undefined)
    : undefined;
  const delta = (choice?.['delta'] ?? {}) as Record<string, unknown>;
  const message = (choice?.['message'] ?? {}) as Record<string, unknown>;

  let content =
    asText(delta['content']) ||
    asText(message['content']) ||
    asText(root['result']) ||
    asText((root['output'] as Record<string, unknown> | undefined)?.['text']);

  // Qianfan classic sometimes nests { result: { result: "..." } } — asText already
  // follows .content/.text, so also try a plain string result.
  if (!content && typeof root['result'] === 'object' && root['result']) {
    const nested = root['result'] as Record<string, unknown>;
    content = asText(nested['result']) || asText(nested['content']);
  }

  const thinking =
    extractThinking(delta) ||
    extractThinking(message) ||
    extractThinking(root);

  return { content, thinking };
}

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onChunk?: (chunk: LlmChunk) => void,
  options?: LlmSseParserOptions
): Promise<LlmSseResult> {
  const parser = new LlmSseParser(options);
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        for (const chunk of parser.pushBytes(value)) onChunk?.(chunk);
      }
    }
    for (const chunk of parser.flush()) onChunk?.(chunk);
  } catch (err: any) {
    for (const chunk of parser.flush()) onChunk?.(chunk);
    if (err?.name === 'AbortError') return parser.result();
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return parser.result();
}

/**
 * The original line-oriented parser from llm.service.ts, kept so tests can
 * show exactly which frames it drops. Do not use this in production.
 */
export function parseSseNaive(text: string): { content: string; thinking: string } {
  let content = '';
  let thinking = '';
  let buffer = text;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') continue;
    if (!trimmed.startsWith('data: ')) continue;
    try {
      const json = JSON.parse(trimmed.slice(6));
      const delta = json.choices?.[0]?.delta ?? {};
      const contentBit = asText(delta.content);
      const thinkingBit = extractThinking(delta);
      if (contentBit) content += contentBit;
      if (thinkingBit) thinking += thinkingBit;
    } catch {
      /* incomplete SSE line — discarded */
    }
  }

  return { content, thinking };
}

export function openaiData(delta: string, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: delta, ...extra } }]
  })}`;
}
