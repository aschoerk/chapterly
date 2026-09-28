import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ChatService } from '../../core/chat.service';
import { MarkdownService } from '../../core/markdown.service';
import { ChatNode } from '../../models/chat';
import { I18nService } from '../../core/i18n/i18n.service';
import { enumerateStoryDocuments, isUsableNode, storyNodeTimestamp } from '../../core/story-paths';

export interface ReaderFont {
  id: string;
  label: string;
  stack: string;
  sample: string;
}

@Component({
  selector: 'app-chat-reader',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-reader.component.html',
  styleUrl: './chat-reader.component.css',
})
export class ChatReaderComponent implements OnInit, OnDestroy {
  private readonly chatService = inject(ChatService);
  readonly i18n = inject(I18nService);
  private readonly markdown = inject(MarkdownService);
  private readonly router = inject(Router);

  readonly reader = viewChild<ElementRef<HTMLElement>>('reader');

  readonly page = signal(0);
  readonly pageCount = signal(1);
  readonly currentChatId = this.chatService.currentChatId;
  readonly hideQuestions = signal(false);
  readonly docIndex = signal(0);
  private static readonly COLS_KEY = 'chat-reader.columnCount';
  private static readonly FONT_KEY = 'chat-reader.fontId';
  private static readonly SIZE_KEY = 'chat-reader.fontSize';

  readonly columnChoices = [1, 2, 3] as const;
  readonly columnCount = signal<1 | 2 | 3>(this.readStoredColumnCount());

  readonly fontChoices: readonly ReaderFont[] = [
    {
      id: 'georgia',
      label: 'Georgia',
      stack: 'Georgia, "Times New Roman", Times, serif',
      sample: 'The lamp was still warm.',
    },
    {
      id: 'palatino',
      label: 'Palatino',
      stack: 'Palatino, "Palatino Linotype", "Book Antiqua", "URW Palladio L", serif',
      sample: 'Rain ticked the glass.',
    },
    {
      id: 'garamond',
      label: 'Garamond',
      stack: 'Garamond, "EB Garamond", "Palatino Linotype", "Times New Roman", serif',
      sample: 'She folded the letter twice.',
    },
    {
      id: 'times',
      label: 'Times',
      stack: '"Times New Roman", Times, "Liberation Serif", serif',
      sample: 'Nobody spoke for a while.',
    },
    {
      id: 'system',
      label: 'System UI',
      stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      sample: 'The hallway lights hummed.',
    },
    {
      id: 'helvetica',
      label: 'Helvetica',
      stack: 'Helvetica, "Helvetica Neue", Arial, "Nimbus Sans", sans-serif',
      sample: 'He checked the lock again.',
    },
    {
      id: 'verdana',
      label: 'Verdana',
      stack: 'Verdana, Geneva, Tahoma, sans-serif',
      sample: 'A chair scraped the floor.',
    },
    {
      id: 'trebuchet',
      label: 'Trebuchet',
      stack: '"Trebuchet MS", "Lucida Grande", "Lucida Sans Unicode", sans-serif',
      sample: 'The kettle clicked off.',
    },
    {
      id: 'mono',
      label: 'Typewriter',
      stack: 'ui-monospace, "Cascadia Mono", "Courier New", Courier, monospace',
      sample: 'Draft 3 — scene break.',
    },
  ] as const;

  readonly sizeChoices = [14, 16, 18, 20, 22, 24] as const;
  readonly minFontSize = 12;
  readonly maxFontSize = 28;

  readonly fontId = signal<string>(this.readStoredFontId());
  readonly fontSize = signal<number>(this.readStoredFontSize());
  readonly typeModalOpen = signal(false);

  readonly font = computed(
    () => this.fontChoices.find((f) => f.id === this.fontId()) ?? this.fontChoices[0],
  );

  readonly fontStack = computed(() => this.font().stack);

  private readStoredColumnCount(): 1 | 2 | 3 {
    try {
      const n = Number(localStorage.getItem(ChatReaderComponent.COLS_KEY));
      return n === 1 || n === 2 || n === 3 ? n : 3;
    } catch {
      return 3;
    }
  }

  private readStoredFontId(): string {
    try {
      const id = localStorage.getItem(ChatReaderComponent.FONT_KEY);
      return this.fontChoices.some((f) => f.id === id) ? id! : 'georgia';
    } catch {
      return 'georgia';
    }
  }

  private readStoredFontSize(): number {
    try {
      const n = Number(localStorage.getItem(ChatReaderComponent.SIZE_KEY));
      if (!Number.isFinite(n)) return 16;
      return Math.min(this.maxFontSize, Math.max(this.minFontSize, Math.round(n)));
    } catch {
      return 16;
    }
  }

  setColumnCount(n: 1 | 2 | 3): void {
    if (this.columnCount() === n) return;
    this.columnCount.set(n);
    try {
      localStorage.setItem(ChatReaderComponent.COLS_KEY, String(n));
    } catch {
      /* private mode / blocked storage */
    }
    this.page.set(0);
    queueMicrotask(() => this.layout());
  }

  setFontId(id: string): void {
    if (!this.fontChoices.some((f) => f.id === id)) return;
    if (this.fontId() === id) return;
    this.fontId.set(id);
    try {
      localStorage.setItem(ChatReaderComponent.FONT_KEY, id);
    } catch {
      /* ignore */
    }
    queueMicrotask(() => this.layout());
  }

  setFontSize(n: number): void {
    const next = Math.min(
      this.maxFontSize,
      Math.max(this.minFontSize, Math.round(Number(n) || 16)),
    );
    if (this.fontSize() === next) return;
    this.fontSize.set(next);
    try {
      localStorage.setItem(ChatReaderComponent.SIZE_KEY, String(next));
    } catch {
      /* ignore */
    }
    queueMicrotask(() => this.layout());
  }

  onFontSizeInput(raw: string | number): void {
    this.setFontSize(Number(raw));
  }

  openTypeModal(): void {
    this.typeModalOpen.set(true);
  }

  closeTypeModal(): void {
    this.typeModalOpen.set(false);
    queueMicrotask(() => this.layout());
  }

  onTypeBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.closeTypeModal();
  }

  private isUsable(n: ChatNode): boolean {
    return isUsableNode(n);
  }

  private allChildren(parentId: string | null): ChatNode[] {
    return this.chatService
      .currentNodes()
      .filter((n) => (n.parentId ?? null) === parentId && this.isUsable(n))
      .sort((a, b) => this.ts(a) - this.ts(b));
  }

  private ts(n: ChatNode): number {
    return storyNodeTimestamp(n);
  }

  readonly currentDoc = computed(() => {
    const all = this.documents();
    if (!all.length) return [];
    const i = Math.min(this.docIndex(), all.length - 1);
    return all[i];
  });

  readonly bookHtml = computed(() => {
    const hideQ = this.hideQuestions();
    return this.currentDoc()
      .filter((n) => !(hideQ && n.role === 'user'))
      .map((n) => this.nodeToHtml(n))
      .join('');
  });

  /** First stretch of the open document, used as a live type sample. */
  readonly previewHtml = computed(() => {
    const hideQ = this.hideQuestions();
    const parts: string[] = [];
    let chars = 0;
    for (const n of this.currentDoc()) {
      if (hideQ && n.role === 'user') continue;
      if (!this.isUsable(n)) continue;
      parts.push(this.nodeToHtml(n));
      chars += (n.content || '').length;
      if (parts.length >= 2 || chars >= 900) break;
    }
    return parts.join('') || '<p class="empty">Nothing on this path to preview yet.</p>';
  });

  readonly docLabel = computed(() => {
    const path = this.currentDoc();
    if (!path.length) return '';
    const tip = path[path.length - 1];
    const kind = tip.role === 'user' ? 'D' : tip.role === 'assistant' ? 'C' : 'S';
    const branch =
      this.allChildren(tip.parentId).length > 1
        ? ` · continuation ${this.allChildren(tip.parentId).findIndex((n) => n.id === tip.id) + 1}`
        : '';
    return `${kind} v${tip.version}${branch}`;
  });

  prevDoc() {
    this.docIndex.update((i) => Math.max(0, i - 1));
    this.page.set(0);
  }

  nextDoc() {
    this.docIndex.update((i) => Math.min(this.documents().length - 1, i + 1));
    this.page.set(0);
  }

  goFirstDoc() {
    this.docIndex.set(0);
    this.page.set(0);
  }
  goLastDoc() {
    this.docIndex.set(Math.max(0, this.documents().length - 1));
    this.page.set(0);
  }

  toggleQuestions(): void {
    this.hideQuestions.update((v) => !v);
    this.page.set(0);
    queueMicrotask(() => this.layout());
  }

  // ------------------------------------------------------------------
  // Version collapse — only the youngest version of each family is used
  // ------------------------------------------------------------------

  /** True when `a` is a newer version than `b` (higher version, else newer ts). */
  private isYounger(a: ChatNode, b: ChatNode): boolean {
    const va = a.version ?? 1;
    const vb = b.version ?? 1;
    if (va !== vb) return va > vb;
    return this.ts(a) > this.ts(b);
  }

  // ------------------------------------------------------------------
  // Documents — shared algorithm in core/story-paths
  // ------------------------------------------------------------------

  /**
   * All story documents as root→leaf paths. Delegates to the SHARED
   * enumerator (core/story-paths) so the reader and the DOCX/Markdown
   * exporters always agree:
   *   - youngest version per family only (older versions ignored),
   *   - plain DFS that CLONES the path from the root at every fork,
   *   - empty connectors kept, empty drafts dropped, orphans become roots.
   */
  readonly documents = computed(() => enumerateStoryDocuments(this.chatService.currentNodes()));

  private resizeObserver?: ResizeObserver;

  readonly title = computed(() => {
    const id = this.currentChatId();
    this.i18n.locale();
    return (
      this.chatService.chats().find((c) => c.id === id)?.title || this.i18n.t('common.untitled')
    );
  });

  constructor() {
    effect(() => {
      this.bookHtml();
      this.currentChatId();
      queueMicrotask(() => {
        this.page.set(0);
        this.layout();
      });
    });

    afterNextRender(() => {
      const el = this.reader()?.nativeElement;
      if (!el) return;
      this.resizeObserver = new ResizeObserver(() => this.layout());
      this.resizeObserver.observe(el);
      this.layout();
    });
  }

  async ngOnInit() {
    await this.chatService.loadChats();
    if (!this.currentChatId()) {
      await this.router.navigate(['/chat']);
    }
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
  }

  async backToTree() {
    await this.router.navigate(['/chat']);
  }

  prevPage() {
    this.goTo(this.page() - 1);
  }

  nextPage() {
    this.goTo(this.page() + 1);
  }

  onWheel(event: WheelEvent) {
    event.preventDefault();
    if (event.deltaY > 0 || event.deltaX > 0) this.nextPage();
    else this.prevPage();
  }

  private gap(el: HTMLElement): number {
    const g = parseFloat(getComputedStyle(el).columnGap);
    return Number.isFinite(g) ? g : 0;
  }

  /** Distance from the start of one spread to the start of the next. */
  private spreadWidth(el: HTMLElement): number {
    return el.clientWidth + this.gap(el);
  }

  private metrics(el: HTMLElement): { advance: number; pages: number } {
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const count = parseInt(cs.columnCount, 10) || 2;

    const content = el.clientWidth - padL - padR;
    const col = (content - gap * (count - 1)) / count;

    // next spread starts after `count` columns and `count` gaps
    const advance = count * (col + gap); // === content + gap

    const pages = Math.max(1, Math.round(el.scrollWidth / advance));
    return { advance, pages };
  }

  private goTo(index: number) {
    const el = this.reader()?.nativeElement;
    if (!el) return;
    const { advance, pages } = this.metrics(el);
    const next = Math.min(pages - 1, Math.max(0, index));
    this.page.set(next);
    this.pageCount.set(pages);
    el.scrollLeft = next * advance; // absolute, never +=
  }

  private layout() {
    const el = this.reader()?.nativeElement;
    if (!el) return;
    this.goTo(this.page());
    console.log(this.metrics(el), el.clientWidth, el.scrollWidth, el.scrollLeft);
  }

  private nodeToHtml(node: ChatNode): string {
    const kind =
      node.role === 'user' ? this.i18n.t('reader.roleUser') : this.i18n.t('reader.roleAssistant');
    const meta = [kind, node.modelId, `v${node.version}`].filter(Boolean).join(' · ');
    const body = this.markdown.toHtml(node.content || '');
    const files = (node.attachments || [])
      .map((a) => `<div class="book-file">${this.esc(a.name)}</div>`)
      .join('');
    return (
      `<section class="book-node book-${node.role}">` +
      `<header class="book-kicker">${this.esc(meta)}</header>` +
      `<div class="book-body">${body}</div>` +
      files +
      `</section>`
    );
  }

  private esc(s: string): string {
    return s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  }

  private isTyping(event: KeyboardEvent): boolean {
    const t = event.target as HTMLElement | null;
    return (
      !!t &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable)
    );
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent) {
    if (this.isTyping(event)) return;

    if (this.typeModalOpen()) {
      if (event.key === 'Escape' || event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        this.closeTypeModal();
      }
      return;
    }

    switch (event.key) {
      case 'f':
      case 'F':
        event.preventDefault();
        this.openTypeModal();
        break;
      case 'd':
      case 'D':
        event.preventDefault();
        this.toggleQuestions();
        break;
      case 'Escape':
        event.preventDefault();
        void this.backToTree();
        break;
      case 'PageDown':
      case 'ArrowRight':
      case ' ':
        event.preventDefault();
        this.nextPage();
        break;
      case 'PageUp':
      case 'ArrowLeft':
        event.preventDefault();
        this.prevPage();
        break;
      case 'Home':
        event.preventDefault();
        this.goTo(0);
        break;
      case 'End':
        event.preventDefault();
        this.goTo(this.pageCount() - 1);
        break;
    }
  }
}
