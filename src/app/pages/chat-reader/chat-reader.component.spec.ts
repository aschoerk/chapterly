import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { ChatReaderComponent } from './chat-reader.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../../core/chat.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeAttachment } from '../../../../test-helpers/factories';
import { ChatNode } from '../../models/chat';

/** Deterministic timestamps: t(1) < t(2) < … */
const t = (n: number): string => new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + n * 1000).toISOString();

/**
 * ChatReaderComponent tests (Reader view, route /read).
 *
 * The documents()/docLabel/bookHtml/previewHtml computed signals only depend on
 * the flat node list, so they are tested headlessly. Pagination calls into
 * getComputedStyle()/clientWidth/scrollWidth (jsdom has no layout), so those
 * tests drive a helper that fakes a deterministic 2-column measure.
 */
describe('ChatReaderComponent', () => {
  let fixture: ComponentFixture<ChatReaderComponent>;
  let component: ChatReaderComponent;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let i18n: I18nService;
  const router = { navigate: vi.fn(async () => true) };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    localStorage.clear();
    router.navigate.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // jsdom has no ResizeObserver; the component builds one in afterNextRender.
    class FakeResizeObserver {
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    // jsdom has no layout, so the first layout() (fired from afterNextRender
    // during the first detectChanges) would read NaN metrics. Give the
    // #reader element a deterministic 2-column measure up front. Real metrics:
    // content = clientWidth - 12; col = (content - gap)/count; advance = count*(col+gap).
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((target: Element) => {
      if (target instanceof HTMLElement && target.classList.contains('reader')) {
        return {
          columnGap: '4px',
          paddingLeft: '6px',
          paddingRight: '6px',
          columnCount: '2'
        } as unknown as CSSStyleDeclaration;
      }
      return realGetComputedStyle(target);
    });

    await TestBed.configureTestingModule({
      imports: [ChatReaderComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        { provide: Router, useValue: router }
      ]
    }).compileComponents();

    i18n = TestBed.inject(I18nService);
    i18n.setLocale('en');
    chatService = TestBed.inject(ChatService);

    // The component is created lazily (see createFixture/openChat) so that
    // ngOnInit's /chat redirect only ever runs with a known currentChatId.
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ------------------------------------------------------------------
  // Seed helpers
  // ------------------------------------------------------------------

  /** Build the component and run its first change detection (→ ngOnInit). */
  function createFixture(): void {
    fixture = TestBed.createComponent(ChatReaderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  /** Seed a single chat + tree, make it active, then render the component. */
  async function openChat(nodes: Array<Partial<ChatNode>>, title = 'Story'): Promise<void> {
    seedApi(api, { chats: [{ id: 'chat-1', title }], nodes });
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    createFixture(); // ngOnInit sees currentChatId = 'chat-1' → no redirect
    await fixture.whenStable();
    setReaderGeometry();
  }

  function readerEl(): HTMLElement {
    const el = component.reader()?.nativeElement;
    if (!el) throw new Error('#reader element not rendered');
    return el;
  }

  /**
   * Give the #reader element dimensions so metrics() is deterministic.
   * With the 2-column getComputedStyle stub (above): clientWidth 500 → advance 492;
   * scrollWidth 400 → 1 page, scrollWidth 1000 → 2 pages.
   */
  function setReaderGeometry(opts: { clientWidth?: number; scrollWidth?: number } = {}): void {
    const el = readerEl();
    Object.defineProperty(el, 'clientWidth', { value: opts.clientWidth ?? 500, configurable: true });
    Object.defineProperty(el, 'scrollWidth', { value: opts.scrollWidth ?? 400, configurable: true });
  }

  function key(event: { key: string; target?: EventTarget | null }): void {
    component.onKey({
      key: event.key,
      target: event.target ?? null,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent);
  }

  // ------------------------------------------------------------------
  // Loading / navigation
  // ------------------------------------------------------------------

  it('redirects to /chat when no story is open', async () => {
    fixture = TestBed.createComponent(ChatReaderComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    await fixture.whenStable();
    expect(router.navigate).toHaveBeenCalledWith(['/chat']);
  });

  it('stays put when a story is open', async () => {
    await openChat([]);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('shows the chat title', async () => {
    await openChat([{ id: 'q1', chatId: 'chat-1', parentId: null, role: 'user', content: 'Q' }], 'The Lighthouse');
    expect(component.title()).toBe('The Lighthouse');
  });

  it('falls back to "Untitled" for a chat without a title', async () => {
    await openChat([{ id: 'q1', chatId: 'chat-1', parentId: null, role: 'user', content: 'Q' }], '');
    expect(component.title()).toBe(i18n.t('common.untitled'));
  });

  it('backToTree navigates to /chat', async () => {
    await component.backToTree();
    expect(router.navigate).toHaveBeenCalledWith(['/chat']);
  });

  it('ngOnDestroy disconnects the resize observer without throwing', async () => {
    await openChat([{ id: 'q1', chatId: 'chat-1', parentId: null, role: 'user', content: 'Q' }]);
    component.ngOnDestroy();
    expect(true).toBe(true);
  });

  // ------------------------------------------------------------------
  // documents() — version chains, branches, structural nodes
  // ------------------------------------------------------------------

  it('builds one document per root-to-leaf usable path', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) }
    ]);
    expect(component.documents().map(p => p.map(n => n.id))).toEqual([['q1', 'a1']]);
  });

  it('drops empty childless leaves (draft nodes)', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) },
      { id: 'draft', parentId: 'a1', role: 'user', content: '', createdAt: t(3) }
    ]);
    expect(component.documents().map(p => p.map(n => n.id))).toEqual([['q1', 'a1']]);
  });

  it('keeps an empty structural parent in the chain without putting it in the book', async () => {
    await openChat([
      { id: 'e', parentId: null, role: 'structural', content: '', createdAt: t(1) },
      { id: 'q1', parentId: 'e', role: 'user', content: 'Q1', createdAt: t(2) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(3) }
    ]);
    const paths = component.documents().map(p => p.map(n => n.id));
    // the empty parent connects the chain but is not part of the document
    expect(paths).toEqual([['q1', 'a1']]);
    expect(component.bookHtml()).not.toContain('book-structural');
  });

  it('splits sibling assistant answers into separate documents', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) },
      { id: 'a2', parentId: 'q1', role: 'assistant', content: 'A2', version: 1, createdAt: t(3) }
    ]);
    expect(component.documents().map(p => p.map(n => n.id))).toEqual([
      ['q1', 'a1'],
      ['q1', 'a2']
    ]);
  });

  it('groups versions of the same answer via previousVersionId', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'v1', version: 1, createdAt: t(2) },
      { id: 'a2', parentId: 'q1', role: 'assistant', content: 'v2', version: 2, previousVersionId: 'a1', createdAt: t(3) }
    ]);
    const paths = component.documents().map(p => p.map(n => n.id));
    expect(paths).toEqual([
      ['q1', 'a1'],
      ['q1', 'a2']
    ]);
  });

  // ------------------------------------------------------------------
  // docLabel / document pager
  // ------------------------------------------------------------------

  it('labels documents with role, version and branch', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) },
      { id: 'a2', parentId: 'q1', role: 'assistant', content: 'A2', version: 1, createdAt: t(3) }
    ]);
    expect(component.docLabel()).toBe('C v1 · branch 1');
    component.nextDoc();
    expect(component.docLabel()).toBe('C v1 · branch 2');
  });

  it('walks the document pager within bounds', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) },
      { id: 'a2', parentId: 'q1', role: 'assistant', content: 'A2', version: 1, createdAt: t(3) }
    ]);

    expect(component.docIndex()).toBe(0);
    component.prevDoc();        // clamped at 0
    expect(component.docIndex()).toBe(0);

    component.nextDoc();
    expect(component.docIndex()).toBe(1);
    component.nextDoc();        // clamped at last
    expect(component.docIndex()).toBe(1);

    component.goFirstDoc();
    expect(component.docIndex()).toBe(0);
    component.goLastDoc();
    expect(component.docIndex()).toBe(1);
  });

  it('renders the doc folio with the label caption', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) }
    ]);
    const html = fixture.nativeElement.querySelector('.doc-pager') as HTMLElement;
    expect(html.textContent).toContain('Doc 1 / 1');
    expect(html.textContent).toContain('C v1');
    const first = html.querySelector('button[title*="Oldest"]');
    expect(first?.hasAttribute('disabled')).toBe(true);
  });

  // ------------------------------------------------------------------
  // bookHtml / previewHtml
  // ------------------------------------------------------------------

  it('renders role/meta kickers and the markdown body', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: '**Hello**', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer', modelId: 'm-1', version: 2, createdAt: t(2) }
    ]);
    const html = component.bookHtml();
    expect(html).toContain('class="book-node book-user"');
    expect(html).toContain('class="book-node book-assistant"');
    expect(html).toContain('direction · v1');      // chapter kicker meta
    expect(html).toContain('chapter · m-1 · v2');
    expect(html).toContain('<p><strong>Hello</strong></p>');
  });

  it('escapes HTML in meta and attachment names', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      {
        id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1',
        modelId: 'x<1>&', version: 1, createdAt: t(2),
        attachments: [makeAttachment({ name: 'notes<>.txt' })]
      }
    ]);
    const html = component.bookHtml();
    expect(html).toContain('chapter · x&lt;1&gt;&amp; · v1');
    expect(html).toContain('<div class="book-file">notes&lt;&gt;.txt</div>');
  });

  it('hides question (direction) nodes when hideQuestions is set', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) }
    ]);
    expect(component.bookHtml()).toContain('book-user');
    component.toggleQuestions();
    expect(component.hideQuestions()).toBe(true);
    expect(component.bookHtml()).not.toContain('book-user');
    expect(component.bookHtml()).toContain('book-assistant');
    component.toggleQuestions();
    expect(component.hideQuestions()).toBe(false);
  });

  it('builds the type preview from the start of the open document', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer', version: 1, createdAt: t(2) }
    ]);
    const preview = component.previewHtml();
    expect(preview).toContain('class="book-node book-user"');
    expect(preview).toContain('class="book-node book-assistant"');
  });

  it('shows a placeholder preview when nothing is usable', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: '', createdAt: t(1) }
    ]);
    expect(component.previewHtml()).toContain('class="empty"');
  });

  // ------------------------------------------------------------------
  // Column count / typeface persistence
  // ------------------------------------------------------------------

  it('sets and persists the column count, resetting the page', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) }
    ]);
    component.nextPage(); // page becomes 1 (or clamps) — doesn't matter
    component.setColumnCount(1);
    expect(component.columnCount()).toBe(1);
    expect(localStorage.getItem('chat-reader.columnCount')).toBe('1');
    expect(component.page()).toBe(0);
    component.setColumnCount(3);
    expect(component.columnCount()).toBe(3);
  });

  it('selects a font face, falling back to the first choice', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) }
    ]);
    component.setFontId('palatino');
    expect(component.fontId()).toBe('palatino');
    expect(component.font()).toBeDefined();
    expect(component.font().id).toBe('palatino');
    expect(component.fontStack()).toContain('Palatino');
    component.setFontId('nope');
    expect(component.fontId()).toBe('palatino');
    expect(localStorage.getItem('chat-reader.fontId')).toBe('palatino');
  });

  it('clamps and rounds font size, persisting it', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) }
    ]);
    component.setFontSize(999);
    expect(component.fontSize()).toBe(28);
    // 0 is falsy → Number(0) || 16 falls back to the default 16
    component.setFontSize(0);
    expect(component.fontSize()).toBe(16);
    component.setFontSize(4); // below min → clamped up to 12
    expect(component.fontSize()).toBe(12);
    component.setFontSize(17.6);
    expect(component.fontSize()).toBe(18);
    component.onFontSizeInput('21');
    expect(component.fontSize()).toBe(21);
    expect(localStorage.getItem('chat-reader.fontSize')).toBe('21');
  });

  it('recovers stored font settings, clamped to the allowed range', async () => {
    // The component constructor only reads storage at creation time, so put
    // values in place, then build a fresh fixture.
    localStorage.setItem('chat-reader.fontId', 'mono');
    localStorage.setItem('chat-reader.fontSize', '999');
    localStorage.setItem('chat-reader.columnCount', '2');

    seedApi(api, { chats: [{ id: 'chat-1', title: 'Story' }] });
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    createFixture();
    await fixture.whenStable();

    expect(component.fontId()).toBe('mono');
    expect(component.fontSize()).toBe(28); // clamped from 999
    expect(component.columnCount()).toBe(2);
  });

  // ------------------------------------------------------------------
  // Typeface modal
  // ------------------------------------------------------------------

  it('opens and closes the type modal, and closes on backdrop click', async () => {
    await openChat([{ id: 'q1', parentId: null, role: 'user', content: 'Q1' }]);
    expect(component.typeModalOpen()).toBe(false);
    component.openTypeModal();
    expect(component.typeModalOpen()).toBe(true);

    // closing via the Done button
    component.closeTypeModal();
    expect(component.typeModalOpen()).toBe(false);

    // backdrop click closes only when target === currentTarget
    component.openTypeModal();
    const target = {} as EventTarget;
    component.onTypeBackdrop({ target, currentTarget: {} as EventTarget } as unknown as MouseEvent);
    expect(component.typeModalOpen()).toBe(true); // mismatched target: stays open
    component.onTypeBackdrop({ target, currentTarget: target } as unknown as MouseEvent);
    expect(component.typeModalOpen()).toBe(false);
  });

  it('lists every font face in the modal', async () => {
    await openChat([{ id: 'q1', parentId: null, role: 'user', content: 'Q1' }]);
    component.openTypeModal();
    fixture.detectChanges();
    const faces = fixture.nativeElement.querySelectorAll('.face-card');
    expect(faces.length).toBe(component.fontChoices.length);
  });

  // ------------------------------------------------------------------
  // Keyboard shortcuts
  // ------------------------------------------------------------------

  it('toggles questions with d/D', async () => {
    await openChat([{ id: 'q1', parentId: null, role: 'user', content: 'Q1' }]);
    key({ key: 'd' });
    expect(component.hideQuestions()).toBe(true);
    key({ key: 'D' });
    expect(component.hideQuestions()).toBe(false);
  });

  it('opens the type modal with f/F and closes with Escape', async () => {
    await openChat([{ id: 'q1', parentId: null, role: 'user', content: 'Q1' }]);
    key({ key: 'f' });
    expect(component.typeModalOpen()).toBe(true);
    key({ key: 'Escape' });
    expect(component.typeModalOpen()).toBe(false);
    key({ key: 'F' });
    expect(component.typeModalOpen()).toBe(true);
    key({ key: 'f' }); // toggles closed from the modal state
    expect(component.typeModalOpen()).toBe(false);
  });

  it('ignores shortcuts while typing in an input', async () => {
    await openChat([{ id: 'q1', parentId: null, role: 'user', content: 'Q1' }]);
    const input = document.createElement('input');
    key({ key: 'd', target: input });
    expect(component.hideQuestions()).toBe(false);
  });

  it('spaces through pages with arrow/space/paging keys', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) }
    ]);
    setReaderGeometry({ scrollWidth: 1000 }); // 2 pages
    key({ key: 'ArrowRight' }); // layout() computes pageCount = 2
    expect(component.page()).toBe(1);
    key({ key: 'ArrowLeft' });
    expect(component.page()).toBe(0);
    key({ key: ' ' });
    expect(component.page()).toBe(1);
    key({ key: 'PageUp' });
    expect(component.page()).toBe(0);
    key({ key: 'PageDown' });
    expect(component.page()).toBe(1);
    key({ key: 'End' });
    expect(component.page()).toBe(1);
    key({ key: 'Home' });
    expect(component.page()).toBe(0);
  });

  it('Escape from the reader goes back to the tree', async () => {
    await openChat([{ id: 'q1', parentId: null, role: 'user', content: 'Q1' }]);
    key({ key: 'Escape' });
    expect(router.navigate).toHaveBeenCalledWith(['/chat']);
  });

  it('wheel scrolling turns pages', async () => {
    await openChat([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: t(1) },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', version: 1, createdAt: t(2) }
    ]);
    setReaderGeometry({ scrollWidth: 1000 }); // 2 pages
    const prevented = vi.fn();
    component.onWheel({ deltaY: 1, deltaX: 0, preventDefault: prevented } as unknown as WheelEvent);
    expect(prevented).toHaveBeenCalled();
    expect(component.page()).toBe(1);
    component.onWheel({ deltaY: -1, deltaX: 0, preventDefault: () => {} } as unknown as WheelEvent);
    expect(component.page()).toBe(0);
  });
});