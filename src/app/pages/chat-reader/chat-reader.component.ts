import {
  Component, ElementRef, HostListener, OnDestroy, OnInit,
  afterNextRender, computed, effect, inject, signal, viewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ChatService } from '../../core/chat.service';
import { MarkdownService } from '../../core/markdown.service';
import { ChatNode } from '../../models/chat';

@Component({
  selector: 'app-chat-reader',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './chat-reader.component.html',
  styleUrl: './chat-reader.component.css'
})
export class ChatReaderComponent implements OnInit, OnDestroy {
  private readonly chatService = inject(ChatService);
  private readonly markdown = inject(MarkdownService);
  private readonly router = inject(Router);

  readonly reader = viewChild<ElementRef<HTMLElement>>('reader');

  readonly page = signal(0);
  readonly pageCount = signal(1);
  readonly currentChatId = this.chatService.currentChatId;
  readonly hideQuestions = signal(false);
  readonly docIndex = signal(0);
  private static readonly COLS_KEY = 'chat-reader.columnCount';

  readonly columnChoices = [1, 2, 3] as const;
  readonly columnCount = signal<1 | 2 | 3>(this.readStoredColumnCount());

  private readStoredColumnCount(): 1 | 2 | 3 {
    try {
      const n = Number(localStorage.getItem(ChatReaderComponent.COLS_KEY));
      return n === 1 || n === 2 || n === 3 ? n : 3;
    } catch {
      return 3;
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

  private isUsable(n: ChatNode): boolean {
    return !!(n.content?.trim() || n.attachments?.length);
  }

  private childIdsByParent(nodes: ChatNode[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const n of nodes) {
      if (!n.parentId) continue;
      const list = map.get(n.parentId) ?? [];
      list.push(n.id);
      map.set(n.parentId, list);
    }
    return map;
  }

  /** Empty node with no children: a draft leaf, not a document version. */
  private isEmptyLeaf(n: ChatNode, childIds: Map<string, string[]>): boolean {
    return !this.isUsable(n) && !(childIds.get(n.id)?.length);
  }

  private allChildren(parentId: string | null): ChatNode[] {
    return this.chatService.currentNodes()
      .filter(n => (n.parentId ?? null) === parentId && this.isUsable(n))
      .sort((a, b) => this.ts(a) - this.ts(b));
  }

  private ts(n: ChatNode): number {
    const t = Date.parse(n.createdAt || n.updatedAt || '');
    return Number.isFinite(t) ? t : 0;
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
      .filter(n => !(hideQ && n.role === 'user'))
      .map(n => this.nodeToHtml(n))
      .join('');
  });

  readonly docLabel = computed(() => {
    const path = this.currentDoc();
    if (!path.length) return '';
    const tip = path[path.length - 1];
    const kind = tip.role === 'user' ? 'D' : (tip.role === 'assistant' ? 'C' : 'S');
    const branch = this.allChildren(tip.parentId).length > 1
      ? ` · branch ${this.allChildren(tip.parentId).findIndex(n => n.id === tip.id) + 1}`
      : '';
    return `${kind} v${tip.version}${branch}`;
  });

  prevDoc() {
    this.docIndex.update(i => Math.max(0, i - 1));
    this.page.set(0);
  }

  nextDoc() {
    this.docIndex.update(i => Math.min(this.documents().length - 1, i + 1));
    this.page.set(0);
  }

  goFirstDoc() { this.docIndex.set(0); this.page.set(0); }
  goLastDoc() {
    this.docIndex.set(Math.max(0, this.documents().length - 1));
    this.page.set(0);
  }

  toggleQuestions(): void {
    this.hideQuestions.update(v => !v);
    this.page.set(0);
    queueMicrotask(() => this.layout());
  }

  private familyOf(node: ChatNode, byId: Map<string, ChatNode>): ChatNode[] {
    const ids = new Set<string>();
    let cur: ChatNode | undefined = node;
    while (cur) {                     // walk back to the first version
      if (ids.has(cur.id)) break;
      ids.add(cur.id);
      cur = cur.previousVersionId ? byId.get(cur.previousVersionId) : undefined;
    }
    for (const n of byId.values()) {  // walk forward to later versions
      if (n.previousVersionId && ids.has(n.previousVersionId)) ids.add(n.id);
    }
    // one more pass so long chains close
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of byId.values()) {
        if (ids.has(n.id)) continue;
        if (n.previousVersionId && ids.has(n.previousVersionId)) {
          ids.add(n.id);
          changed = true;
        }
        if (n.id && [...ids].some(id => byId.get(id)?.previousVersionId === n.id)) {
          ids.add(n.id);
          changed = true;
        }
      }
    }
    return [...ids].map(id => byId.get(id)!).filter(Boolean)
      .sort((a, b) => (a.version ?? 0) - (b.version ?? 0) || this.ts(a) - this.ts(b));
  }

  private familyId(node: ChatNode, byId: Map<string, ChatNode>): string {
    const fam = this.familyOf(node, byId);
    return fam[0]?.id ?? node.id;     // stable id = oldest version
  }

  readonly documents = computed(() => {
    const allNodes = this.chatService.currentNodes();
    const childIds = this.childIdsByParent(allNodes);

    // Keep empty nodes that still have children so the chain stays connected.
    // Drop empty childless nodes — they must not spawn extra document versions.
    const nodes = allNodes.filter(n => !this.isEmptyLeaf(n, childIds));
    const byId = new Map(nodes.map(n => [n.id, n]));

    const familyKids = new Map<string, ChatNode[]>();
    const addKid = (parentFamilyId: string, child: ChatNode) => {
      const list = familyKids.get(parentFamilyId) ?? [];
      if (!list.some(n => n.id === child.id)) list.push(child);
      familyKids.set(parentFamilyId, list);
    };

    for (const n of nodes) {
      if (!n.parentId) continue;
      const parent = byId.get(n.parentId);
      if (!parent) continue;
      addKid(this.familyId(parent, byId), n);
      // siblings in the parent's version family are also parents of n
      for (const rel of this.familyOf(parent, byId)) {
        addKid(this.familyId(rel, byId), n);
      }
    }

    // root families = nodes with no parent
    const roots = nodes.filter(n => !n.parentId);
    const rootFamilies = new Map<string, ChatNode[]>();
    for (const r of roots) {
      const fid = this.familyId(r, byId);
      rootFamilies.set(fid, this.familyOf(r, byId));
    }

    const paths: ChatNode[][] = [];

    const walk = (famMembers: ChatNode[], acc: ChatNode[]) => {
      for (const pick of famMembers) {
        // Empty childless versions are already filtered out. An empty node
        // that only exists to hold children must not appear in the book and
        // must not start a document of its own.
        const structuralOnly = !this.isUsable(pick);
        const nextAcc = structuralOnly ? acc : [...acc, pick];
        const fid = this.familyId(pick, byId);
        const rawKids = familyKids.get(fid) ?? [];
        // group kids into families (branches + their versions)
        const kidFam = new Map<string, ChatNode[]>();
        for (const kid of rawKids) {
          const kfid = this.familyId(kid, byId);
          kidFam.set(kfid, this.familyOf(kid, byId));
        }
        if (kidFam.size === 0) {
          if (!structuralOnly && nextAcc.length) paths.push(nextAcc);
          continue;
        }
        for (const members of kidFam.values()) {
          walk(members, nextAcc);
        }
      }
    };

    for (const members of rootFamilies.values()) walk(members, []);

    paths.sort((a, b) => {
      const va = a.reduce((s, n) => s + (n.version ?? 1), 0);
      const vb = b.reduce((s, n) => s + (n.version ?? 1), 0);
      if (va !== vb) return va - vb;                 // older version combo first
      return Math.max(...a.map(n => this.ts(n))) - Math.max(...b.map(n => this.ts(n)));
    });
    return paths;
  });

  private resizeObserver?: ResizeObserver;

  readonly title = computed(() => {
    const id = this.currentChatId();
    return this.chatService.chats().find(c => c.id === id)?.title || 'Untitled';
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
    el.scrollLeft = next * advance;   // absolute, never +=
  }

  private layout() {
    const el = this.reader()?.nativeElement;
    if (!el) return;
    this.goTo(this.page());
    console.log(this.metrics(el), el.clientWidth, el.scrollWidth, el.scrollLeft);
  }

  private nodeToHtml(node: ChatNode): string {
    const kind = node.role === 'user' ? 'Direction' : 'Chapter';
    const meta = [kind, node.modelId, `v${node.version}`].filter(Boolean).join(' · ');
    const body = this.markdown.toHtml(node.content || '');
    const files = (node.attachments || [])
      .map(a => `<div class="book-file">${this.esc(a.name)}</div>`)
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
    return s.replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
    ));
  }

  private isTyping(event: KeyboardEvent): boolean {
    const t = event.target as HTMLElement | null;
    return !!t && (
      t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable
    );
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent) {
    if (this.isTyping(event)) return;

    switch (event.key) {
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
