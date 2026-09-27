import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { ImportComponent } from './import.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../../core/chat.service';
import { ProjectService } from '../../core/project.service';
import { PersonaService } from '../../core/persona.service';
import { BundleService, BundleScope, BUNDLE_FORMAT } from '../../core/bundle.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi } from '../../../../test-helpers/factories';

/**
 * ImportComponent tests (the /import page).
 *
 * The component parses dropped/selected files straight from the browser
 * (FileReader + File.slice) through Bundles, Copilots, Grok exports and
 * "simple messages" files, so most tests drive the public Drag & drop /
 * file-input handlers with real File objects and flush the async work.
 * Persistence runs through the shared InMemoryChatApi + the real core
 * services (ChatService / ProjectService / PersonaService / BundleService),
 * which keeps the tests close to production behaviour.
 */

/** Simple messages export, the easiest input the parser understands. */
const SIMPLE_CHAT_JSON = JSON.stringify({
  title: 'My Chat',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'tool', content: 'invisible to the reader' },
  ],
});

const GROK_EXPORT_JSON = JSON.stringify({
  conversations: [
    {
      conversation: {
        id: 'g1',
        title: 'Grok Chat',
        system_prompt: 'You are helpful',
      },
      responses: [
        { response: { _id: 'r1', sender: 'user', message: 'Hello Grok' } },
        {
          response: { _id: 'r2', parent_response_id: 'r1', sender: 'ai', message: 'Hi there' },
        },
      ],
    },
  ],
});

const COPILOTS_JSON = JSON.stringify([
  { name: 'AgentX', prompt: 'You act as AgentX.', description: 'A demo agent' },
]);

const BUNDLE_JSON = JSON.stringify({
  format: BUNDLE_FORMAT,
  version: 2,
  exportedAt: '2024-01-01T00:00:00.000Z',
  scope: 'chats-only',
  includeChats: true,
  projects: [],
  topics: [],
  personas: [],
  chats: [
    {
      id: 'bundle-chat-1',
      title: 'Imported Bundle Chat',
      projectId: null,
      node_number: 1,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      nodes: [
        {
          id: 'bn-1',
          chatId: 'bundle-chat-1',
          parentId: null,
          role: 'user',
          content: 'Hello from bundle',
          version: 1,
          isCurrent: true,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    },
  ],
});

describe('ImportComponent', () => {
  let fixture: ComponentFixture<ImportComponent>;
  let component: ImportComponent;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let projectService: ProjectService;
  let personaService: PersonaService;
  let bundleService: BundleService;
  let i18n: I18nService;
  const router = { navigate: vi.fn(async () => true) };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    localStorage.clear();
    router.navigate.mockClear();

    await TestBed.configureTestingModule({
      imports: [ImportComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();

    i18n = TestBed.inject(I18nService);
    i18n.setLocale('en');
    chatService = TestBed.inject(ChatService);
    projectService = TestBed.inject(ProjectService);
    personaService = TestBed.inject(PersonaService);
    bundleService = TestBed.inject(BundleService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /** Let FileReader load events and every service promise chain settle. */
  async function flushAsync(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    }
  }

  /** Seed the API, then build the component after the constructor's loadAll(). */
  async function createComponent(): Promise<void> {
    fixture = TestBed.createComponent(ImportComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await flushAsync();
    fixture.detectChanges();
  }

  function makeFile(name: string, content: string, type = 'application/json'): File {
    return new File([content], name, { type });
  }

  /** Hand-rolled FileList stand-in; this jsdom env has no DataTransfer. */
  function asFileList(files: File[]): FileList {
    return files as unknown as FileList;
  }

  /** Plain event-shaped object; this jsdom env has no DragEvent global. */
  function dragEvent(extra: Record<string, unknown> = {}): DragEvent {
    return {
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    } as unknown as DragEvent;
  }

  /** Feed files through the drop zone exactly like the template's (drop). */
  function fireDrop(files: File[]): void {
    component.onDrop(dragEvent({ dataTransfer: { files: asFileList(files) } }));
  }

  /** Feed files through the file input exactly like the template's (change). */
  function fireFileInput(files: File[]): void {
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', {
      value: asFileList(files),
      configurable: true,
    });
    component.onFileSelected({ target: input } as unknown as Event);
  }

  async function dropJson(name: string, content: string): Promise<void> {
    fireDrop([makeFile(name, content)]);
    await flushAsync();
    fixture.detectChanges();
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  it('should create', async () => {
    await createComponent();
    expect(component).toBeTruthy();
  });

  it('renders the export box and the drop zone', async () => {
    await createComponent();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Export');
    expect(text).toContain('Scope');
    expect(text).toContain('Drop JSON file(s) here');
    expect(text).toContain('Choose file(s)');
  });

  it('offers the six export scopes', async () => {
    await createComponent();
    const values = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.export-grid option'),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual([
      'personas',
      'topic-project',
      'project-chats',
      'chat',
      'all-chats',
      'chats-only',
    ]);
  });

  // ------------------------------------------------------------------
  // Export scope picker gating
  // ------------------------------------------------------------------

  it('gates the pickers on the selected export scope', async () => {
    await createComponent();

    // Default scope: single chat.
    expect(component.exportScope()).toBe('chat');
    expect(component.needsChatPicker()).toBe(true);
    expect(component.needsProjectPicker()).toBe(false);
    expect(component.needsTopicPicker()).toBe(false);
    expect(component.needsIncludeChats()).toBe(false);

    component.exportScope.set('topic-project');
    expect(component.needsTopicPicker()).toBe(true);
    expect(component.needsIncludeChats()).toBe(true);
    expect(component.needsChatPicker()).toBe(false);
    expect(component.needsProjectPicker()).toBe(false);

    component.exportScope.set('chats-only');
    expect(component.needsProjectPicker()).toBe(true);
    expect(component.needsChatPicker()).toBe(true);
    expect(component.needsTopicPicker()).toBe(false);

    component.exportScope.set('project-chats');
    expect(component.needsProjectPicker()).toBe(true);
    expect(component.needsChatPicker()).toBe(false);

    component.exportScope.set('personas');
    expect(component.needsProjectPicker()).toBe(false);
    expect(component.needsChatPicker()).toBe(false);
    expect(component.needsTopicPicker()).toBe(false);
  });

  it('renders the topic/project/chat pickers according to the scope', async () => {
    await createComponent();
    const el = (fixture.nativeElement as HTMLElement).querySelector('.export-grid');

    component.exportScope.set('topic-project');
    fixture.detectChanges();
    expect(el?.textContent).toContain('Topic (environments + personas)');
    expect(el?.textContent).toContain('Include chats');

    component.exportScope.set('chat');
    fixture.detectChanges();
    expect(el?.textContent).not.toContain('Include chats');
  });

  it('filters the chat picker by project under chats-only', async () => {
    seedApi(api, {
      projects: [
        { id: 'p1', name: 'Alpha' },
        { id: 'p2', name: 'Beta' },
      ],
      chats: [
        { id: 'c1', title: 'In Alpha', projectId: 'p1' },
        { id: 'c2', title: 'In Beta', projectId: 'p2' },
        { id: 'c3', title: 'No Project', projectId: null },
      ],
    });
    await createComponent();

    // Without a scope, every chat is offered.
    expect(component.exportChatsForPicker().map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);

    component.exportScope.set('chats-only');
    component.exportProjectId.set('p1');
    expect(component.exportChatsForPicker().map((c) => c.id)).toEqual(['c1']);

    component.exportProjectId.set(null);
    expect(component.exportChatsForPicker().map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  // ------------------------------------------------------------------
  // Drag & drop chrome
  // ------------------------------------------------------------------

  it('toggles the dragging flag and .dragging class on drag over/leave', async () => {
    await createComponent();
    const zone = (fixture.nativeElement as HTMLElement).querySelector('.drop-zone')!;

    component.onDragOver(dragEvent());
    fixture.detectChanges();
    expect(component.isDragging()).toBe(true);
    expect(zone.classList.contains('dragging')).toBe(true);

    component.onDragLeave(dragEvent());
    fixture.detectChanges();
    expect(component.isDragging()).toBe(false);
    expect(zone.classList.contains('dragging')).toBe(false);
  });

  it('an empty file selection is a no-op', async () => {
    await createComponent();
    fireFileInput([]);
    await flushAsync();
    expect(component.pendingSessions().length).toBe(0);
    expect(component.summaries().length).toBe(0);
  });

  // ------------------------------------------------------------------
  // Parsing: sessions end up in the review list
  // ------------------------------------------------------------------

  it('parses a simple messages file into a pending session', async () => {
    await createComponent();
    await dropJson('chat.json', SIMPLE_CHAT_JSON);

    expect(component.pendingSessions().length).toBe(1);
    const session = component.pendingSessions()[0];
    expect(session.result.title).toBe('My Chat');
    expect(session.result.format).toBe('Simple Messages');
    // system message became the system prompt, tool message was ignored
    expect(session.result.systemPrompt).toBe('You are a helpful assistant.');
    // user + assistant + tool; the tool turn is parsed but flagged as ignored,
    // and only skipped once the session is actually imported
    expect(session.result.turns).toHaveLength(3);
    expect(session.result.turns[0].content).toBe('Hello');
    expect(session.result.turns[1].content).toBe('Hi there!');
    expect(session.result.turns[2].mappedType).toBe('ignored');
    expect(session.result.turns[2].content).toBe('invisible to the reader');
    expect(component.summaries().length).toBe(0);
  });

  it('parses a Grok export into a pending session per conversation', async () => {
    await createComponent();
    await dropJson('grok.json', GROK_EXPORT_JSON);

    expect(component.pendingSessions().length).toBe(1);
    const session = component.pendingSessions()[0];
    expect(session.result.title).toBe('Grok Chat');
    expect(session.result.format).toBe('Grok Export');
    expect(session.result.systemPrompt).toBe('You are helpful');
    expect(session.result.turns.map((t) => `${t.mappedType}:${t.content}`)).toEqual([
      'user:Hello Grok',
      'assistant:Hi there',
    ]);
  });

  it('renders the review list with the parsed title and turn count', async () => {
    await createComponent();
    await dropJson('chat.json', SIMPLE_CHAT_JSON);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Sessions to import');
    expect(el.textContent).toContain('My Chat');
    expect(el.textContent).toContain('3 turns');
  });

  // ------------------------------------------------------------------
  // Parsing: immediate imports (Copilots / Bundles) and errors
  // ------------------------------------------------------------------

  it('imports a Copilots file into projects immediately', async () => {
    await createComponent();
    await dropJson('copilots.json', COPILOTS_JSON);

    expect(api.projects.length).toBe(1);
    expect(api.projects[0].name).toBe('AgentX');
    expect(api.projects[0].systemPrompt).toBe('You act as AgentX.');
    expect(component.pendingSessions().length).toBe(0);
    expect(component.summaries().length).toBe(1);
    expect(component.summaries()[0].kind).toBe('copilots');
    expect(component.summaries()[0].created).toBe(1);
  });

  it('imports a bundle file through BundleService', async () => {
    await createComponent();
    await dropJson('bundle.json', BUNDLE_JSON);

    expect(component.pendingSessions().length).toBe(0);
    expect(component.summaries().length).toBe(1);
    const summary = component.summaries()[0];
    expect(summary.kind).toBe('bundle');
    expect(summary.detail).toBeTruthy();
    // 1 chat + 1 node
    expect(summary.created).toBe(2);

    expect(api.chats.length).toBe(1);
    expect(api.chats[0].title).toBe('Imported Bundle Chat');
    expect(api.nodes.length).toBe(1);
    expect(api.nodes[0].content).toBe('Hello from bundle');
  });

  it('records a file-level error summary for unparsable JSON', async () => {
    await createComponent();
    await dropJson('broken.json', '{ this is not json');

    expect(component.pendingSessions().length).toBe(0);
    expect(component.isImporting()).toBe(false);
    expect(component.globalError()).toBeNull();
    expect(component.summaries().length).toBe(1);
    expect(component.summaries()[0].created).toBe(0);
    expect(component.summaries()[0].error).toBeTruthy();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('broken.json');
  });

  it('handles several files of different kinds in one drop', async () => {
    await createComponent();
    fireDrop([
      makeFile('chat.json', SIMPLE_CHAT_JSON),
      makeFile('copilots.json', COPILOTS_JSON),
    ]);
    await flushAsync();
    fixture.detectChanges();

    expect(component.pendingSessions().length).toBe(1);
    expect(api.projects.length).toBe(1); // copilots imported immediately
    expect(component.summaries().length).toBe(1);
    expect(component.summaries()[0].kind).toBe('copilots');
  });

  // ------------------------------------------------------------------
  // Pending list actions
  // ------------------------------------------------------------------

  it('removes a session from the review list', async () => {
    await createComponent();
    await dropJson('chat.json', SIMPLE_CHAT_JSON);
    const id = component.pendingSessions()[0].id;

    component.removeSession(id);
    expect(component.pendingSessions().length).toBe(0);
  });

  it('assigns a project to a pending session', async () => {
    seedApi(api, { projects: [{ id: 'p1', name: 'Research' }] });
    await createComponent();
    await dropJson('chat.json', SIMPLE_CHAT_JSON);
    const id = component.pendingSessions()[0].id;

    expect(component.pendingSessions()[0].selectedProjectId).toBeNull();
    component.setSessionProject(id, 'p1');
    expect(component.pendingSessions()[0].selectedProjectId).toBe('p1');
  });

  it('clear() resets the list, summaries, progress and errors', async () => {
    await createComponent();
    await dropJson('chat.json', SIMPLE_CHAT_JSON);
    component.globalError.set('boom');
    component.progress.set('working…');
    component.lastAlignedStart.set(4);
    component.lastAlignedEnd.set(10);
    expect(component.pendingSessions().length).toBe(1);

    component.clear();

    expect(component.pendingSessions().length).toBe(0);
    expect(component.summaries().length).toBe(0);
    expect(component.progress()).toBe('');
    expect(component.globalError()).toBeNull();
    expect(component.lastAlignedStart()).toBeNull();
    expect(component.lastAlignedEnd()).toBeNull();
  });

  // ------------------------------------------------------------------
  // Importing the review list
  // ------------------------------------------------------------------

  it('imports pending sessions into a new chat and clears the list', async () => {
    await createComponent();
    await dropJson('chat.json', SIMPLE_CHAT_JSON);

    await component.importPendingSessions();
    fixture.detectChanges();

    expect(component.pendingSessions().length).toBe(0);
    expect(component.isImporting()).toBe(false);

    // system prompt → first node, then user + assistant turns
    expect(api.chats.length).toBe(1);
    expect(api.chats[0].title).toBe('My Chat');
    expect(api.projects.length).toBe(1); // auto-created from the chat title
    expect(api.nodes.length).toBe(3);
    expect(api.nodes[0].content).toBe('You are a helpful assistant.');
    expect(api.nodes[0].parentId).toBeNull();
    expect(api.nodes[1].content).toBe('Hello');
    expect(api.nodes[2].content).toBe('Hi there!');
    // the tool turn was mapped to "ignored" and skipped

    expect(component.summaries().length).toBe(1);
    expect(component.summaries()[0].kind).toBe('chat');
    expect(component.summaries()[0].created).toBe(3);
  });

  it('places a pending session into the project chosen in the picker', async () => {
    seedApi(api, { projects: [{ id: 'p1', name: 'Research' }] });
    await createComponent();
    await dropJson('chat.json', SIMPLE_CHAT_JSON);
    const id = component.pendingSessions()[0].id;

    component.setSessionProject(id, 'p1');
    await component.importPendingSessions();

    expect(api.chats.length).toBe(1);
    expect(api.chats[0].projectId).toBe('p1');
    expect(api.projects.length).toBe(1); // no auto-created project
  });

  // ------------------------------------------------------------------
  // Smart project ordering for the picker options
  // ------------------------------------------------------------------

  it('orders projects: matches first, then Unknown, then the rest alphabetically', async () => {
    seedApi(api, {
      projects: [
        { id: 'p-d', name: 'Delta' },
        { id: 'p-a', name: 'Alpha Beta' },
        { id: 'p-g', name: 'Gamma' },
      ],
    });
    await createComponent();

    const ordered = component.orderedProjectsFor('Notes for Alpha Beta');
    expect(ordered.map((o) => o.label)).toEqual(['Alpha Beta', 'Unknown', 'Delta', 'Gamma']);
    expect(ordered[1].id).toBeNull();

    // No title match → match list empty, Unknown comes first.
    expect(component.orderedProjectsFor('Completely unrelated').map((o) => o.label)).toEqual([
      'Unknown',
      'Alpha Beta',
      'Delta',
      'Gamma',
    ]);
  });

  // ------------------------------------------------------------------
  // Byte-window slicing
  // ------------------------------------------------------------------

  it('arms the slice controls from the last aligned end', async () => {
    await createComponent();
    component.lastAlignedStart.set(100);
    component.lastAlignedEnd.set(2048);

    component.useAlignedEndAsNextOffset();

    expect(component.useSlice).toBe(true);
    expect(component.sliceOffset).toBe(2048);
  });

  it('does nothing when no alignment has happened yet', async () => {
    await createComponent();
    component.useAlignedEndAsNextOffset();
    expect(component.useSlice).toBe(false);
  });

  // ------------------------------------------------------------------
  // Exporting a bundle
  // ------------------------------------------------------------------

  it('builds and downloads a bundle for the selected scope', async () => {
    seedApi(api, {
      projects: [{ id: 'p1', name: 'Alpha' }],
      chats: [
        { id: 'c1', title: 'Story', projectId: 'p1' },
        { id: 'c2', title: 'Other', projectId: 'p1' },
      ],
      nodes: [{ id: 'n1', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }],
    });
    await createComponent();

    let downloadedBlob: Blob | undefined;
    let downloadedAnchor: HTMLAnchorElement | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
      downloadedBlob = obj as Blob;
      return 'blob:chapterly-test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedAnchor = this;
    });

    component.exportScope.set('chat');
    component.exportChatId.set('c1');
    await component.exportBundle();

    expect(component.isExporting()).toBe(false);
    expect(downloadedAnchor?.download).toMatch(/^chapterly-bundle-chat-/);

    const payload = JSON.parse(await (downloadedBlob as Blob).text());
    expect(payload.format).toBe(BUNDLE_FORMAT);
    expect(payload.scope).toBe('chat');
    expect(payload.chats).toHaveLength(1);
    expect(payload.chats[0].title).toBe('Story');
    expect(payload.chats[0].nodes).toHaveLength(1);
    expect(payload.projects).toHaveLength(1);

    expect(component.progress()).toContain('Exported');
    expect(component.progress()).toContain('1 chat(s)');
  });

  it('reports an error when the scope has nothing to export', async () => {
    await createComponent();
    component.exportScope.set('chat');
    component.exportChatId.set(null);

    await component.exportBundle();

    expect(component.isExporting()).toBe(false);
    expect(component.globalError()).toContain('Nothing to export for this scope.');
  });

  it('downloads a DOCX of the longest chat version', async () => {
    seedApi(api, {
      chats: [{ id: 'c1', title: 'Book' }],
      nodes: [
        { id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' },
        { id: 'sT', chatId: 'c1', parentId: 'q0', role: 'structural', content: 'Book Title' },
        { id: 'q1', chatId: 'c1', parentId: 'sT', role: 'user', content: 'Q' },
        { id: 'h1', chatId: 'c1', parentId: 'q1', role: 'structural', content: 'Ch One' },
        { id: 'a1', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'old', version: 1, isCurrent: false, createdAt: '2025-01-01T00:00:00Z' },
        { id: 'a1b', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'a much longer chapter text', previousVersionId: 'a1', version: 2, isCurrent: true, createdAt: '2025-01-02T00:00:00Z' },
        { id: 'q2', chatId: 'c1', parentId: 'a1b', role: 'user', content: 'Q' },
        { id: 'a2', chatId: 'c1', parentId: 'q2', role: 'assistant', content: 'second chapter content' },
        { id: 'sIntro', chatId: 'c1', parentId: 'a2', role: 'structural', content: 'The introduction.' },
      ],
    });
    await createComponent();

    let downloadedBlob: Blob | undefined;
    let downloadedAnchor: HTMLAnchorElement | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
      downloadedBlob = obj as Blob;
      return 'blob:chapterly-docx';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedAnchor = this;
    });

    component.exportScope.set('chat');
    component.exportChatId.set('c1');
    await component.exportDocx();

    expect(component.isDocxExporting()).toBe(false);
    expect(downloadedAnchor?.download).toBe('Book.docx');

    const bytes = new Uint8Array(await (downloadedBlob as Blob).arrayBuffer());
    expect(bytes[0]).toBe(0x50); // PK
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('Book Title');
    expect(text).toContain('Ch One');
    expect(text).toContain('a much longer chapter text'); // longest version, not 'old'
    expect(text).not.toContain('>old<');
    expect(text).toContain('The introduction.');
    expect(component.progress()).toContain('Book');
  });

  it('downloads a Markdown file of the longest chat version', async () => {
    seedApi(api, {
      chats: [{ id: 'c1', title: 'Book' }],
      nodes: [
        { id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' },
        { id: 'sT', chatId: 'c1', parentId: 'q0', role: 'structural', content: 'Book Title' },
        { id: 'q1', chatId: 'c1', parentId: 'sT', role: 'user', content: 'Q' },
        { id: 'h1', chatId: 'c1', parentId: 'q1', role: 'structural', content: 'Ch One' },
        { id: 'a1', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'old', version: 1, isCurrent: false, createdAt: '2025-01-01T00:00:00Z' },
        { id: 'a1b', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'a much longer chapter text', previousVersionId: 'a1', version: 2, isCurrent: true, createdAt: '2025-01-02T00:00:00Z' },
        { id: 'q2', chatId: 'c1', parentId: 'a1b', role: 'user', content: 'Q' },
        { id: 'a2', chatId: 'c1', parentId: 'q2', role: 'assistant', content: 'second chapter content' },
        { id: 'sIntro', chatId: 'c1', parentId: 'a2', role: 'structural', content: 'The introduction.' },
      ],
    });
    await createComponent();

    let downloadedBlob: Blob | undefined;
    let downloadedAnchor: HTMLAnchorElement | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
      downloadedBlob = obj as Blob;
      return 'blob:chapterly-md';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedAnchor = this;
    });

    component.exportScope.set('chat');
    component.exportChatId.set('c1');
    await component.exportMarkdown();

    expect(component.isMarkdownExporting()).toBe(false);
    expect(downloadedAnchor?.download).toBe('Book.md');

    const text = await (downloadedBlob as Blob).text();
    expect(text).toContain('# Book Title');
    expect(text).toContain('## Introduction');
    expect(text).toContain('The introduction.');
    expect(text).toContain('# Ch One');
    expect(text).toContain('a much longer chapter text'); // longest version, not 'old'
    expect(text).not.toMatch(/^old$/m);
    expect(text).toContain('second chapter content');
    expect(component.progress()).toContain('Book');
  });

  it('asks which document to export when a chat has several paths', async () => {
    seedApi(api, {
      chats: [{ id: 'c1', title: 'Book' }],
      nodes: [
        { id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q', createdAt: '2025-01-01T00:00:00Z' },
        { id: 'b1', chatId: 'c1', parentId: 'q0', role: 'assistant', content: 'Branch one ending', version: 1, createdAt: '2025-01-02T00:00:00Z' },
        { id: 'b2', chatId: 'c1', parentId: 'q0', role: 'assistant', content: 'Branch two ending', version: 1, createdAt: '2025-01-03T00:00:00Z' },
      ],
    });
    await createComponent();

    let downloadedBlob: Blob | undefined;
    let downloadedAnchor: HTMLAnchorElement | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
      downloadedBlob = obj as Blob;
      return 'blob:chapterly-docx';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedAnchor = this;
    });

    component.exportScope.set('chat');
    component.exportChatId.set('c1');
    await component.exportDocx();

    // two paths → the picker opens, nothing downloaded yet
    expect(component.showDocPicker()).toBe(true);
    expect(component.docPickOptions().length).toBe(2);
    // most recent path (b2) is preselected
    expect(component.docPickIndex()).toBe(1);
    expect(downloadedAnchor).toBeUndefined();

    // choose the first path explicitly
    component.docPickIndex.set(0);
    component.confirmDocPick();

    expect(component.showDocPicker()).toBe(false);
    expect(downloadedAnchor?.download).toBe('Book.docx');
    const bytes = new Uint8Array(await (downloadedBlob as Blob).arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('Branch one ending');
    expect(text).not.toContain('Branch two ending');
  });

  it('cancelling the document picker exports nothing', async () => {
    seedApi(api, {
      chats: [{ id: 'c1', title: 'Book' }],
      nodes: [
        { id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q', createdAt: '2025-01-01T00:00:00Z' },
        { id: 'b1', chatId: 'c1', parentId: 'q0', role: 'assistant', content: 'Branch one ending', version: 1, createdAt: '2025-01-02T00:00:00Z' },
        { id: 'b2', chatId: 'c1', parentId: 'q0', role: 'assistant', content: 'Branch two ending', version: 1, createdAt: '2025-01-03T00:00:00Z' },
      ],
    });
    await createComponent();

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    component.exportScope.set('chat');
    component.exportChatId.set('c1');
    await component.exportDocx();
    expect(component.showDocPicker()).toBe(true);

    component.cancelDocPick();
    expect(component.showDocPicker()).toBe(false);
    expect(click).not.toHaveBeenCalled();
    // restore mocks so afterEach restoreAllMocks doesn't leak
    click.mockRestore();
    create.mockRestore();
  });

  // ------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------

  it('navigates to /projects from the result banner', async () => {
    await createComponent();
    await component.goToProjects();
    expect(router.navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('navigates to /chat from the result banner', async () => {
    await createComponent();
    await component.goToChat();
    expect(router.navigate).toHaveBeenCalledWith(['/chat']);
  });
});
