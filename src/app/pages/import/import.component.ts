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
  unknownBlocks: string[];          // e.g. ["image", "tool_call"]
}

export interface ParseResult {
  title: string;
  systemPrompt: string | null;
  turns: ParsedTurn[];
  format: string;
  warnings: string[];
  unknownBlockTypes: string[];      // unique list across the whole file
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

  // UI state
  readonly selectedFileName = signal<string | null>(null);
  readonly rawJson = signal<any>(null);
  readonly parseResult = signal<ParseResult | null>(null);
  readonly isDragging = signal(false);
  readonly isImporting = signal(false);
  readonly importProgress = signal('');
  readonly importError = signal<string | null>(null);
  readonly importSuccess = signal<string | null>(null);

  // Project options
  readonly projectMode = signal<'existing' | 'new' | 'none'>('existing');
  readonly selectedProjectId = signal<string | null>(null);
  readonly newProjectName = signal('');
  readonly newProjectSystemPrompt = signal('');

  // Import options
  readonly includeSystemAsFirstNode = signal(false);
  readonly includeReasoning = signal(false);

  readonly hasPreview = computed(() => !!this.parseResult()?.turns.length);

  // ------------------------------------------------------------------
  // File handling
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
    if (files && files.length > 0) {
      this.handleFile(files[0]);
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.handleFile(input.files[0]);
    }
  }

  private handleFile(file: File) {
    this.resetState();
    this.selectedFileName.set(file.name);

    if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
      this.importError.set('Please select a .json file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const data = JSON.parse(text);
        this.rawJson.set(data);
        const result = this.detectAndParse(data);
        this.parseResult.set(result);

        // Pre-fill new project name + system prompt when useful
        if (result.systemPrompt) {
          this.newProjectSystemPrompt.set(result.systemPrompt);
        }
        if (result.title) {
          this.newProjectName.set(result.title);
        }
      } catch (err: any) {
        this.importError.set('Invalid JSON: ' + (err.message || err));
      }
    };
    reader.onerror = () => {
      this.importError.set('Failed to read file.');
    };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------------
  // Role mapping helper
  // ------------------------------------------------------------------

  private mapRole(role: string): { role: ParsedTurn['role']; mappedType: ParsedTurn['mappedType'] } {
    const r = (role || '').toLowerCase().trim();

    if (r === 'user' || r === 'human' || r === 'query') {
      return { role: 'user', mappedType: 'question' };
    }
    if (r === 'assistant' || r === 'ai' || r === 'bot' || r === 'model') {
      return { role: 'assistant', mappedType: 'answer' };
    }
    if (r === 'system') {
      return { role: 'system', mappedType: 'system' };
    }
    return { role: 'other', mappedType: 'ignored' };
  }

  // ------------------------------------------------------------------
  // Format detection & parsing
  // ------------------------------------------------------------------

  private detectAndParse(data: any): ParseResult {
    const warnings: string[] = [];

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

    warnings.push('Unknown structure – attempted best-effort extraction of any role/content pairs.');
    return this.parseFallback(data, warnings);
  }

  private parseGrokSession(data: any, warnings: string[]): ParseResult {
    const title =
      data.threadName ||
      data.name ||
      data.title ||
      'Imported Grok Session';

    let systemPrompt: string | null = null;
    const turns: ParsedTurn[] = [];
    const unknownBlockTypes = new Set<string>();

    for (let i = 0; i < data.messages.length; i++) {
      const msg = data.messages[i];
      const rawRole = msg.role || 'other';
      const { role, mappedType } = this.mapRole(rawRole);

      let text = '';
      let reasoning = '';
      const unknownBlocks: string[] = [];

      if (Array.isArray(msg.contentParts)) {
        for (const part of msg.contentParts) {
          const type = part?.type || 'unknown';

          if (type === 'text' && typeof part.text === 'string') {
            text += (text ? '\n\n' : '') + part.text;
          } else if (type === 'reasoning' && typeof part.text === 'string') {
            reasoning += (reasoning ? '\n\n' : '') + part.text;
          } else {
            // record unknown block types
            unknownBlocks.push(type);
            unknownBlockTypes.add(type);

            // best-effort: if it has a text-like field, append it
            if (typeof part.text === 'string' && part.text.trim()) {
              text += (text ? '\n\n' : '') + `[${type}]\n${part.text}`;
            } else if (typeof part.content === 'string' && part.content.trim()) {
              text += (text ? '\n\n' : '') + `[${type}]\n${part.content}`;
            }
          }
        }
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      }

      if (!text.trim() && !reasoning.trim()) continue;

      if (role === 'system') {
        if (!systemPrompt) {
          systemPrompt = text.trim();
        } else {
          turns.push({
            role: 'system',
            mappedType: 'system',
            content: text.trim(),
            originalIndex: i,
            unknownBlocks
          });
        }
        continue;
      }

      let content = text.trim();
      if (this.includeReasoning() && reasoning.trim()) {
        content = `\`\`\`reasoning\n${reasoning.trim()}\n\`\`\`\n\n${content}`;
      }

      if (content) {
        turns.push({
          role,
          mappedType,
          content,
          originalIndex: i,
          unknownBlocks
        });
      }
    }

    if (turns.length === 0) {
      warnings.push('No usable user/assistant messages found.');
    }

    return {
      title,
      systemPrompt,
      turns,
      format: 'Grok / X / Copilot session',
      warnings,
      unknownBlockTypes: Array.from(unknownBlockTypes).sort()
    };
  }

  private parseSimpleMessages(data: any, warnings: string[]): ParseResult {
    const title = data.title || data.name || data.threadName || 'Imported Chat';
    let systemPrompt: string | null = null;
    const turns: ParsedTurn[] = [];
    const unknownBlockTypes = new Set<string>();

    for (let i = 0; i < data.messages.length; i++) {
      const msg = data.messages[i];
      const { role, mappedType } = this.mapRole(msg.role || 'other');

      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content.map((c: any) => {
          if (typeof c === 'string') return c;
          if (c?.text) return c.text;
          if (c?.type) {
            unknownBlockTypes.add(c.type);
            return `[${c.type}] ${c.text || c.content || ''}`;
          }
          return JSON.stringify(c);
        }).join('\n');
      } else {
        content = JSON.stringify(msg.content || '');
      }

      if (!content.trim()) continue;

      if (role === 'system' && !systemPrompt) {
        systemPrompt = content.trim();
        continue;
      }

      turns.push({
        role,
        mappedType,
        content: content.trim(),
        originalIndex: i,
        unknownBlocks: []
      });
    }

    return {
      title,
      systemPrompt,
      turns,
      format: 'Simple messages array',
      warnings,
      unknownBlockTypes: Array.from(unknownBlockTypes).sort()
    };
  }

  private parseChatGptExport(data: any, warnings: string[]): ParseResult {
    const title = data.title || 'Imported ChatGPT Conversation';
    const turns: ParsedTurn[] = [];
    const mapping = data.mapping;
    const unknownBlockTypes = new Set<string>();

    const rootId = Object.keys(mapping).find(id => !mapping[id].parent) || data.current_node;
    if (!rootId) {
      warnings.push('Could not find root node in ChatGPT mapping.');
      return { title, systemPrompt: null, turns: [], format: 'ChatGPT export', warnings, unknownBlockTypes: [] };
    }

    const walk = (id: string | null) => {
      if (!id || !mapping[id]) return;
      const node = mapping[id];
      const msg = node.message;
      if (msg?.content?.parts) {
        const rawRole = msg.author?.role || 'unknown';
        const { role, mappedType } = this.mapRole(rawRole);
        const content = msg.content.parts
          .map((p: any) => (typeof p === 'string' ? p : JSON.stringify(p)))
          .join('\n')
          .trim();

        if (content && mappedType !== 'ignored') {
          turns.push({
            role,
            mappedType,
            content,
            originalIndex: turns.length,
            unknownBlocks: []
          });
        }
      }
      const children = node.children || [];
      if (children.length > 0) {
        walk(children[0]);
      }
    };

    walk(rootId);

    return {
      title,
      systemPrompt: null,
      turns,
      format: 'ChatGPT export (mapping)',
      warnings,
      unknownBlockTypes: Array.from(unknownBlockTypes).sort()
    };
  }

  private parseNativeLike(data: any, warnings: string[]): ParseResult {
    const title = data.title || data.name || 'Imported Chat';
    const turns: ParsedTurn[] = [];
    const source = data.nodes || data.turns || [];

    for (let i = 0; i < source.length; i++) {
      const n = source[i];
      let role: ParsedTurn['role'] = 'other';
      let mappedType: ParsedTurn['mappedType'] = 'ignored';

      if (n.type === 'question' || n.role === 'user') {
        role = 'user';
        mappedType = 'question';
      } else if (n.type === 'answer' || n.role === 'assistant') {
        role = 'assistant';
        mappedType = 'answer';
      } else if (n.role === 'system') {
        role = 'system';
        mappedType = 'system';
      }

      const content = n.content || '';
      if (content.trim()) {
        turns.push({
          role,
          mappedType,
          content: content.trim(),
          originalIndex: i,
          unknownBlocks: []
        });
      }
    }

    return {
      title,
      systemPrompt: null,
      turns,
      format: 'Native-like',
      warnings,
      unknownBlockTypes: []
    };
  }

  private parseFallback(data: any, warnings: string[]): ParseResult {
    const candidates = [
      data?.messages,
      data?.conversation,
      data?.history,
      data?.data
    ].filter(Array.isArray);

    if (candidates.length > 0) {
      return this.parseSimpleMessages({ messages: candidates[0], name: 'Imported Chat' }, warnings);
    }

    return {
      title: 'Imported Chat',
      systemPrompt: null,
      turns: [],
      format: 'Unknown',
      warnings: [...warnings, 'Could not extract any messages.'],
      unknownBlockTypes: []
    };
  }

  // ------------------------------------------------------------------
  // Import action
  // ------------------------------------------------------------------

  async doImport() {
    const result = this.parseResult();
    if (!result || result.turns.length === 0) {
      this.importError.set('Nothing to import.');
      return;
    }

    this.isImporting.set(true);
    this.importError.set(null);
    this.importSuccess.set(null);
    this.importProgress.set('Preparing…');

    try {
      let projectId: string | null = null;

      // ----- Project handling -----
      if (this.projectMode() === 'existing') {
        projectId = this.selectedProjectId();
      } else if (this.projectMode() === 'new') {
        const name = this.newProjectName().trim() || result.title;
        if (!name) {
          this.importError.set('Please enter a name for the new project.');
          this.isImporting.set(false);
          return;
        }
        this.importProgress.set('Creating project…');
        const project = await this.chatService.createProject({
          name,
          systemPrompt: this.newProjectSystemPrompt().trim() || result.systemPrompt || undefined
        });
        projectId = project.id;
      }
      // mode === 'none' → projectId stays null

      this.importProgress.set('Creating chat…');
      const chat = await this.chatService.createChat(result.title, projectId);

      this.importProgress.set(`Importing ${result.turns.length} turns…`);

      let parentId: string | null = null;
      let importedCount = 0;

      // Optional: system prompt as first node
      if (result.systemPrompt && this.includeSystemAsFirstNode()) {
        const sysNode = await this.chatService.addNode(chat.id, {
          parentId: null,
          type: 'question',
          content: '[System]\n' + result.systemPrompt
        });
        parentId = sysNode.id;
        importedCount++;
      }

      for (const turn of result.turns) {
        if (turn.mappedType === 'ignored' || turn.mappedType === 'system') {
          // system messages are already handled (or skipped)
          continue;
        }

        const type = turn.mappedType; // 'question' | 'answer'

        const node = await this.chatService.addNode(chat.id, {
          parentId,
          type,
          content: turn.content
        });

        parentId = node.id;
        importedCount++;
        this.importProgress.set(`Imported ${importedCount} nodes…`);
      }

      this.importSuccess.set(
        `Successfully imported “${result.title}” with ${importedCount} nodes.`
      );
      this.importProgress.set('');

      setTimeout(() => {
        this.chatService.selectChat(chat.id);
        this.router.navigate(['/chat']);
      }, 1200);

    } catch (err: any) {
      console.error(err);
      this.importError.set('Import failed: ' + (err.message || err));
      this.importProgress.set('');
    } finally {
      this.isImporting.set(false);
    }
  }

  resetState() {
    this.selectedFileName.set(null);
    this.rawJson.set(null);
    this.parseResult.set(null);
    this.importError.set(null);
    this.importSuccess.set(null);
    this.importProgress.set('');
    this.isImporting.set(false);
    this.projectMode.set('existing');
    this.selectedProjectId.set(null);
    this.newProjectName.set('');
    this.newProjectSystemPrompt.set('');
  }

  async goToChat() {
    await this.router.navigate(['/chat']);
  }

  async goToConfig() {
    await this.router.navigate(['/config']);
  }
}
