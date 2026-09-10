import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ChatService } from '../../core/chat.service';
import { ProjectService } from '../../core/project.service';
import { PersonaService } from '../../core/persona.service';
import {
  BUNDLE_FORMAT,
  BundleScope,
  BundleService,
  ChatBundle,
  ImportPolicy
} from '../../core/bundle.service';
import { Project } from '../../models/chat';
import { I18nService } from '../../core/i18n/i18n.service';

export interface ParsedTurn {
  role: 'system' | 'user' | 'assistant' | 'other';
  mappedType: 'user' | 'assistant' | 'system' | 'ignored';
  content: string;
  originalIndex: number;
  unknownBlocks: string[];
}

export interface CopilotEntry {
  name: string;
  prompt: string;
  description?: string;
}

export interface ParseResult {
  title: string;
  systemPrompt: string | null;
  turns: ParsedTurn[];
  format: string;
  warnings: string[];
  kind: 'chat' | 'copilots' | 'bundle';
  copilots?: CopilotEntry[];
  bundle?: ChatBundle;
}

/** One pending session waiting for project assignment */
export interface PendingSession {
  id: string;
  fileName: string;
  result: ParseResult;
  selectedProjectId: string | null;
}

interface ImportSummary {
  fileName: string;
  kind: 'chat' | 'copilots' | 'bundle';
  title: string;
  created: number;
  detail?: string;
  error?: string;
}

/** How much of a large file to ingest. Offset/length are byte positions. */
export interface SliceOptions {
  offset: number;
  length: number | null; // null = rest of file
}

const LARGE_FILE_BYTES = 8 * 1024 * 1024; // 8 MiB — stream instead of JSON.parse
const STREAM_CHUNK = 1024 * 1024;         // 1 MiB File.slice windows

@Component({
  selector: 'app-import',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './import.component.html',
  styleUrl: './import.component.css'
})
export class ImportComponent {
  readonly i18n = inject(I18nService);
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly personaService = inject(PersonaService);
  private readonly bundleService = inject(BundleService);
  private readonly router = inject(Router);

  readonly projects = this.projectService.projects;
  readonly topics = this.projectService.topics;
  readonly chats = this.chatService.chats;
  readonly personas = this.personaService.personas;

  readonly isDragging = signal(false);
  readonly isImporting = signal(false);
  readonly progress = signal('');
  readonly summaries = signal<ImportSummary[]>([]);
  readonly globalError = signal<string | null>(null);

  readonly pendingSessions = signal<PendingSession[]>([]);

  readonly exportScope = signal<BundleScope>('chat');
  readonly exportProjectId = signal<string | null>(null);
  readonly exportChatId = signal<string | null>(null);
  readonly includeChats = signal(true);
  readonly importPolicy = signal<ImportPolicy>('reuse');
  readonly isExporting = signal(false);

  constructor() {
    void this.bundleService.loadAll().then(() => {
      if (!this.exportChatId()) {
        this.exportChatId.set(this.chatService.currentChatId());
      }
      if (!this.exportProjectId()) {
        const current = this.chats().find(c => c.id === this.exportChatId());
        this.exportProjectId.set(current?.projectId ?? this.projects()[0]?.id ?? null);
      }
    });
  }

  needsProjectPicker(): boolean {
    const scope = this.exportScope();
    return scope === 'topic-project' || scope === 'project-chats' || scope === 'chats-only';
  }

  needsChatPicker(): boolean {
    const scope = this.exportScope();
    return scope === 'chat' || scope === 'chats-only';
  }

  needsIncludeChats(): boolean {
    return this.exportScope() === 'topic-project';
  }

  exportChatsForPicker() {
    const all = this.chats();
    const pid = this.exportProjectId();
    if (this.exportScope() === 'chats-only' && pid) {
      return all.filter(c => c.projectId === pid);
    }
    return all;
  }

  /** Optional byte window for huge Grok export files */
  sliceOffset = 0;
  sliceLength: number | null = null;
  useSlice = false;

  /** After a sliced read: byte where the first conversation actually started / last one ended */
  readonly lastAlignedStart = signal<number | null>(null);
  readonly lastAlignedEnd = signal<number | null>(null);

  // ------------------------------------------------------------------
  // Drag & drop / file selection
  // ------------------------------------------------------------------

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
    const files = event.dataTransfer?.files;
    if (files?.length) this.processFiles(Array.from(files));
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.processFiles(Array.from(input.files));
      input.value = '';
    }
  }

  private sliceOptions(): SliceOptions | null {
    if (!this.useSlice) return null;
    const offset = Math.max(0, Number(this.sliceOffset) || 0);
    const lengthRaw = this.sliceLength;
    const length =
      lengthRaw === null || lengthRaw === undefined || lengthRaw === ('' as any)
        ? null
        : Math.max(1, Number(lengthRaw) || 0);
    return { offset, length };
  }

  // ------------------------------------------------------------------
  // Main entry
  // ------------------------------------------------------------------

  private async processFiles(files: File[]) {
    this.isImporting.set(true);
    this.globalError.set(null);
    this.progress.set(this.i18n.t('import.processing', { count: files.length }));

    const newSummaries: ImportSummary[] = [];
    const newPending: PendingSession[] = [];
    const slice = this.sliceOptions();

    for (const file of files) {
      this.progress.set(this.i18n.t('import.reading', { name: file.name, size: this.formatBytes(file.size) }));
      try {
        const results = await this.parseFile(file, slice);
        for (const parsed of results) {
          if (parsed.kind === 'copilots') {
            const created = await this.importCopilots(parsed);
            newSummaries.push({
              fileName: file.name,
              kind: 'copilots',
              title: parsed.title,
              created
            });
          } else if (parsed.kind === 'bundle' && parsed.bundle) {
            const imported = await this.bundleService.importBundle(parsed.bundle, this.importPolicy());
            const created =
              imported.createdPersonas +
              imported.createdProjects +
              imported.createdTopics +
              imported.createdChats +
              imported.createdNodes;
            newSummaries.push({
              fileName: file.name,
              kind: 'bundle',
              title: parsed.title,
              created,
              detail: this.describeImport(imported),
              error: imported.warnings.length ? imported.warnings.join(' ') : undefined
            });
          } else {
              newPending.push({
                id: crypto.randomUUID(),
                fileName: file.name,
                result: parsed,
                selectedProjectId: this.findBestProjectId(parsed.title)
              });
          }
        }
      } catch (err: any) {
        newSummaries.push({
          fileName: file.name,
          kind: 'chat',
          title: file.name,
          created: 0,
          error: err?.message || String(err)
        });
      }
    }

    this.pendingSessions.update(list => [...list, ...newPending]);
    this.summaries.update(list => [...list, ...newSummaries]);
    this.progress.set('');
    this.isImporting.set(false);
  }

  private formatBytes(n: number): string {
    const fmt = (v: number, d: number) => this.i18n.formatNumber(v, { minimumFractionDigits: d, maximumFractionDigits: d });
    if (n < 1024) return `${this.i18n.formatNumber(n)} B`;
    if (n < 1024 * 1024) return `${fmt(n / 1024, 1)} KiB`;
    if (n < 1024 * 1024 * 1024) return `${fmt(n / (1024 * 1024), 1)} MiB`;
    return `${fmt(n / (1024 * 1024 * 1024), 2)} GiB`;
  }

  /**
   * Read a (possibly huge) file and return one ParseResult per conversation.
   *
   * Byte window rules when a slice is set:
   *   - the given offset is a *search start*: scan forward for the next
   *     JSON value (object/array) or known wrapper and begin there
   *   - the given end (offset+length) is a *soft* limit: if a value
   *     was already opened before that point, keep reading until its
   *     matching closing brace/bracket, even past the requested length
   */
  private async parseFile(file: File, slice: SliceOptions | null): Promise<ParseResult[]> {
    const rawStart = slice ? slice.offset : 0;
    const rawEnd = slice?.length != null
      ? Math.min(file.size, rawStart + slice.length)
      : file.size;
    if (rawStart >= file.size) {
      throw new Error(`Offset ${rawStart} is past end of file (${file.size} bytes)`);
    }

    const peekSize = Math.min(file.size - rawStart, 64 * 1024);
    const peekText = await this.readSlice(file, rawStart, peekSize);
    const kind = this.classifyPeek(peekText);

    const windowHint = rawEnd - rawStart;
    const shouldStream =
      !!slice ||
      windowHint >= LARGE_FILE_BYTES ||
      (kind !== 'value' && windowHint >= 2 * 1024 * 1024);

    if (!shouldStream) {
      const text = await this.readSlice(file, rawStart, windowHint);
      const data = JSON.parse(this.repairSlicedJson(text, !!slice));
      return this.detectAndParseAll(data);
    }

    this.progress.set(this.i18n.t('import.aligning', { name: file.name, start: rawStart }));
    return this.streamFile(file, rawStart, rawEnd, kind);
  }

  private classifyPeek(peekText: string): 'grok' | 'bundle' | 'array' | 'value' {
    if (
      /"conversations"\s*:/.test(peekText) ||
      /"conversation"\s*:\s*\{/.test(peekText)
    ) {
      return 'grok';
    }
    if (
      /"format"\s*:\s*"aschoerk\.chat\.bundle"/.test(peekText) ||
      (/"chats"\s*:\s*\[/.test(peekText) && /"projects"\s*:/.test(peekText))
    ) {
      return 'bundle';
    }
    const trimmed = peekText.trimStart();
    if (trimmed.startsWith('[')) return 'array';
    return 'value';
  }

  private async streamFile(
    file: File,
    rawStart: number,
    rawEnd: number,
    kind: 'grok' | 'bundle' | 'array' | 'value'
  ): Promise<ParseResult[]> {
    if (kind === 'grok') {
      return this.streamGrokConversations(file, rawStart, rawEnd);
    }
    if (kind === 'bundle') {
      return this.streamBundle(file, rawStart, rawEnd);
    }
    if (kind === 'array') {
      const arrayStart = await this.findNextJsonValueStart(file, rawStart);
      if (arrayStart == null) {
        throw new Error(`No JSON array found at or after byte ${rawStart}.`);
      }
      return this.streamTopLevelArray(file, arrayStart, rawEnd);
    }
    return this.streamJsonValue(file, rawStart, rawEnd);
  }

  private readSlice(file: File, offset: number, length: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file slice'));
      const blob = file.slice(offset, offset + length);
      reader.readAsText(blob);
    });
  }

  private readSliceBytes(file: File, offset: number, length: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(new Error('Failed to read file slice'));
      reader.readAsArrayBuffer(file.slice(offset, offset + length));
    });
  }

  /**
   * If the user cut a mid-array window, wrap the fragment so JSON.parse
   * can still succeed when the slice happens to contain complete objects.
   */
  private repairSlicedJson(text: string, sliced: boolean): string {
    const trimmed = text.trim();
    if (!sliced) return trimmed;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
    // raw objects dumped from the middle of an object/array
    if (/^"(conversation|responses|chats|projects|topics|personas|messages|mapping|nodes|turns)"/.test(trimmed)) {
      return `{${trimmed}}`;
    }
    return trimmed;
  }

  /** Skip whitespace and return the offset of the next `{` or `[`, or null. */
  private async findNextJsonValueStart(
    file: File,
    from: number,
    limit = file.size
  ): Promise<number | null> {
    let pos = Math.max(0, from);
    let inString = false;
    let escape = false;
    const stop = Math.min(limit, file.size);
    while (pos < stop) {
      const chunkLen = Math.min(STREAM_CHUNK, stop - pos);
      const bytes = await this.readSliceBytes(file, pos, chunkLen);
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (inString) {
          if (escape) escape = false;
          else if (b === 0x5c) escape = true;
          else if (b === 0x22) inString = false;
          continue;
        }
        if (b === 0x22) {
          inString = true;
          continue;
        }
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x2c || b === 0x3a) {
          continue;
        }
        if (b === 0x7b || b === 0x5b) {
          return pos + i;
        }
      }
      pos += chunkLen;
    }
    return null;
  }

  /** From `{` or `[` at `openOffset`, return the byte *after* the matching closer. */
  private async scanForwardToMatching(
    file: File,
    openOffset: number,
    initialDepth = 0
  ): Promise<number | null> {
    const head = await this.readSliceBytes(file, openOffset, 1);
    const openByte = head.length ? head[0] : 0x7b;
    const closeByte = openByte === 0x5b ? 0x5d : 0x7d;
    const pairOpen = openByte === 0x5b ? 0x5b : 0x7b;
    let pos = openOffset;
    let depth = initialDepth;
    let inString = false;
    let escape = false;
    let started = initialDepth > 0;

    while (pos < file.size) {
      const chunkLen = Math.min(STREAM_CHUNK, file.size - pos);
      const bytes = await this.readSliceBytes(file, pos, chunkLen);
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (inString) {
          if (escape) escape = false;
          else if (b === 0x5c) escape = true;
          else if (b === 0x22) inString = false;
          continue;
        }
        if (b === 0x22) {
          inString = true;
          continue;
        }
        if (b === pairOpen) {
          depth++;
          started = true;
        } else if (b === closeByte) {
          depth--;
          if (started && depth === 0) {
            return pos + i + 1;
          }
        }
      }
      pos += chunkLen;
    }
    return null;
  }

  private async readJsonRange(
    file: File,
    loc: { start: number; end: number }
  ): Promise<any | null> {
    let end = loc.end;
    for (let attempt = 0; attempt < 8; attempt++) {
      const json = await this.readSlice(file, loc.start, end - loc.start);
      try {
        const item = JSON.parse(this.repairSlicedJson(json, true));
        loc.end = end;
        return item;
      } catch {
        const next = await this.scanForwardToMatching(file, end, 1);
        if (next == null || next <= end) return null;
        end = next;
        this.progress.set(this.i18n.t('import.extending', { end }));
      }
    }
    return null;
  }

  private async findJsonKey(
    file: File,
    from: number,
    key: string
  ): Promise<{ keyStart: number; valueStart: number } | null> {
    const KEY = new TextEncoder().encode(`"${key}"`);
    let pos = Math.max(0, from);
    let carry = new Uint8Array(0);

    while (pos < file.size) {
      const chunkLen = Math.min(STREAM_CHUNK, file.size - pos);
      const chunk = await this.readSliceBytes(file, pos, chunkLen);
      const combined = this.concatBytes(carry, chunk);
      const base = pos - carry.length;

      let inString = false;
      let escape = false;
      for (let i = 0; i < combined.length; i++) {
        const b = combined[i];
        if (inString) {
          if (escape) escape = false;
          else if (b === 0x5c) escape = true;
          else if (b === 0x22) inString = false;
          continue;
        }
        if (b === 0x22) {
          if (this.bytesStartWith(combined, i, KEY) && this.isJsonKeyBytes(combined, i, KEY.length)) {
            const keyAbs = base + i;
            const valueStart = await this.skipToJsonValueStart(file, keyAbs + KEY.length);
            if (valueStart == null) {
              i += KEY.length - 1;
              continue;
            }
            if (keyAbs < from) {
              return this.findJsonKey(file, valueStart, key);
            }
            return { keyStart: keyAbs, valueStart };
          }
          inString = true;
          continue;
        }
      }

      const keep = KEY.length + 32;
      carry = combined.slice(Math.max(0, combined.length - keep));
      pos += chunkLen;
    }
    return null;
  }

  /** After a `"key"`, require `:` then the first non-space value byte. */
  private isJsonKeyBytes(bytes: Uint8Array, i: number, keyLen: number): boolean {
    let p = i + keyLen;
    while (p < bytes.length && (bytes[p] === 0x20 || bytes[p] === 0x09 || bytes[p] === 0x0a || bytes[p] === 0x0d)) p++;
    return p < bytes.length && bytes[p] === 0x3a;
  }

  private async skipToJsonValueStart(file: File, from: number): Promise<number | null> {
    let pos = from;
    let seenColon = false;
    while (pos < file.size) {
      const chunkLen = Math.min(4096, file.size - pos);
      const bytes = await this.readSliceBytes(file, pos, chunkLen);
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
        if (!seenColon) {
          if (b !== 0x3a) return null;
          seenColon = true;
          continue;
        }
        return pos + i;
      }
      pos += chunkLen;
    }
    return null;
  }

  private async readNamedJsonValue(file: File, from: number, key: string): Promise<any | undefined> {
    const loc = await this.findJsonKey(file, from, key);
    if (!loc) return undefined;
    const head = await this.readSliceBytes(file, loc.valueStart, 1);
    const b = head[0];
    const end = (b === 0x7b || b === 0x5b)
      ? await this.scanForwardToMatching(file, loc.valueStart)
      : await this.scanForwardToPrimitiveEnd(file, loc.valueStart);
    if (end == null) return undefined;
    return this.readJsonRange(file, { start: loc.valueStart, end });
  }

  /** End offset (exclusive) of a JSON primitive starting at `from`. */
  private async scanForwardToPrimitiveEnd(file: File, from: number): Promise<number | null> {
    let pos = from;
    let inString = false;
    let escape = false;
    let started = false;
    while (pos < file.size) {
      const chunkLen = Math.min(STREAM_CHUNK, file.size - pos);
      const bytes = await this.readSliceBytes(file, pos, chunkLen);
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (inString) {
          started = true;
          if (escape) escape = false;
          else if (b === 0x5c) escape = true;
          else if (b === 0x22) inString = false;
          continue;
        }
        if (!started && b === 0x22) {
          inString = true;
          started = true;
          continue;
        }
        if (b === 0x2c || b === 0x7d || b === 0x5d || b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
          if (!started && (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d)) continue;
          return pos + i;
        }
        started = true;
      }
      pos += chunkLen;
    }
    return started ? file.size : null;
  }

  private async streamArrayValues(
    file: File,
    arrayStart: number,
    rawEnd: number
  ): Promise<any[]> {
    const arrayEnd = await this.scanForwardToMatching(file, arrayStart);
    const hardEnd = arrayEnd == null ? file.size : arrayEnd;
    const items: any[] = [];
    let cursor = arrayStart + 1;
    let alignedStart: number | null = null;
    let alignedEnd = arrayStart;

    while (cursor < hardEnd) {
      const start = await this.findNextJsonValueStart(file, cursor, hardEnd);
      if (start == null || start >= hardEnd) break;

      const opener = await this.readSliceBytes(file, start, 1);
      if (opener[0] === 0x5d) break; // closing ]

      if (start >= rawEnd && items.length > 0) break;

      const end = await this.scanForwardToMatching(file, start);
      if (end == null) break;

      this.progress.set(
        this.i18n.t('import.readingConv', {
          start, end, size: this.formatBytes(end - start)
        })
      );

      const item = await this.readJsonRange(file, { start, end });
      if (item !== null && item !== undefined) {
        items.push(item);
        if (alignedStart == null) alignedStart = start;
      }
      alignedEnd = end;
      cursor = end;
      await Promise.resolve();
    }

    this.lastAlignedStart.set(alignedStart);
    this.lastAlignedEnd.set(alignedEnd);
    return items;
  }

  private async streamTopLevelArray(
    file: File,
    arrayStart: number,
    rawEnd: number
  ): Promise<ParseResult[]> {
    const items = await this.streamArrayValues(file, arrayStart, rawEnd);
    if (!items.length) {
      throw new Error(
        `No extractable array items at or after byte ${arrayStart}.`
      );
    }
    if (typeof items[0]?.name === 'string' && typeof items[0]?.prompt === 'string') {
      return [this.parseCopilots(items, [])];
    }
    const results: ParseResult[] = [];
    for (const item of items) {
      results.push(...this.detectAndParseAll(item));
    }
    if (!results.length) {
      throw new Error(
        `No extractable conversation at or after byte ${arrayStart}.`
      );
    }
    return results;
  }

  private async streamJsonValue(
    file: File,
    rawStart: number,
    rawEnd: number
  ): Promise<ParseResult[]> {
    const start = await this.findNextJsonValueStart(file, rawStart);
    if (start == null) {
      throw new Error(`No JSON value found at or after byte ${rawStart}.`);
    }
    const end = await this.scanForwardToMatching(file, start);
    if (end == null) {
      throw new Error(`Unclosed JSON value starting at byte ${start}.`);
    }
    this.lastAlignedStart.set(start);
    this.lastAlignedEnd.set(end);
    this.progress.set(
      this.i18n.t('import.readingConv', {
        start, end, size: this.formatBytes(end - start)
      })
    );
    const data = await this.readJsonRange(file, { start, end });
    if (data == null) {
      throw new Error(`Could not parse JSON value at bytes ${start}–${end}.`);
    }
    return this.detectAndParseAll(data);
  }

  private async streamBundle(
    file: File,
    rawStart: number,
    rawEnd: number
  ): Promise<ParseResult[]> {
    const projects = (await this.readNamedJsonValue(file, rawStart, 'projects')) || [];
    const topics = (await this.readNamedJsonValue(file, rawStart, 'topics')) || [];
    const personas = (await this.readNamedJsonValue(file, rawStart, 'personas')) || [];
    const scope = (await this.readNamedJsonValue(file, rawStart, 'scope')) || 'all-chats';
    const includeChats = (await this.readNamedJsonValue(file, rawStart, 'includeChats'));
    const exportedAt = (await this.readNamedJsonValue(file, rawStart, 'exportedAt')) || '';
    const version = (await this.readNamedJsonValue(file, rawStart, 'version')) || 2;

    const chatsKey = await this.findJsonKey(file, rawStart, 'chats');
    let chats: any[] = [];
    if (chatsKey) {
      const opener = await this.readSliceBytes(file, chatsKey.valueStart, 1);
      if (opener[0] === 0x5b) {
        chats = await this.streamArrayValues(file, chatsKey.valueStart, rawEnd);
      } else {
        const parsed = await this.readNamedJsonValue(file, rawStart, 'chats');
        chats = Array.isArray(parsed) ? parsed : [];
      }
    }

    const bundle: ChatBundle = {
      format: BUNDLE_FORMAT,
      version: typeof version === 'number' ? version : 2,
      exportedAt: typeof exportedAt === 'string' ? exportedAt : '',
      scope,
      includeChats: includeChats !== false && chats.length > 0,
      projects: Array.isArray(projects) ? projects : [],
      topics: Array.isArray(topics) ? topics : [],
      personas: Array.isArray(personas) ? personas : [],
      chats
    };
    return [this.parseBundle(bundle)];
  }

  // ------------------------------------------------------------------
  // Streaming extractor for { "conversations": [ {conversation, responses}, … ] }
  // Walks the file with File.slice(offset, offset+chunk) and brace-matches
  // each array element so a multi-hundred-MB export never sits fully in RAM
  // as a parsed object graph.
  // ------------------------------------------------------------------

  /**
   * Stream `conversations[]` items.
   * `rawStart` is a search origin (snapped forward to the next wrapper).
   * `rawEnd` is a soft stop: an object that started before rawEnd is always
   * read through its closing `}`.
   */
  private async streamGrokConversations(
    file: File,
    rawStart: number,
    rawEnd: number
  ): Promise<ParseResult[]> {
    const first = await this.findNextConversationObject(file, rawStart);
    if (!first) {
      throw new Error(
        `No "conversation" object found at or after byte ${rawStart}.`
      );
    }

    const results: ParseResult[] = [];
    let cursor = first.start;
    let alignedStart = first.start;
    let alignedEnd = first.end;

    while (cursor < file.size) {
      // Soft end: do not *open* a new conversation past the requested window.
      if (cursor >= rawEnd && results.length > 0) break;

      const loc = cursor === first.start
        ? first
        : await this.findNextConversationObject(file, cursor);
      if (!loc) break;

      if (loc.start >= rawEnd && results.length > 0) break;

      this.progress.set(
        this.i18n.t('import.readingConv', {
          start: loc.start, end: loc.end, size: this.formatBytes(loc.end - loc.start)
        })
      );

      const item = await this.readConversationJson(file, loc);
      if (!item) {
        cursor = loc.end;
        alignedEnd = loc.end;
        continue;
      }
      const parsed = this.parseGrokExportItem(item, []);
      if (parsed.turns.length || parsed.systemPrompt) {
        results.push(parsed);
      }

      alignedEnd = loc.end;
      cursor = loc.end;
      await Promise.resolve();
    }

    this.lastAlignedStart.set(alignedStart);
    this.lastAlignedEnd.set(alignedEnd);

    if (!results.length) {
      throw new Error(
        `No extractable conversation between snapped start ${alignedStart} and end ${alignedEnd}.`
      );
    }
    return results;
  }

  private static readonly KEY_CONVERSATION = new TextEncoder().encode('"conversation"');

  /**
   * Byte-accurate scan. JSON structure bytes (`{ } " \\`) are ASCII;
   * UTF-8 payload inside strings is never mistaken for them because
   * continuation bytes are all >= 0x80.
   */
  private async findNextConversationObject(
    file: File,
    from: number
  ): Promise<{ start: number; end: number } | null> {
    const KEY = ImportComponent.KEY_CONVERSATION;
    let pos = Math.max(0, from);
    let carry = new Uint8Array(0);

    while (pos < file.size) {
      const chunkLen = Math.min(STREAM_CHUNK, file.size - pos);
      const chunk = await this.readSliceBytes(file, pos, chunkLen);
      const combined = this.concatBytes(carry, chunk);
      const base = pos - carry.length;

      let inString = false;
      let escape = false;
      for (let i = 0; i < combined.length; i++) {
        const b = combined[i];
        if (inString) {
          if (escape) escape = false;
          else if (b === 0x5c) escape = true;
          else if (b === 0x22) inString = false;
          continue;
        }
        if (b === 0x22) {
          if (this.bytesStartWith(combined, i, KEY) && this.isConversationKeyBytes(combined, i)) {
            const keyAbs = base + i;
            const wrapperStart = await this.scanBackToWrapperStart(file, keyAbs);
            if (wrapperStart == null) {
              i += KEY.length - 1;
              continue;
            }
            const wrapperEnd = await this.scanForwardToMatchingBrace(file, wrapperStart);
            if (wrapperEnd == null) {
              i += KEY.length - 1;
              continue;
            }
            if (wrapperStart < from) {
              return this.findNextConversationObject(file, wrapperEnd);
            }
            return { start: wrapperStart, end: wrapperEnd };
          }
          inString = true;
          continue;
        }
      }

      const keep = KEY.length + 32;
      carry = combined.slice(Math.max(0, combined.length - keep));
      pos += chunkLen;
    }
    return null;
  }

  private concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (!a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  private bytesStartWith(hay: Uint8Array, i: number, needle: Uint8Array): boolean {
    if (i + needle.length > hay.length) return false;
    for (let k = 0; k < needle.length; k++) {
      if (hay[i + k] !== needle[k]) return false;
    }
    return true;
  }

  /** `"conversation"` followed by optional space, `:`, optional space, `{`. */
  private isConversationKeyBytes(bytes: Uint8Array, i: number): boolean {
    let p = i + ImportComponent.KEY_CONVERSATION.length;
    while (p < bytes.length && (bytes[p] === 0x20 || bytes[p] === 0x09 || bytes[p] === 0x0a || bytes[p] === 0x0d)) p++;
    if (p >= bytes.length || bytes[p] !== 0x3a) return false;
    p++;
    while (p < bytes.length && (bytes[p] === 0x20 || bytes[p] === 0x09 || bytes[p] === 0x0a || bytes[p] === 0x0d)) p++;
    return p < bytes.length && bytes[p] === 0x7b;
  }

  private async scanBackToWrapperStart(
    file: File,
    keyOffset: number,
    window = 256 * 1024
  ): Promise<number | null> {
    const from = Math.max(0, keyOffset - window);
    if (keyOffset <= from) return null;
    const bytes = await this.readSliceBytes(file, from, keyOffset - from);
    let depth = 0;
    let inString = false;
    for (let i = bytes.length - 1; i >= 0; i--) {
      const b = bytes[i];
      if (inString) {
        if (b === 0x22) {
          let slashes = 0;
          let j = i - 1;
          while (j >= 0 && bytes[j] === 0x5c) {
            slashes++;
            j--;
          }
          if (slashes % 2 === 0) inString = false;
        }
        continue;
      }
      if (b === 0x22) {
        inString = true;
        continue;
      }
      if (b === 0x7d) depth++;
      else if (b === 0x7b) {
        if (depth === 0) return from + i;
        depth--;
      }
    }
    if (from > 0 && window < 2 * 1024 * 1024) {
      return this.scanBackToWrapperStart(file, keyOffset, window * 2);
    }
    return null;
  }

  /** From the `{` at `braceOffset`, return the byte *after* its matching `}`. */
  private async scanForwardToMatchingBrace(
    file: File,
    braceOffset: number,
    initialDepth = 0
  ): Promise<number | null> {
    let pos = braceOffset;
    let depth = initialDepth;
    let inString = false;
    let escape = false;
    let started = initialDepth > 0;

    while (pos < file.size) {
      const chunkLen = Math.min(STREAM_CHUNK, file.size - pos);
      const bytes = await this.readSliceBytes(file, pos, chunkLen);
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (inString) {
          if (escape) escape = false;
          else if (b === 0x5c) escape = true;
          else if (b === 0x22) inString = false;
          continue;
        }
        if (b === 0x22) {
          inString = true;
          continue;
        }
        if (b === 0x7b) {
          depth++;
          started = true;
        } else if (b === 0x7d) {
          depth--;
          if (started && depth === 0) {
            return pos + i + 1;
          }
        }
      }
      pos += chunkLen;
    }
    return null;
  }

  /**
   * Read [start, end) as JSON. If parse fails (typically an early `}`
   * inside a mis-scanned string), keep looking forward until the slice
   * parses or the next conversation key appears.
   */
  private async readConversationJson(
    file: File,
    loc: { start: number; end: number }
  ): Promise<any | null> {
    let end = loc.end;
    for (let attempt = 0; attempt < 8; attempt++) {
      const json = await this.readSlice(file, loc.start, end - loc.start);
      try {
        const item = JSON.parse(json);
        loc.end = end;
        return item;
      } catch {
        const next = await this.scanForwardToMatchingBrace(file, end, 1);
        if (next == null || next <= end) return null;
        end = next;
        this.progress.set(
          this.i18n.t('import.extending', { end })
        );
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Smart project ordering
  // ------------------------------------------------------------------

  orderedProjectsFor(sessionTitle: string): { id: string | null; label: string }[] {
    const title = (sessionTitle || '').toLowerCase();
    const all = this.projects();

    const matching: Project[] = [];
    const rest: Project[] = [];

    for (const p of all) {
      if (title.includes(p.name.toLowerCase())) {
        matching.push(p);
      } else {
        rest.push(p);
      }
    }

    matching.sort((a, b) => a.name.localeCompare(b.name, this.i18n.localeId()));
    rest.sort((a, b) => a.name.localeCompare(b.name, this.i18n.localeId()));

    return [
      ...matching.map(p => ({ id: p.id, label: p.name })),
      { id: null, label: this.i18n.t('common.unknown') },
      ...rest.map(p => ({ id: p.id, label: p.name }))
    ];
  }

  private findBestProjectId(sessionTitle: string): string | null {
    const ordered = this.orderedProjectsFor(sessionTitle);
    return ordered.length && ordered[0].id !== null ? ordered[0].id : null;
  }

  // ------------------------------------------------------------------
  // Pending list actions
  // ------------------------------------------------------------------

  removeSession(id: string) {
    this.pendingSessions.update(list => list.filter(s => s.id !== id));
  }

  setSessionProject(id: string, projectId: string | null) {
    this.pendingSessions.update(list =>
      list.map(s => s.id === id ? { ...s, selectedProjectId: projectId } : s)
    );
  }

  async importPendingSessions() {
    const list = this.pendingSessions();
    if (list.length === 0) return;

    this.isImporting.set(true);
    this.progress.set(`Importing ${list.length} session(s)…`);

    const newSummaries: ImportSummary[] = [];

    for (const session of list) {
      try {
        const created = await this.importChat(session.result, session.selectedProjectId);
        newSummaries.push({
          fileName: session.fileName,
          kind: 'chat',
          title: session.result.title,
          created
        });
      } catch (err: any) {
        newSummaries.push({
          fileName: session.fileName,
          kind: 'chat',
          title: session.result.title,
          created: 0,
          error: err?.message || String(err)
        });
      }
    }

    this.pendingSessions.set([]);
    this.summaries.update(s => [...s, ...newSummaries]);
    this.progress.set('');
    this.isImporting.set(false);
  }

  // ------------------------------------------------------------------
  // Import helpers
  // ------------------------------------------------------------------

  private async importCopilots(result: ParseResult): Promise<number> {
    const list = result.copilots || [];
    let created = 0;
    for (const entry of list) {
      this.progress.set(`Creating project “${entry.name}”…`);
      await this.projectService.createProject({
        name: entry.name,
        greeting: entry.description || '',
        systemPrompt: entry.prompt
      });
      created++;
    }
    return created;
  }

  private async importChat(result: ParseResult, projectId: string | null): Promise<number> {
    let finalProjectId = projectId;
    if (!finalProjectId) {
      const p = await this.projectService.createProject({
        name: result.title,
        greeting: '',
        systemPrompt: result.systemPrompt || undefined
      });
      finalProjectId = p.id;
    }

    const chat = await this.chatService.createChat(result.title, finalProjectId);

    let parentId: string | null = null;
    let count = 0;

    if (result.systemPrompt) {
      const sys = await this.chatService.addNode(chat.id, {
        parentId: null,
        role: 'user',
        content: result.systemPrompt
      });
      parentId = sys.id;
      count++;
    }

    for (const turn of result.turns) {
      if (turn.mappedType === 'ignored') continue;
      const node = await this.chatService.addNode(chat.id, {
        parentId,
        role: turn.mappedType as 'user' | 'assistant' | 'system',
        content: turn.content
      });
      parentId = node.id;
      count++;
    }
    return count;
  }

  // ------------------------------------------------------------------
  // Format detection
  // ------------------------------------------------------------------

  /** One file may contain many conversations (Grok export). */
  private detectAndParseAll(data: any): ParseResult[] {
    const warnings: string[] = [];

    if (data && Array.isArray(data.conversations)) {
      return this.parseGrokExport(data, warnings);
    }

    // single conversation object (already extracted)
    if (data && data.conversation && Array.isArray(data.responses)) {
      return [this.parseGrokExportItem(data, warnings)];
    }

    return [this.detectAndParse(data)];
  }

  private detectAndParse(data: any): ParseResult {
    const warnings: string[] = [];

    if (Array.isArray(data) && data.length > 0 &&
      typeof data[0]?.name === 'string' &&
      typeof data[0]?.prompt === 'string') {
      return this.parseCopilots(data, warnings);
    }

    if (data && Array.isArray(data.conversations)) {
      const all = this.parseGrokExport(data, warnings);
      return all[0] ?? this.parseFallback(data, warnings);
    }

    if (data && data.conversation && Array.isArray(data.responses)) {
      return this.parseGrokExportItem(data, warnings);
    }

    if (data && Array.isArray(data.messages) && data.messages[0]?.contentParts) {
      return this.parseGrokSession(data, warnings);
    }

    if (data && Array.isArray(data.messages) && data.messages[0]?.role) {
      return this.parseSimpleMessages(data, warnings);
    }
    if (Array.isArray(data) && data[0]?.role) {
      return this.parseSimpleMessages({ messages: data, name: 'Imported Chat' }, warnings);
    }

    if (data?.mapping && typeof data.mapping === 'object') {
      return this.parseChatGptExport(data, warnings);
    }

    if (this.bundleService.isBundle(data)) {
      return this.parseBundle(data);
    }

    if (data?.nodes || data?.turns) {
      return this.parseNativeLike(data, warnings);
    }

    warnings.push('Unknown structure – best-effort extraction.');
    return this.parseFallback(data, warnings);
  }



  private mapRole(role: string): { role: ParsedTurn['role']; mappedType: ParsedTurn['mappedType'] } {
    const r = (role || '').toLowerCase().trim();
    if (r === 'user' || r === 'human' || r === 'query') return { role: 'user', mappedType: 'user' };
    if (r === 'assistant' || r === 'ai' || r === 'bot' || r === 'model') return { role: 'assistant', mappedType: 'assistant' };
    if (r === 'system') return { role: 'system', mappedType: 'system' };
    return { role: 'other', mappedType: 'ignored' };
  }

  private parseCopilots(data: any[], warnings: string[]): ParseResult {
    const copilots: CopilotEntry[] = [];
    for (const item of data) {
      if (item?.name && item?.prompt) {
        copilots.push({
          name: String(item.name).trim(),
          prompt: String(item.prompt),
          description: (item.description || '').trim() || undefined
        });
      }
    }
    return {
      title: `Copilots (${copilots.length})`,
      systemPrompt: null,
      turns: [],
      format: 'Copilots',
      warnings,
      kind: 'copilots',
      copilots
    };
  }

  /**
   * Grok / xAI account export:
   * { conversations: [ { conversation: { id, title, … }, responses: [ { response: { message, sender, … } } ] } ] }
   */
  private parseGrokExport(data: any, warnings: string[]): ParseResult[] {
    const list = Array.isArray(data.conversations) ? data.conversations : [];
    const results: ParseResult[] = [];
    for (const item of list) {
      results.push(this.parseGrokExportItem(item, warnings));
    }
    if (!results.length) {
      warnings.push('Grok export contained an empty conversations array.');
      return [{
        title: 'Grok Export',
        systemPrompt: null,
        turns: [],
        format: 'Grok Export',
        warnings,
        kind: 'chat'
      }];
    }
    return results;
  }

  private parseGrokExportItem(item: any, warnings: string[]): ParseResult {
    const meta = item?.conversation || item || {};
    const title =
      (meta.title && String(meta.title).trim()) ||
      (meta.system_prompt_name && String(meta.system_prompt_name).trim()) ||
      'Imported Grok Conversation';

    const systemPrompt =
      (typeof meta.system_prompt === 'string' && meta.system_prompt.trim()) ||
      null;

    const responses = Array.isArray(item?.responses) ? item.responses : [];
    const turns: ParsedTurn[] = [];

    // Walk in file order; fall back to parent/path when order is messy.
    const ordered = this.orderGrokResponses(responses);

    for (let i = 0; i < ordered.length; i++) {
      const wrapper = ordered[i];
      const resp = wrapper?.response || wrapper;
      if (!resp) continue;

      const sender = resp.sender || resp.role || '';
      const { role, mappedType } = this.mapRole(sender);
      const content = this.extractGrokMessage(resp);
      if (!content) continue;

      if (role === 'system') {
        continue;
      }

      turns.push({
        role,
        mappedType,
        content,
        originalIndex: i,
        unknownBlocks: this.collectUnknownBlocks(resp)
      });
    }

    if (!turns.length) {
      warnings.push(`Conversation “${title}” had no extractable messages.`);
    }

    return {
      title,
      systemPrompt,
      turns,
      format: 'Grok Export',
      warnings,
      kind: 'chat'
    };
  }

  private orderGrokResponses(responses: any[]): any[] {
    // Prefer explicit parent chain when every node has parent_response_id.
    const byId = new Map<string, any>();
    for (const wrapper of responses) {
      const resp = wrapper?.response || wrapper;
      const id = resp?._id || resp?.id;
      if (id) byId.set(id, wrapper);
    }

    if (byId.size === responses.length && responses.length > 0) {
      const children = new Map<string | null, any[]>();
      for (const wrapper of responses) {
        const resp = wrapper?.response || wrapper;
        const parent = resp.parent_response_id ?? null;
        const list = children.get(parent) || [];
        list.push(wrapper);
        children.set(parent, list);
      }
      const out: any[] = [];
      const walk = (parent: string | null) => {
        const kids = children.get(parent) || [];
        for (const k of kids) {
          out.push(k);
          const id = (k.response || k)._id || (k.response || k).id;
          if (id) walk(id);
        }
      };
      walk(null);
      // orphans whose parent lives outside this file
      if (out.length < responses.length) {
        for (const wrapper of responses) {
          if (!out.includes(wrapper)) out.push(wrapper);
        }
      }
      if (out.length) return out;
    }

    return [...responses].sort((a, b) => {
      const ta = this.grokTimestamp(a?.response || a);
      const tb = this.grokTimestamp(b?.response || b);
      return ta - tb;
    });
  }

  private grokTimestamp(resp: any): number {
    const ct = resp?.create_time;
    if (typeof ct === 'number') return ct;
    if (typeof ct === 'string') {
      const n = Date.parse(ct);
      return Number.isNaN(n) ? 0 : n;
    }
    const ms = ct?.$date?.$numberLong ?? ct?.$date;
    if (ms != null) return Number(ms);
    return 0;
  }

  private extractGrokMessage(resp: any): string {
    if (typeof resp.message === 'string' && resp.message.trim()) {
      return resp.message.trim();
    }
    if (typeof resp.content === 'string' && resp.content.trim()) {
      return resp.content.trim();
    }
    if (Array.isArray(resp.contentParts)) {
      return resp.contentParts
        .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
        .map((p: any) => p.text)
        .join('\n\n')
        .trim();
    }
    return '';
  }

  private collectUnknownBlocks(resp: any): string[] {
    const blocks: string[] = [];
    if (Array.isArray(resp.file_attachments) && resp.file_attachments.length) {
      blocks.push('file_attachments');
    }
    if (Array.isArray(resp.steps) && resp.steps.length) {
      blocks.push('steps');
    }
    if (resp.card_attachments_json) {
      blocks.push('card_attachments');
    }
    return blocks;
  }

  private parseGrokSession(data: any, warnings: string[]): ParseResult {
    const title = data.name || data.threadName || data.title || 'Imported Grok Session';
    let systemPrompt: string | null = null;
    const turns: ParsedTurn[] = [];

    for (let i = 0; i < (data.messages || []).length; i++) {
      const msg = data.messages[i];
      const { role, mappedType } = this.mapRole(msg.role || 'other');
      let text = '';

      if (Array.isArray(msg.contentParts)) {
        for (const part of msg.contentParts) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            text += (text ? '\n\n' : '') + part.text;
          }
        }
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      }

      if (!text.trim()) continue;

      if (role === 'system') {
        if (!systemPrompt) systemPrompt = text.trim();
        continue;
      }

      turns.push({
        role,
        mappedType,
        content: text.trim(),
        originalIndex: i,
        unknownBlocks: []
      });
    }

    return {
      title,
      systemPrompt,
      turns,
      format: 'Grok Session',
      warnings,
      kind: 'chat'
    };
  }

  private parseSimpleMessages(data: any, warnings: string[]): ParseResult {
    const title = data.name || data.title || 'Imported Chat';
    let systemPrompt: string | null = null;
    const turns: ParsedTurn[] = [];
    const messages = data.messages || data;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const { role, mappedType } = this.mapRole(msg.role || msg.sender || 'other');
      const content = (msg.content || msg.message || '').toString().trim();
      if (!content) continue;

      if (role === 'system') {
        if (!systemPrompt) systemPrompt = content;
        continue;
      }

      turns.push({
        role,
        mappedType,
        content,
        originalIndex: i,
        unknownBlocks: []
      });
    }

    return { title, systemPrompt, turns, format: 'Simple Messages', warnings, kind: 'chat' };
  }

  private parseChatGptExport(data: any, warnings: string[]): ParseResult {
    const title = data.title || 'ChatGPT Export';
    const turns: ParsedTurn[] = [];
    let systemPrompt: string | null = null;

    const mapping = data.mapping || {};
    const nodes = Object.values(mapping) as any[];
    nodes.sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const msg = node?.message;
      if (!msg) continue;
      const { role, mappedType } = this.mapRole(msg.author?.role || msg.role || 'other');
      const parts = msg.content?.parts || [];
      const content = parts.filter((p: any) => typeof p === 'string').join('\n').trim();
      if (!content) continue;

      if (role === 'system') {
        if (!systemPrompt) systemPrompt = content;
        continue;
      }
      turns.push({ role, mappedType, content, originalIndex: i, unknownBlocks: [] });
    }

    return { title, systemPrompt, turns, format: 'ChatGPT Export', warnings, kind: 'chat' };
  }

  private parseNativeLike(data: any, warnings: string[]): ParseResult {
    const title = data.title || data.name || 'Native Import';
    const turns: ParsedTurn[] = [];
    let systemPrompt: string | null = null;
    const list = data.nodes || data.turns || [];

    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      const type = (n.type || '').toLowerCase();
      const content = (n.content || '').toString().trim();
      if (!content) continue;

      if (type === 'system') {
        if (!systemPrompt) systemPrompt = content;
        continue;
      }
      const mappedType = type === 'assistant' ? 'assistant' : 'user';
      turns.push({
        role: mappedType === 'assistant' ? 'assistant' : 'user',
        mappedType,
        content,
        originalIndex: i,
        unknownBlocks: []
      });
    }

    return { title, systemPrompt, turns, format: 'Native-like', warnings, kind: 'chat' };
  }

  private parseFallback(data: any, warnings: string[]): ParseResult {
    const candidates = [data?.messages, data?.conversation, data?.history, data?.data, data?.responses]
      .filter(Array.isArray);
    if (candidates.length) {
      return this.parseSimpleMessages({ messages: candidates[0], name: 'Imported Chat' }, warnings);
    }
    return {
      title: 'Imported Chat',
      systemPrompt: null,
      turns: [],
      format: 'Unknown',
      warnings: [...warnings, 'Could not extract any messages.'],
      kind: 'chat'
    };
  }

  /** Put the last snapped end into the offset field so the next drop continues. */
  useAlignedEndAsNextOffset() {
    const end = this.lastAlignedEnd();
    if (end == null) return;
    this.useSlice = true;
    this.sliceOffset = end;
  }

  clear() {
    this.pendingSessions.set([]);
    this.summaries.set([]);
    this.progress.set('');
    this.globalError.set(null);
    this.lastAlignedStart.set(null);
    this.lastAlignedEnd.set(null);
  }

  async goToProjects() {
    await this.router.navigate(['/projects']);
  }

  async goToChat() {
    await this.router.navigate(['/chat']);
  }


  private parseBundle(data: ChatBundle): ParseResult {
    return {
      title: this.bundleService.bundleTitle(data),
      systemPrompt: null,
      turns: [],
      format: BUNDLE_FORMAT,
      warnings: [],
      kind: 'bundle',
      bundle: data
    };
  }

  private describeImport(imported: {
    createdPersonas: number;
    reusedPersonas: number;
    createdProjects: number;
    reusedProjects: number;
    createdTopics: number;
    reusedTopics: number;
    createdChats: number;
    createdNodes: number;
    unresolvedProjects: number;
  }): string {
    return this.i18n.t('import.bundleDetail', {
      personas: imported.createdPersonas,
      personasReused: imported.reusedPersonas,
      projects: imported.createdProjects,
      projectsReused: imported.reusedProjects,
      topics: imported.createdTopics,
      topicsReused: imported.reusedTopics,
      chats: imported.createdChats,
      nodes: imported.createdNodes
    });
  }

  async exportBundle(): Promise<void> {
    this.isExporting.set(true);
    this.globalError.set(null);
    try {
      await this.bundleService.loadAll();
      const scope = this.exportScope();
      const bundle = await this.bundleService.buildBundle({
        scope,
        includeChats: scope === 'topic-project' ? this.includeChats() : scope !== 'personas',
        projectId: this.needsProjectPicker() ? this.exportProjectId() : null,
        chatId: scope === 'chat' || (scope === 'chats-only' && this.exportChatId())
          ? this.exportChatId()
          : null,
        onProgress: (message) => this.progress.set(message)
      });

      if (
        !bundle.personas.length &&
        !bundle.projects.length &&
        !bundle.topics.length &&
        !bundle.chats.length
      ) {
        throw new Error(this.i18n.t('import.exportEmpty'));
      }

      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `chapterly-bundle-${scope}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.progress.set(this.i18n.t('import.exported', {
        personas: bundle.personas.length,
        projects: bundle.projects.length,
        topics: bundle.topics.length,
        chats: bundle.chats.length
      }));
    } catch (err: any) {
      this.globalError.set(err?.message || String(err));
    } finally {
      this.isExporting.set(false);
    }
  }

}
