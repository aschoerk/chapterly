import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ChatService } from '../../core/chat.service';
import {Chat, ChatNode, Persona, Project, Topic} from '../../models/chat';

const BUNDLE_FORMAT = 'aschoerk.chat.bundle';
const BUNDLE_VERSION = 1;

interface ChatBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  projects: Project[];
  topics: Topic[];
  personas: Persona[];
  chats: Array<Chat & { nodes: ChatNode[] }>;
}

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
  kind: 'chat' | 'copilots';
  title: string;
  created: number;
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
  private readonly chatService = inject(ChatService);
  private readonly router = inject(Router);

  readonly projects = this.chatService.projects;

  readonly isDragging = signal(false);
  readonly isImporting = signal(false);
  readonly progress = signal('');
  readonly summaries = signal<ImportSummary[]>([]);
  readonly globalError = signal<string | null>(null);

  readonly pendingSessions = signal<PendingSession[]>([]);

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
    this.progress.set(`Processing ${files.length} file(s)…`);

    const newSummaries: ImportSummary[] = [];
    const newPending: PendingSession[] = [];
    const slice = this.sliceOptions();

    for (const file of files) {
      this.progress.set(`Reading ${file.name} (${this.formatBytes(file.size)})…`);
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
            const created = await this.importBundle(parsed.bundle);
            newSummaries.push({
              fileName: file.name,
              kind: 'copilots',
              title: parsed.title,
              created
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
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }

  /**
   * Read a (possibly huge) file and return one ParseResult per conversation.
   *
   * Byte window rules when a slice is set:
   *   - the given offset is a *search start*: scan forward for the next
   *     `"conversation"` wrapper object and begin there
   *   - the given end (offset+length) is a *soft* limit: if a conversation
   *     was already opened before that point, keep reading until its
   *     matching closing brace, even past the requested length
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
    const looksLikeGrokExport =
      /"conversations"\s*:/.test(peekText) ||
      /"conversation"\s*:\s*\{/.test(peekText);

    const windowHint = rawEnd - rawStart;
    const shouldStream =
      !!slice ||
      windowHint >= LARGE_FILE_BYTES ||
      (looksLikeGrokExport && windowHint >= 2 * 1024 * 1024);

    if (!shouldStream) {
      const text = await this.readSlice(file, rawStart, windowHint);
      const data = JSON.parse(this.repairSlicedJson(text, !!slice));
      return this.detectAndParseAll(data);
    }

    this.progress.set(`Aligning ${file.name} from byte ${rawStart}…`);
    return this.streamGrokConversations(file, rawStart, rawEnd);
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
    // raw conversation objects dumped from the middle of the array
    if (trimmed.startsWith('"conversation"') || trimmed.startsWith('"responses"')) {
      return `{${trimmed}}`;
    }
    return trimmed;
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
        `Reading conversation at ${loc.start}–${loc.end} ` +
        `(${this.formatBytes(loc.end - loc.start)})…`
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
          `Extending conversation window to byte ${end} (look-ahead)…`
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

    matching.sort((a, b) => a.name.localeCompare(b.name));
    rest.sort((a, b) => a.name.localeCompare(b.name));

    return [
      ...matching.map(p => ({ id: p.id, label: p.name })),
      { id: null, label: 'Unknown' },
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
      await this.chatService.createProject({
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
      const p = await this.chatService.createProject({
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

    if (data?.format === BUNDLE_FORMAT && Array.isArray(data.chats)) {
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
      title: `Bundle (${data.chats.length} chat(s))`,
      systemPrompt: null,
      turns: [],
      format: BUNDLE_FORMAT,
      warnings: [],
      kind: 'bundle',
      bundle: data
    } as ParseResult;
  }

  private async importBundle(bundle: ChatBundle): Promise<number> {
    const projectMap = new Map<string, string>();
    const personaMap = new Map<string, string>();
    let created = 0;

    for (const p of bundle.personas || []) {
      const np = await this.chatService.createPersona({
        name: p.name,
        shortName: p.shortName,
        description: p.description,
        avatar: p.avatar
      });
      personaMap.set(p.id, np.id);
    }

    for (const p of bundle.projects || []) {
      const np = await this.chatService.createProject({
        name: p.name,
        greeting: p.greeting,
        systemPrompt: p.systemPrompt,
        defaultModelId: p.defaultModelId,
        personaIds: (p.personaIds || []).map(id => personaMap.get(id) || id)
      });
      projectMap.set(p.id, np.id);
    }

    for (const t of bundle.topics || []) {
      await this.chatService.createTopic({
        name: t.name,
        description: t.description,
        defaultModelId: t.defaultModelId,
        defaultSystemPrompt: t.defaultSystemPrompt,
        icon: t.icon,
        projectIds: (t.projectIds || []).map(id => projectMap.get(id) || id)
      });
    }

    for (const chat of bundle.chats) {
      this.progress.set(`Importing “${chat.title}”…`);
      const nc = await this.chatService.createChat(
        chat.title,
        chat.projectId ? projectMap.get(chat.projectId) ?? null : null
      );

      const idMap = new Map<string, string>();
      const pending = [...(chat.nodes || [])];
      const ready = (n: ChatNode) => !n.parentId || idMap.has(n.parentId);

      while (pending.length) {
        const idx = pending.findIndex(ready);
        if (idx < 0) break;
        const [n] = pending.splice(idx, 1);
        const createdNode = await this.chatService.addNode(nc.id, {
          parentId: n.parentId ? idMap.get(n.parentId) ?? null : null,
          role: n.role,
          content: n.content,
          thinking: n.thinking || undefined,
          modelId: n.modelId || undefined,
          providerId: n.providerId || undefined,
          attachments: n.attachments
        });
        idMap.set(n.id, createdNode.id);
        created++;
      }
    }
    return created;
  }

  readonly exportScope = signal<'chat' | 'project' | 'all'>('chat');
  readonly isExporting = signal(false);

  async exportBundle(): Promise<void> {
    this.isExporting.set(true);
    this.globalError.set(null);
    try {
      await Promise.all([
        this.chatService.loadChats(),
        this.chatService.loadProjects(),
        this.chatService.loadTopics(),
        this.chatService.loadPersonas()
      ]);

      const scope = this.exportScope();
      const currentId = this.chatService.currentChatId();
      const current = this.chatService.chats().find(c => c.id === currentId);

      let chats = this.chatService.chats();
      if (scope === 'chat') {
        chats = current ? [current] : [];
      } else if (scope === 'project') {
        chats = chats.filter(c => c.projectId === (current?.projectId ?? null));
      }

      const packed = [];
      for (const chat of chats) {
        this.progress.set(`Exporting “${chat.title}”…`);
        packed.push({ ...chat, nodes: await this.chatService.fetchNodes(chat.id) });
      }

      const usedProjects = new Set(packed.map(c => c.projectId).filter(Boolean));
      const bundle: ChatBundle = {
        format: BUNDLE_FORMAT,
        version: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        projects: this.chatService.projects().filter(p => usedProjects.has(p.id)),
        topics: this.chatService.topics().filter(t =>
          t.projectIds?.some(id => usedProjects.has(id))
        ),
        personas: this.chatService.personas(),
        chats: packed
      };

      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `chat-bundle-${scope}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.progress.set(`Exported ${packed.length} chat(s).`);
    } catch (err: any) {
      this.globalError.set(err?.message || String(err));
    } finally {
      this.isExporting.set(false);
    }
  }

}
