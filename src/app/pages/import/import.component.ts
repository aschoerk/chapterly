import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ChatService } from '../../core/chat.service';
import { Project } from '../../models/chat';

export interface ParsedTurn {
  role: 'system' | 'user' | 'assistant' | 'other';
  mappedType: 'question' | 'answer' | 'system' | 'ignored';
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
  kind: 'chat' | 'copilots';
  copilots?: CopilotEntry[];
}

/** One pending session waiting for project assignment */
export interface PendingSession {
  id: string;                 // local uuid for the list
  fileName: string;
  result: ParseResult;        // the parsed chat
  selectedProjectId: string | null;  // null = Unknown
}

interface ImportSummary {
  fileName: string;
  kind: 'chat' | 'copilots';
  title: string;
  created: number;          // projects or nodes
  error?: string;
}

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

  /** Sessions that still need a project assignment */
  readonly pendingSessions = signal<PendingSession[]>([]);

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
      input.value = ''; // allow re-selecting the same file
    }
  }

  // ------------------------------------------------------------------
  // Main entry – process one or many files automatically
  // ------------------------------------------------------------------

  private async processFiles(files: File[]) {
    this.isImporting.set(true);
    this.globalError.set(null);
    this.progress.set(`Processing ${files.length} file(s)…`);

    const newSummaries: ImportSummary[] = [];
    const newPending: PendingSession[] = [];

    for (const file of files) {
      this.progress.set(`Reading ${file.name}…`);
      try {
        const text = await this.readFile(file);
        const data = JSON.parse(text);
        const parsed = this.detectAndParse(data);

        if (parsed.kind === 'copilots') {
          // immediate import
          const created = await this.importCopilots(parsed);
          newSummaries.push({
            fileName: file.name,
            kind: 'copilots',
            title: parsed.title,
            created
          });
        } else {
          // session → put into review list
          const id = crypto.randomUUID();
          const preselected = this.findBestProjectId(parsed.title);
          newPending.push({
            id,
            fileName: file.name,
            result: parsed,
            selectedProjectId: preselected
          });
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

    // append to existing pending list (user may drop more files later)
    this.pendingSessions.update(list => [...list, ...newPending]);
    this.summaries.update(list => [...list, ...newSummaries]);
    this.progress.set('');
    this.isImporting.set(false);
  }

  private readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  // ------------------------------------------------------------------
  // Smart project ordering for a session title
  // ------------------------------------------------------------------

  /**
   * Returns projects ordered so that those whose name appears in the
   * session title come first, then a synthetic "Unknown", then the rest.
   */
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

    // sort both groups alphabetically for stability
    matching.sort((a, b) => a.name.localeCompare(b.name));
    rest.sort((a, b) => a.name.localeCompare(b.name));

    const result: { id: string | null; label: string }[] = [
      ...matching.map(p => ({ id: p.id, label: p.name })),
      { id: null, label: 'Unknown' },
      ...rest.map(p => ({ id: p.id, label: p.name }))
    ];

    return result;
  }

  /** Best matching project id (or null) for pre-selection */
  private findBestProjectId(sessionTitle: string): string | null {
    const ordered = this.orderedProjectsFor(sessionTitle);
    // first entry is either a matching project or "Unknown"
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

  // ------------------------------------------------------------------
  // Final import of all remaining sessions
  // ------------------------------------------------------------------

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

    this.pendingSessions.set([]);          // clear the list
    this.summaries.update(s => [...s, ...newSummaries]);
    this.progress.set('');
    this.isImporting.set(false);
  }

  // ------------------------------------------------------------------
  // Import helpers (copilots + chat)
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
    // if user chose "Unknown" we still create a project named after the session
    // so the chat is not completely unassigned (optional – change if you prefer null)
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
        type: 'question',
        content: result.systemPrompt
      });
      parentId = sys.id;
      count++;
    }

    for (const turn of result.turns) {
      if (turn.mappedType === 'ignored' || turn.mappedType === 'system') continue;
      const node = await this.chatService.addNode(chat.id, {
        parentId,
        type: turn.mappedType as 'question' | 'answer',
        content: turn.content
      });
      parentId = node.id;
      count++;
    }
    return count;
  }

  // ------------------------------------------------------------------
  // Format detection + parsers (identical to previous version)
  // ------------------------------------------------------------------

  private detectAndParse(data: any): ParseResult {
    const warnings: string[] = [];

    if (Array.isArray(data) && data.length > 0 &&
      typeof data[0]?.name === 'string' &&
      typeof data[0]?.prompt === 'string') {
      return this.parseCopilots(data, warnings);
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

    if (data?.nodes || data?.turns) {
      return this.parseNativeLike(data, warnings);
    }

    warnings.push('Unknown structure – best-effort extraction.');
    return this.parseFallback(data, warnings);
  }

  // … keep the private parseCopilots / parseGrokSession / parseSimpleMessages /
  //   parseChatGptExport / parseNativeLike / parseFallback / mapRole methods
  //   exactly as in the previous answer …




  private mapRole(role: string): { role: ParsedTurn['role']; mappedType: ParsedTurn['mappedType'] } {
    const r = (role || '').toLowerCase().trim();
    if (r === 'user' || r === 'human' || r === 'query') return { role: 'user', mappedType: 'question' };
    if (r === 'assistant' || r === 'ai' || r === 'bot' || r === 'model') return { role: 'assistant', mappedType: 'answer' };
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

  private parseGrokSession(data: any, warnings: string[]): ParseResult {
    const title =  data.name || data.threadName || data.title || 'Imported Grok Session';
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
      const { role, mappedType } = this.mapRole(msg.role || 'other');
      const content = (msg.content || '').toString().trim();
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
    // simplified but functional extraction of the linear path
    const title = data.title || 'ChatGPT Export';
    const turns: ParsedTurn[] = [];
    let systemPrompt: string | null = null;

    // very basic linear walk – good enough for most exports
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
      const mappedType = type === 'answer' ? 'answer' : 'question';
      turns.push({
        role: mappedType === 'answer' ? 'assistant' : 'user',
        mappedType,
        content,
        originalIndex: i,
        unknownBlocks: []
      });
    }

    return { title, systemPrompt, turns, format: 'Native-like', warnings, kind: 'chat' };
  }

  private parseFallback(data: any, warnings: string[]): ParseResult {
    const candidates = [data?.messages, data?.conversation, data?.history, data?.data]
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


  // ------------------------------------------------------------------
  // UI helpers
  // ------------------------------------------------------------------

  clear() {
    this.pendingSessions.set([]);
    this.summaries.set([]);
    this.progress.set('');
    this.globalError.set(null);
  }

  async goToProjects() {
    await this.router.navigate(['/projects']);
  }

  async goToChat() {
    await this.router.navigate(['/chat']);
  }
}
