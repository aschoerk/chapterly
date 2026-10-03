import { Injectable, signal } from '@angular/core';

/**
 * Hard upper bound on the NUMBER of LLM call records kept in the log buffer,
 * regardless of their byte size (safety net on top of the byte-size limit).
 * Content is stored WITHOUT shortening (the console one-liner is shortened,
 * the stored record keeps the full messages / prompt).
 */
export const LLM_LOG_LIMIT = 1000;

/** Default maximum total byte size of the stored log (50 MB). */
const DEFAULT_LOG_SIZE_LIMIT = 50 * 1024 * 1024;
/** Smallest allowed size limit (1 MB) — avoids accidental wipe-out. */
const MIN_LOG_SIZE_LIMIT = 1 * 1024 * 1024;
/** Largest allowed size limit (1 GB). */
const MAX_LOG_SIZE_LIMIT = 1024 * 1024 * 1024;
/** localStorage key for the user-configured size limit (bytes). */
const SIZE_LIMIT_STORAGE_KEY = 'chat.llmLog.sizeLimit';

/** Clamp a requested byte limit into the allowed range (default when invalid). */
export function clampLogSizeLimit(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_LOG_SIZE_LIMIT;
  return Math.min(MAX_LOG_SIZE_LIMIT, Math.max(MIN_LOG_SIZE_LIMIT, Math.round(bytes)));
}

/** One message as recorded in the log (full content, never shortened). */
export interface LlmLogMessage {
  role: string;
  content: unknown; // string | MessagePart[] — full, untruncated
}

/** Input to `LlmLogService.record`. */
export interface LlmLogInput {
  kind: 'chat' | 'image';
  modelId: string;
  provider: string;
  /** Id of the chat this call was made for (the currently selected chat). */
  chatId?: string;
  /** Title of the chat this call was made for (for the log output). */
  chatTitle?: string;
  /** The orchestration use case this call belongs to (e.g. render-node,
   *  structure-title, append, …). Absent for legacy (non-orchestration) calls. */
  usecase?: string;
  endpoint?: string;
  /** Full message array for chat-completions requests. */
  messages?: LlmLogMessage[];
  /** Full single prompt for the images endpoint. */
  prompt?: string;
  /** The COMPLETE request payload as actually sent to the provider (the
   *  exact JSON body: model, all messages in full, temperature/stream AND
   *  every extra). This is what guarantees nothing about the request is
   *  lost — the full last message and the "rest of the json" are both here,
   *  verbatim and untruncated. */
  body?: Record<string, unknown>;
  /** Request extras (modalities, reasoning, n, …) for diagnosis. */
  extras?: Record<string, unknown>;
}

/** One stored log entry. */
export interface LlmLogEntry extends LlmLogInput {
  /** Monotonic auto-increment key (order). */
  seq: number;
  /** Epoch milliseconds timestamp. */
  ts: number;
  /** ISO-8601 timestamp (UTC). */
  iso: string;
  /** Short one-line summary (same shape as the console line). */
  summary: string;
  /**
   * The FULL response JSON of the chat-completions / images call, attached
   * after the request completes (exactly what the provider returned — image
   * parts, refusal text, usage, …). Null while the request is in flight.
   */
  response?: unknown;
  /**
   * Set when the request failed: the raw error text (e.g. the provider's
   * moderation/404 payload) and the HTTP status.
   */
  error?: { status: number; text: string };
  /** True once a response OR error has been attached. */
  completed?: boolean;
  /**
   * UTF-8 byte size of the stored content: the request body / prompt /
   * messages at record time, updated on complete() to also include the
   * response (or error). Approximates the on-disk size of the entry.
   */
  size?: number;
}

const DB_NAME = 'chat-client-logs';
const DB_VERSION = 1;
const STORE = 'llmLogs';

/**
 * Short, safe label of a message's content type: `text`, a text+image_url/…
 * parts list, or `empty`. Never includes payload bytes.
 */
export function contentKindLabel(content: unknown): string {
  if (typeof content === 'string') return content.trim() ? 'text' : 'empty';
  if (Array.isArray(content)) {
    if (content.length === 0) return 'empty';
    const types = content.map(p => (p && typeof p === 'object' && (p as { type?: unknown }).type ? (p as { type: string }).type : '?')).join('+');
    return `parts[${content.length}]:${types}`;
  }
  return String(typeof content);
}

/**
 * Truncated, single-line content preview of a message (or its text parts) for
 * the console one-liner. Truncates at `max` chars; never dumps base64 / file
 * payloads. The FULL content is kept in the IndexedDB log entry.
 */
export function contentPreview(content: unknown, max = 160): string {
  if (typeof content === 'string') return contentPreviewText(content, max);
  if (Array.isArray(content)) {
    const pieces = content.map(p => {
      if (p && typeof p === 'object') {
        const obj = p as { type?: unknown; text?: unknown; image_url?: unknown; file?: unknown };
        if (obj.type === 'text' && typeof obj.text === 'string') return contentPreviewText(obj.text, max);
        if (obj.type === 'image_url') return '[image_url:<data>]';
        if (obj.type === 'file') return '[file:<data>]';
        if (obj.type !== undefined) return `[${obj.type}]`;
      }
      return String(p ?? '');
    });
    return pieces.filter(Boolean).join(' ');
  }
  return contentPreviewText(content == null ? '' : String(content), max);
}

function contentPreviewText(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Single-line, console-safe label of a chat title (newlines collapsed,
 * double-quotes escaped, empty -> ''). Used in the one-line summary.
 */
function chatTitleLabel(title: string | undefined): string {
  if (!title || !title.trim()) return '';
  const t = title.replace(/\s+/g, ' ').trim();
  return ` chat="${t.replace(/"/g, '\\"')}"`;
}

/** ` usecase=<…>` label for the one-line summary (empty -> ''). */
function usecaseLabel(usecase: string | undefined): string {
  if (!usecase || !usecase.trim()) return '';
  const u = usecase.replace(/\s+/g, ' ').trim();
  return ` usecase=${u.replace(/"/g, '\\"')}`;
}

/**
 * UTF-8 byte size of the JSON-serialized value. Used to approximate the size
 * a log entry occupies (request + response). Never throws — a value that
 * cannot be serialized counts as 0 bytes.
 */
export function jsonByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
  } catch {
    return 0;
  }
}

/**
 * Size of the payload-bearing parts of a log entry (request + response),
 * i.e. everything except the bookkeeping fields (seq/ts/iso/summary).
 */
export function entryContentSize(entry: Pick<
  LlmLogEntry,
  'body' | 'messages' | 'prompt' | 'response' | 'error'
>): number {
  return jsonByteSize({
    body: entry.body ?? null,
    messages: entry.messages ?? null,
    prompt: entry.prompt ?? null,
    response: entry.response ?? null,
    error: entry.error ?? null
  });
}

/**
 * Builds the short one-line summary logged to console (and kept on the entry).
 * Works for both chat and image requests; content is previewed here only. When
 * the call was made in the context of a chat, its title is included too.
 */
export function summarizeLlmRequest(input: LlmLogInput): string {
  const head = `[llm:${input.kind}] model=${input.modelId} provider=${input.provider}${usecaseLabel(input.usecase)}${chatTitleLabel(input.chatTitle)}`;
  if (input.kind === 'image') {
    const text = input.prompt ?? '';
    return `${head} messages=1 first={text → "${contentPreview(text)}"} last={text → "${contentPreview(text)}"}`;
  }
  const list = input.messages ?? [];
  if (list.length === 0) return `${head} messages=0`;
  const summarizeMessage = (m: LlmLogMessage): string =>
    `${m.role}/${contentKindLabel(m.content)} → "${contentPreview(m.content)}"`;
  return `${head} messages=${list.length} first={${summarizeMessage(list[0])}} last={${summarizeMessage(list[list.length - 1])}}`;
}

/**
 * Log-buffer for outgoing LLM requests, backed by IndexedDB. Records the FULL
 * request content (never shortened) plus a timestamp. Pruning is SIZE-BASED:
 * as soon as the sum of all stored entries exceeds the configurable
 * `sizeLimit` (default 50 MB), the OLDEST entries are deleted until the total
 * is back under the limit — a hard `LLM_LOG_LIMIT` count cap still applies as
 * a safety net. In environments without IndexedDB (e.g. some test runners) it
 * degrades gracefully to an in-memory buffer so logging never breaks an LLM
 * call.
 */
@Injectable({ providedIn: 'root' })
export class LlmLogService {
  /** Newest-first entries, kept in sync for reactive viewers. */
  readonly entries = signal<LlmLogEntry[]>([]);
  /** Whether IndexedDB is available (vs the in-memory fallback). */
  readonly persisted = signal(false);
  /** Maximum total byte size of the stored log (configurable, default 50 MB). */
  readonly sizeLimit = signal<number>(DEFAULT_LOG_SIZE_LIMIT);

  private dbPromise: Promise<IDBDatabase> | null = null;
  private memory: LlmLogEntry[] = [];
  private memorySeq = 0;
  /** Serialized persist queue — lets `flush()` await all pending writes. */
  private tail: Promise<void> = Promise.resolve();

  constructor() {
    this.sizeLimit.set(this.readStoredSizeLimit());
    this.refresh().catch(() => { /* non-fatal */ });
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Record one LLM request: console.log the one-line summary synchronously,
   * then persist the FULL record to the IndexedDB buffer (FIFO, capped at
   * `LLM_LOG_LIMIT`). Fire-and-forget — never blocks the caller.
   */
  record(input: LlmLogInput): LlmLogEntry {
    const now = Date.now();
    const entry: LlmLogEntry = {
      ...input,
      seq: 0,
      ts: now,
      iso: new Date(now).toISOString(),
      summary: summarizeLlmRequest(input),
      size: jsonByteSize({
        body: input.body ?? null,
        messages: input.messages ?? null,
        prompt: input.prompt ?? null
      })
    };
    try {
      console.log(entry.summary);
    } catch { /* ignore */ }

    this.tail = this.tail.then(() => this.persistNow(entry)).catch(() => { /* keep queue alive */ });
    return entry;
  }

  /** Resolves once all currently-pending log writes have been persisted. */
  flush(): Promise<void> {
    return this.tail;
  }

  /**
   * Change the total byte-size cap for the stored log (clamped to the allowed
   * range, default 50 MB) and prune the log immediately if it now exceeds the
   * new limit. The value is persisted per-browser via localStorage.
   */
  setSizeLimit(bytes: number): Promise<void> {
    const clamped = clampLogSizeLimit(bytes);
    this.sizeLimit.set(clamped);
    try {
      localStorage.setItem(SIZE_LIMIT_STORAGE_KEY, String(clamped));
    } catch { /* non-fatal */ }
    this.tail = this.tail
      .then(() => this.prune())
      .catch(() => { /* keep queue alive */ })
      .finally(() => this.publish());
    return this.tail;
  }

  /** The configured per-browser size limit in bytes (default 50 MB). */
  private readStoredSizeLimit(): number {
    try {
      const raw = localStorage.getItem(SIZE_LIMIT_STORAGE_KEY);
      if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return clampLogSizeLimit(n);
      }
    } catch { /* non-fatal */ }
    return DEFAULT_LOG_SIZE_LIMIT;
  }

  /**
   * Attach the RESPONSE of a previously-recorded request (the raw JSON the
   * provider returned), or an ERROR when the call failed. Updates both the
   * in-memory entry and the stored record. Fire-and-forget — never blocks.
   */
  complete(
    entry: LlmLogEntry,
    result: { response?: unknown; error?: { status: number; text: string } }
  ): void {
    if (result.error) {
      entry.error = result.error;
      entry.response = undefined;
    } else {
      entry.response = result.response;
      entry.error = undefined;
    }
    entry.completed = true;
    // Recompute the entry size so it also covers the response/error payload.
    entry.size = entryContentSize(entry);

    this.tail = this.tail
      .then(async () => {
        const db = await this.persistedStore();
        await this.updateStored(db, entry);
        await this.prune();
      })
      .catch(() => { /* keep queue alive */ })
      .finally(() => this.publish());
  }

  /** Drop the whole log. */
  clear(): Promise<void> {
    this.tail = this.tail.then(async () => {
      try {
        const db = await this.persistedStore();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.objectStore(STORE).clear();
        });
      } catch { /* in-memory fallback: nothing to clear */ }
      this.memory = [];
      await this.publish();
    }).catch(() => { /* keep queue alive */ });
    return this.tail;
  }

  /** (Re)load the newest-first entries from the store into `entries`. */
  refresh(): Promise<void> {
    return Promise.resolve(this.persistedStore())
      .then(db => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        return new Promise<LlmLogEntry[]>((resolve, reject) => {
          req.onsuccess = () => resolve((req.result as LlmLogEntry[]) ?? []);
          req.onerror = () => reject(req.error);
        });
      })
      .then(list => {
        list.sort((a, b) => b.seq - a.seq);
        this.entries.set(list);
      })
      .catch(() => {
        this.entries.set([...this.memory].reverse());
      });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private persistNow(entry: LlmLogEntry): Promise<void> {
    return Promise.resolve(this.persistedStore())
      .then(db => this.insert(db, entry))
      .then(seq => {
        entry.seq = seq;
        return this.prune();
      })
      .catch(() => {
        // IDB unavailable or failed → in-memory fallback (also pruned to the
        // configured byte limit + count cap).
        this.memorySeq += 1;
        entry.seq = this.memorySeq;
        this.memory.push(entry);
        this.pruneMemory();
      })
      .finally(() => this.publish());
  }

  private persistedStore(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    // `indexedDB` may be absent (jsdom / node test runners).
    if (typeof indexedDB === 'undefined') {
      this.persisted.set(false);
      return this.dbPromise = Promise.reject(new Error('IndexedDB unavailable'));
    }
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
          }
        };
        req.onsuccess = () => {
          this.persisted.set(true);
          resolve(req.result);
        };
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
    // A failed open falls back to the in-memory buffer.
    this.dbPromise.catch(() => this.persisted.set(false));
    return this.dbPromise;
  }

  private insert(db: IDBDatabase, entry: LlmLogEntry): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      // autoIncrement generates the `seq` key — never store an explicit one.
      const { seq: _seq, ...rest } = entry;
      const req = store.add(rest as LlmLogEntry);
      req.onsuccess = () => resolve(Number(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  /** Update a stored record with its response/error (put with the same key). */
  private updateStored(db: IDBDatabase, entry: LlmLogEntry): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.put(entry as LlmLogEntry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Delete the OLDEST entries while the stored log exceeds the configured byte
   * `sizeLimit` (default 50 MB) — or the hard `LLM_LOG_LIMIT` count cap as a
   * safety net. Resolves once the pruning transaction has committed. In-memory
   * fallback mode prunes the memory array instead.
   */
  private prune(): Promise<void> {
    if (!this.persisted()) {
      this.pruneMemory();
      return Promise.resolve();
    }
    const dbPromise = this.dbPromise;
    if (!dbPromise) return Promise.resolve();
    return Promise.resolve(dbPromise)
      .then(database => new Promise<void>((resolve) => {
        const tx = database.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.getAll();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
        req.onsuccess = () => {
          const list = (req.result as LlmLogEntry[]) ?? [];
          // Oldest first (seq is the auto-increment insert order).
          list.sort((a, b) => a.seq - b.seq);
          let total = 0;
          for (const e of list) total += this.entrySize(e);
          let head = 0;
          while (
            head < list.length &&
            (list.length - head > LLM_LOG_LIMIT || total > this.sizeLimit())
          ) {
            const oldest = list[head++];
            total -= this.entrySize(oldest);
            store.delete(oldest.seq);
          }
        };
      }))
      .catch(() => { /* non-fatal */ });
  }

  /** Size of one entry, with a live fallback for legacy entries without `size`. */
  private entrySize(e: LlmLogEntry): number {
    return (typeof e.size === 'number' && e.size >= 0) ? e.size : entryContentSize(e);
  }

  /** Size-based + count-cap pruning of the in-memory fallback buffer. */
  private pruneMemory(): void {
    if (this.memory.length === 0) return;
    this.memory.sort((a, b) => a.seq - b.seq);
    let total = 0;
    for (const e of this.memory) total += this.entrySize(e);
    while (
      this.memory.length > 0 &&
      (this.memory.length > LLM_LOG_LIMIT || total > this.sizeLimit())
    ) {
      const oldest = this.memory.shift()!;
      total -= this.entrySize(oldest);
    }
  }

  /** Refresh `entries` from the store (newest first). */
  private publish(): void {
    this.refresh().catch(() => { /* non-fatal */ });
  }
}