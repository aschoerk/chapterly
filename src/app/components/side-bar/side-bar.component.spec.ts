import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { SideBarComponent } from './side-bar.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../../core/chat.service';
import { ProjectService } from '../../core/project.service';
import { PersonaService } from '../../core/persona.service';
import { ConfirmService } from '../../core/confirm.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import {
  makeChat, makeModel, makePersona, makeProject, makeTopic
} from '../../../../test-helpers/factories';

const LS_EXPANDED_KEY = 'chat-client.projects.expanded';

/**
 * SideBarComponent tests. Covers rendering, the topic filter, the search box,
 * sort/collapse buttons, every per-project / per-chat action button and the
 * inline chat-title editing (inserting text, Enter / Escape / blur).
 */
describe('SideBarComponent', () => {
  let fixture: ComponentFixture<SideBarComponent>;
  let component: SideBarComponent;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let projectService: ProjectService;
  let confirm: ConfirmService;
  let i18n: I18nService;
  const router = { navigate: vi.fn(async () => true) };

  // ------------------------------------------------------------------
  // Seed helpers (thin aliases over the shared test-helpers factories)
  // ------------------------------------------------------------------

  const project = makeProject;
  const topic = makeTopic;
  const chat = makeChat;
  const persona = makePersona;

  /** Create the component and run ngOnInit (which loads all data). */
  async function setup(seedFn?: (a: InMemoryChatApi) => void): Promise<void> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    localStorage.clear();
    router.navigate.mockClear();
    seedFn?.(api);

    if (!(HTMLElement.prototype as any).scrollIntoView) {
      (HTMLElement.prototype as any).scrollIntoView = () => {};
    }

    await TestBed.configureTestingModule({
      imports: [SideBarComponent],
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
    projectService = TestBed.inject(ProjectService);
    confirm = TestBed.inject(ConfirmService);

    fixture = TestBed.createComponent(SideBarComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  // ------------------------------------------------------------------
  // DOM helpers
  // ------------------------------------------------------------------

  function projectBlock(name: string): HTMLElement | null {
    const blocks = Array.from(
      fixture.nativeElement.querySelectorAll('.project-block') as NodeListOf<HTMLElement>
    );
    return blocks.find(b =>
      (b.querySelector('.project-name')?.textContent ?? '').trim() === name
    ) ?? null;
  }

  function chatItem(projectName: string, title: string): HTMLElement | null {
    const block = projectBlock(projectName);
    if (!block) return null;
    const items = Array.from(block.querySelectorAll('.chat-item') as NodeListOf<HTMLElement>);
    return items.find(i =>
      (i.querySelector('.chat-title')?.textContent ?? '').includes(title)
    ) ?? null;
  }

  /**
   * The persistent `.chat-item` row (identical to chatItem() but returns the
   * row even while inline-editing, when the `.chat-title` span is swapped for
   * the `.chat-title-input`). Grab it before entering edit mode and keep it.
   */
  function chatRow(projectName: string, title: string): HTMLElement | null {
    const block = projectBlock(projectName);
    if (!block) return null;
    const items = Array.from(block.querySelectorAll('.chat-item') as NodeListOf<HTMLElement>);
    return items.find(i =>
      (i.querySelector('.chat-title')?.textContent ?? '').includes(title)
    ) ?? null;
  }

  /** Find a button by its (translated) title inside a parent element. */
  function btn(parent: Element | null, i18nKey: string): HTMLButtonElement | null {
    if (!parent) return null;
    const title = i18n.t(i18nKey);
    return parent.querySelector(`button[title="${title}"]`);
  }

  function expandProject(name: string): void {
    projectBlock(name)?.querySelector('.expand-btn')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    fixture.detectChanges();
  }

  function assertExpanded(name: string, expected: boolean): void {
    expect(projectBlock(name)?.classList.contains('expanded')).toBe(expected);
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  describe('rendering', () => {
    it('renders every project name', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Alpha' }));
        a.projects.push(project({ id: 'p-2', name: 'Beta' }));
      });
      expect(projectBlock('Alpha')).not.toBeNull();
      expect(projectBlock('Beta')).not.toBeNull();
    });

    it('sorts projects by newest first by default', async () => {
      await setup(a => {
        const now = Date.now();
        a.projects.push(project({ id: 'p-old', name: 'Old', createdAt: new Date(now - 5000).toISOString() }));
        a.projects.push(project({ id: 'p-new', name: 'New', createdAt: new Date(now).toISOString() }));
      });
      const names = component.filteredProjects().map(p => p.name);
      expect(names).toEqual(['New', 'Old']);
    });

    it('shows the empty state when there are no projects', async () => {
      await setup();
      expect(projectBlock('any')).toBeNull();
      const empty = fixture.nativeElement.querySelector('.project-list > .empty');
      expect(empty?.textContent?.replace(/\s+/g, ' ').trim())
        .toContain(i18n.t('sidebar.noBooks'));
    });

    it('renders chat titles inside an expanded project', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Chapter One', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Chapter Two', projectId: 'p-1' }));
      });
      expandProject('Env A');
      expect(chatItem('Env A', 'Chapter One')).not.toBeNull();
      expect(chatItem('Env A', 'Chapter Two')).not.toBeNull();
    });

    it('shows "no chats" for an expanded project without chats', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expandProject('Env A');
      const empty = projectBlock('Env A')?.querySelector('.chat-list .empty');
      expect(empty?.textContent?.replace(/\s+/g, ' ').trim())
        .toContain(i18n.t('sidebar.noChats'));
    });

    it('renders the unassigned block for chats without a project', async () => {
      await setup(a => {
        a.chats.push(chat({ id: 'c1', title: 'Loose story', projectId: null }));
      });
      fixture.detectChanges();
      const unassigned = Array.from(
        fixture.nativeElement.querySelectorAll('.project-block.unassigned') as NodeListOf<HTMLElement>
      );
      expect(unassigned.length).toBe(1);
      // Chat comes with the block collapsed; expand it.
      projectBlock(i18n.t('sidebar.unfiled'))?.querySelector('.expand-btn')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      fixture.detectChanges();
      expect(chatItem(i18n.t('sidebar.unfiled'), 'Loose story')).not.toBeNull();
    });

    it('highlights the project of the current chat and the active chat', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Active', projectId: 'p-1' }));
      });
      expandProject('Env A');
      await chatService.selectChat('c1');
      await settle();
      expect(component.isCurrentProject('p-1')).toBe(true);
      expect(chatItem('Env A', 'Active')?.classList.contains('active')).toBe(true);
      expect(projectBlock('Env A')?.querySelector('.project-header')?.classList.contains('current'))
        .toBe(true);
    });

    it('shows the topic options in the dropdown', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1', name: 'Horror' }));
        a.topics.push(topic({ id: 't-2', name: 'Fantasy' }));
      });
      const options = Array.from(
        fixture.nativeElement.querySelectorAll('.sidebar-topic-filter option') as NodeListOf<HTMLOptionElement>
      );
      expect(options.map(o => o.textContent)).toContain('Horror');
      expect(options.map(o => o.textContent)).toContain('Fantasy');
      expect(options[0]?.value).toBe('all');
    });
  });

  // ------------------------------------------------------------------
  // Expand / collapse
  // ------------------------------------------------------------------

  describe('expand & collapse', () => {
    it('expands and collapses a project via the chevron button', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expect(component.isExpanded('p-1')).toBeFalsy();
      assertExpanded('Env A', false);

      expandProject('Env A');
      expect(component.isExpanded('p-1')).toBe(true);
      assertExpanded('Env A', true);

      expandProject('Env A');
      expect(component.isExpanded('p-1')).toBe(false);
      assertExpanded('Env A', false);
    });

    it('toggles by clicking anywhere on the project header', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      projectBlock('Env A')!.querySelector('.project-header')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      fixture.detectChanges();
      expect(component.isExpanded('p-1')).toBe(true);
    });

    it('persists the expanded state to localStorage', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expandProject('Env A');
      const raw = localStorage.getItem(LS_EXPANDED_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string)['p-1']).toBe(true);
    });

    it('restores the expanded state saved in localStorage on init', async () => {
      // seedFn runs after localStorage.clear() but before ngOnInit, so it can
      // pre-populate the persisted expanded map that ngOnInit reads back.
      await setup(a => {
        localStorage.setItem(LS_EXPANDED_KEY, JSON.stringify({ 'p-1': true }));
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expect(component.isExpanded('p-1')).toBe(true);
      expect(chatItem('Env A', 'Story 1')).not.toBeNull();
    });

    it('collapse-all collapses every project and persists', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.projects.push(project({ id: 'p-2', name: 'Beta' }));
      });
      expandProject('Env A');
      expandProject('Beta');
      expect(component.isExpanded('p-1')).toBe(true);
      expect(component.isExpanded('p-2')).toBe(true);

      const collapseBtn = fixture.nativeElement.querySelector('.collapse-all-btn') as HTMLButtonElement;
      collapseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(component.isExpanded('p-1')).toBe(false);
      expect(component.isExpanded('p-2')).toBe(false);
      expect(JSON.parse(localStorage.getItem(LS_EXPANDED_KEY) as string))
        .toEqual({ 'p-1': false, 'p-2': false });
    });
  });

  // ------------------------------------------------------------------
  // Topic filter
  // ------------------------------------------------------------------

  describe('topic filter', () => {
    it('filters the project list when a topic is selected', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'In topic' }));
        a.projects.push(project({ id: 'p-2', name: 'Out of topic' }));
        a.topics.push(topic({ id: 't-1', name: 'Horror', projectIds: ['p-1'] }));
      });
      component.selectTopicFilter('t-1');
      await settle();
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-1']);
      expect(projectBlock('In topic')).not.toBeNull();
      expect(projectBlock('Out of topic')).toBeNull();
    });

    it('persists the selected topic to localStorage', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1' }));
      });
      component.selectTopicFilter('t-1');
      expect(localStorage.getItem('chat.selectedTopicId')).toBe('t-1');
      component.selectTopicFilter('all');
      expect(localStorage.getItem('chat.selectedTopicId')).toBe('all');
    });

    it('selecting a topic through the <select> element updates the model', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1', name: 'Horror' }));
      });
      const select = fixture.nativeElement.querySelector('.sidebar-topic-filter select') as HTMLSelectElement;
      select.value = 't-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      expect(component.selectedTopicId()).toBe('t-1');
    });

    it('disables the edit-topic button while "all topics" is selected', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1' }));
      });
      const btn = fixture.nativeElement.querySelector('.sidebar-topic-filter button') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);

      component.selectTopicFilter('t-1');
      await settle();
      expect(btn.disabled).toBe(false);
    });

    it('navigates to the projects page with editTopic when a topic is selected', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1' }));
      });
      const editBtn = fixture.nativeElement.querySelector('.sidebar-topic-filter button') as HTMLButtonElement;
      component.selectTopicFilter('t-1');
      await settle();

      editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(router.navigate).toHaveBeenCalledWith(
        ['/projects'],
        { queryParams: { editTopic: 't-1' } }
      );
    });

    it('does not navigate when no topic is selected', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1' }));
      });
      component.editCurrentTopic(new Event('click'));
      await settle();
      expect(router.navigate).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------

  describe('search', () => {
    it('filters projects whose name matches the query', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Wonderland' }));
        a.projects.push(project({ id: 'p-2', name: 'Dreams' }));
      });
      component.setSearchQuery('wonder');
      await settle();
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Wonderland']);
      expect(projectBlock('Wonderland')).not.toBeNull();
      expect(projectBlock('Dreams')).toBeNull();
    });

    it('keeps a project visible when one of its chats matches the query', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Environment' }));
        a.chats.push(chat({ id: 'c1', title: 'Dragon hunt', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Winter night', projectId: 'p-1' }));
      });
      component.setSearchQuery('dragon');
      await settle();
      // project stays because it owns a matching chat
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-1']);
      // ... but only the matching chat is listed
      expect(component.getChatsForProject('p-1').map(c => c.id)).toEqual(['c1']);
      expandProject('Environment');
      expect(chatItem('Environment', 'Dragon hunt')).not.toBeNull();
      expect(chatItem('Environment', 'Winter night')).toBeNull();
    });

    it('clears the filter when the query is emptied', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Wonderland' }));
        a.projects.push(project({ id: 'p-2', name: 'Dreams' }));
      });
      component.setSearchQuery('wonder');
      await settle();
      expect(component.filteredProjects().length).toBe(1);
      component.setSearchQuery('');
      await settle();
      expect(component.filteredProjects().length).toBe(2);
    });

    it('toggles the search-in-content flag and persists it', async () => {
      await setup();
      expect(component.searchInContent()).toBe(false);
      component.setSearchInContent(true);
      expect(component.searchInContent()).toBe(true);
      expect(localStorage.getItem('chat.sidebar.searchInContent')).toBe('1');
      component.setSearchInContent(false);
      expect(component.searchInContent()).toBe(false);
      expect(localStorage.getItem('chat.sidebar.searchInContent')).toBe('0');
    });

    it('queries the server for content hits when search-in-content is on', async () => {
      await setup(a => {
        a.chats.push(chat({ id: 'c1', title: 'Hidden', projectId: null }));
      });
      const spy = vi.spyOn(api, 'searchChatIds').mockResolvedValue(['c1']);
      vi.useFakeTimers();
      component.setSearchInContent(true);
      component.setSearchQuery('needle');
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      vi.useRealTimers();
      expect(spy).toHaveBeenCalledWith('needle');
      expect(component.contentHitIds().has('c1')).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Sort button
  // ------------------------------------------------------------------

  describe('sort', () => {
    it('defaults to newest-first and shows the active class on the sort button', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expect(component.sortByNewest()).toBe(true);
      const sortBtn = fixture.nativeElement.querySelector('.sidebar-search button:not(.collapse-all-btn)') as HTMLButtonElement;
      expect(sortBtn.classList.contains('active')).toBe(true);
      expect(sortBtn.title).toBe(i18n.t('sidebar.sortNewest'));
    });

    it('toggles to alphabetical order on click', async () => {
      await setup(a => {
        const now = Date.now();
        a.projects.push(project({ id: 'p-old', name: 'Zeta', createdAt: new Date(now - 9000).toISOString() }));
        a.projects.push(project({ id: 'p-new', name: 'Alpha', createdAt: new Date(now).toISOString() }));
        a.chats.push(chat({ id: 'c1', title: 'First', projectId: 'p-old', created_at: new Date(now - 5000).toISOString() }));
        a.chats.push(chat({ id: 'c2', title: 'Second', projectId: 'p-new', created_at: new Date(now).toISOString() }));
      });
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Alpha', 'Zeta']);

      const sortBtn = fixture.nativeElement.querySelector('.sidebar-search button:not(.collapse-all-btn)') as HTMLButtonElement;
      sortBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(component.sortByNewest()).toBe(false);
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Alpha', 'Zeta']);
      expect(sortBtn.classList.contains('active')).toBe(false);
      expect(sortBtn.title).toBe(i18n.t('sidebar.sortAlpha'));
    });

    it('sorts chats by newest first when newest mode is on', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Old', projectId: 'p-1', updated_at: '2020-01-01T00:00:00Z' }));
        a.chats.push(chat({ id: 'c2', title: 'New', projectId: 'p-1', updated_at: '2024-01-01T00:00:00Z' }));
      });
      expandProject('Env A');
      expect(component.getChatsForProject('p-1').map(c => c.id)).toEqual(['c2', 'c1']);
    });
  });

  // ------------------------------------------------------------------
  // Project actions
  // ------------------------------------------------------------------

  describe('project actions', () => {
    it('edit-project button navigates to /projects with editProject query param', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expandProject('Env A');
      const edit = btn(projectBlock('Env A'), 'sidebar.editEnvironment')!;
      edit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(router.navigate).toHaveBeenCalledWith(
        ['/projects'],
        { queryParams: { editProject: 'p-1' } }
      );
    });

    it('edit-project stops propagation (project stays expanded)', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expandProject('Env A');
      btn(projectBlock('Env A'), 'sidebar.editEnvironment')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      assertExpanded('Env A', true);
    });

    it('startEditProject (double click on name) records the project for inline editing', async () => {
      await setup(a => {
        a.projects.push(project({
          id: 'p-1',
          systemPrompt: 'You are a bard',
          defaultModelId: 'm-1'
        }));
      });
      const nameEl = projectBlock('Env A')!.querySelector('.project-name')!;
      nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      fixture.detectChanges();
      expect(component.editingProjectId()).toBe('p-1');
      expect(component.editName()).toBe('Env A');
      expect(component.editSystemPrompt()).toBe('You are a bard');
      expect(component.editDefaultModelId()).toBe('m-1');
    });

    it('create-chat button creates a story with seed nodes, expands and selects it', async () => {
      await setup(a => {
        a.projects.push(project({
          id: 'p-1',
          systemPrompt: 'You are a world-building assistant.',
          greeting: 'Welcome',
          defaultModelId: 'm-1'
        }));
        a.models.push(makeModel({ id: 'm-1' }));
      });
      const newBtn = btn(projectBlock('Env A'), 'sidebar.newStory')!;
      newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(api.chats.length).toBe(1);
      const created = api.chats[0];
      expect(created.title).toBe(i18n.t('sidebar.newChatTitle', { name: 'Env A' }));
      expect(created.projectId).toBe('p-1');
      // user + greeting assistant nodes injected by buildSeedNodeDrafts
      // (selectChat may add an extra root draft leaf, so assert the seeds exist)
      const nodes = api.nodes.filter(n => n.chatId === created.id);
      const userNode = nodes.find(n => n.role === 'user' && n.content.includes('world-building'));
      const greetingNode = nodes.find(n => n.role === 'assistant' && n.content.includes('Welcome'));
      expect(userNode).toBeDefined();
      expect(greetingNode).toBeDefined();
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      expect(component.currentChatId()).toBe(created.id);
      expect(component.isExpanded('p-1')).toBe(true);
    });

    it('creates a chat through the chat service (inserting into the list)', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      await component.createChatForProject(component.projects()[0]);
      await settle();
      expect(chatService.chats().some(c => c.projectId === 'p-1')).toBe(true);
      expect(api.chats.length).toBe(1);
    });

    it('delete-project with confirmation removes the project and its chats', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story', projectId: 'p-1' }));
      });
      const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(true);
      btn(projectBlock('Env A'), 'sidebar.deleteBook')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(ask).toHaveBeenCalled();
      expect(projectService.projects().find(p => p.id === 'p-1')).toBeUndefined();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeUndefined();
      expect(projectBlock('Env A')).toBeNull();
    });

    it('delete-project keeps everything when the confirmation is dismissed', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story', projectId: 'p-1' }));
      });
      vi.spyOn(confirm, 'ask').mockResolvedValue(false);
      btn(projectBlock('Env A'), 'sidebar.deleteBook')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(projectService.projects().find(p => p.id === 'p-1')).toBeDefined();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Chat actions
  // ------------------------------------------------------------------

  describe('chat actions', () => {
    it('selects a chat on click and expands its project', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Story 2', projectId: 'p-1' }));
      });
      expandProject('Env A');
      chatItem('Env A', 'Story 2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(component.currentChatId()).toBe('c2');
      expect(component.isExpanded('p-1')).toBe(true);
    });

    it('unassign button moves a chat out of its project', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const unassign = btn(chatItem('Env A', 'Story 1'), 'sidebar.moveUnassigned')!;
      unassign.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBeNull();
      expect(component.getChatsForProject('p-1').length).toBe(0);
    });

    it('reassign button toggles the dropdown, and choosing a project moves the chat', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.projects.push(project({ id: 'p-2', name: 'Env B' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const move = btn(chatItem('Env A', 'Story 1'), 'sidebar.moveEnvironment')!;
      move.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(component.reassigningChatId()).toBe('c1');

      const dropdown = chatItem('Env A', 'Story 1')!.closest('.chat-item')!
        .parentElement!.querySelector('.reassign-dropdown') as HTMLElement;
      expect(dropdown).not.toBeNull();
      const select = dropdown.querySelector('.reassign-select') as HTMLSelectElement;
      expect(select).not.toBeNull();

      select.value = 'p-2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();

      expect(component.reassigningChatId()).toBeNull();
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-2');
    });

    it('clone button duplicates the chat (including nodes) into the same project', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Original', projectId: 'p-1', node_number: 1 }));
        a.nodes.push({
          id: 'n1', chatId: 'c1', parentId: null, role: 'user',
          content: 'hello', version: 1, isCurrent: true, createdAt: new Date().toISOString()
        } as any);
      });
      expandProject('Env A');
      const clone = btn(chatItem('Env A', 'Original'), 'sidebar.cloneStory')!;
      clone.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(api.chats.length).toBe(2);
      const copy = api.chats.find(c => c.id !== 'c1')!;
      expect(copy.title).toContain('(copy)');
      expect(copy.projectId).toBe('p-1');
      expect(api.nodes.filter(n => n.chatId === copy.id).length).toBe(1);
    });

    it('delete-chat removes the chat after confirmation', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      vi.spyOn(confirm, 'ask').mockResolvedValue(true);
      btn(chatItem('Env A', 'Story 1'), 'common.delete')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeUndefined();
    });

    it('delete-chat keeps the chat when the confirmation is dismissed', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      vi.spyOn(confirm, 'ask').mockResolvedValue(false);
      btn(chatItem('Env A', 'Story 1'), 'common.delete')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Inline chat-title editing (inserting into the input)
  // ------------------------------------------------------------------

  describe('inline chat-title editing', () => {
    it('rename button enters edit mode with the current title prefilled', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const row = chatRow('Env A', 'Story 1')!;
      const rename = btn(row, 'sidebar.renameStory')!;
      rename.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(component.editingChatId()).toBe('c1');
      expect(component.titleDraft()).toBe('Story 1');
      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('Story 1');
    });

    it('types into the input (inserting text) and saves with Enter', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = 'Renamed Story';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      expect(component.titleDraft()).toBe('Renamed Story');

      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();

      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Renamed Story');
      expect(component.editingChatId()).toBeNull();
      expect(chatItem('Env A', 'Renamed Story')).not.toBeNull();
    });

    it('trims whitespace and ignores blank renames', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const spy = vi.spyOn(chatService, 'updateChatTitle');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = '   Padded   ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();
      expect(spy).toHaveBeenCalledWith('c1', 'Padded');

      // blank → not saved (re-enter edit mode on the saved title)
      const row2 = chatRow('Env A', 'Padded')!;
      btn(row2, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      const input2 = row2.querySelector('.chat-title-input') as HTMLInputElement;
      input2.value = '   ';
      input2.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input2.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Padded');
    });

    it('cancels editing with Escape without saving', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = 'Should not stick';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
      await settle();

      expect(component.editingChatId()).toBeNull();
      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Story 1');
    });

    it('saves on blur', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = 'Via Blur';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      await settle();

      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Via Blur');
    });

    it('does not save when the title is unchanged', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const spy = vi.spyOn(chatService, 'updateChatTitle');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();
      expect(spy).not.toHaveBeenCalled();
      expect(component.editingChatId()).toBeNull();
    });

    it('renames a chat in the unassigned block too', async () => {
      await setup(a => {
        a.chats.push(chat({ id: 'c1', title: 'Loose', projectId: null }));
      });
      const unassigned = projectBlock(i18n.t('sidebar.unfiled'))!;
      unassigned.querySelector('.expand-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
      const item = chatItem(i18n.t('sidebar.unfiled'), 'Loose')!;
      btn(item, 'sidebar.renameStory')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      const input = item.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = 'Tight';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Tight');
    });
  });

  // ------------------------------------------------------------------
  // Persona navigation
  // ------------------------------------------------------------------

  describe('persona navigation', () => {
    it('avatar click navigates to the personas page', async () => {
      await setup(a => {
        a.personas.push(persona({ id: 'pers-1', name: 'Author' }));
      });
      TestBed.inject(PersonaService).setCurrentPersona('pers-1');
      fixture.detectChanges();
      const avatar = fixture.nativeElement.querySelector('.current-persona-avatar') as HTMLElement;
      expect(avatar).not.toBeNull();
      avatar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(router.navigate).toHaveBeenCalledWith(['/personas']);
    });

    it('goToPersonas navigates to the personas page', async () => {
      await setup();
      await component.goToPersonas();
      await settle();
      expect(router.navigate).toHaveBeenCalledWith(['/personas']);
    });
  });
});