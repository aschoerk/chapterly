import {Component, inject, signal, OnInit, computed} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { Router } from '@angular/router';
import { LastModelService } from '../../core/last-model.service';
import { SettingsService } from '../../core/settings.service';
import {Chat, Project, Topic} from '../../models/chat';
import {CHAT_API} from '../../api/chat-api.token';
import { AvatarViewComponent } from '../avatar-view/avatar-view.component';
import { ConfirmService } from '../../core/confirm.service';
import { buildSeedNodeDrafts } from '../../core/llm/llm-context';
import {ProjectService} from '../../core/project.service';
import {PersonaService} from '../../core/persona.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { TopicSelectionService } from '../../core/topic-selection.service';
import { SortPreferencesService, SortMode } from '../../core/sort-preferences.service';

const LS_EXPANDED_KEY = 'chat-client.projects.expanded';
/** localStorage-backed sort preference key for this (sidebar) page. */
const SORT_PAGE = 'sidebar';

@Component({
  selector: 'side-bar',
  standalone: true,
  imports: [CommonModule, FormsModule, AvatarViewComponent],
  templateUrl: './side-bar.component.html',
  styleUrls: ['./side-bar.component.css']
})
export class SideBarComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly personaService = inject(PersonaService);

  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);
  readonly i18n = inject(I18nService);
  private readonly api = inject(CHAT_API);
  private readonly topicSelection = inject(TopicSelectionService);
  private readonly sortPrefs = inject(SortPreferencesService);

  readonly projects = this.projectService.projects;
  readonly currentChatId = this.chatService.currentChatId;
  readonly chatsByProject = this.chatService.chatsByProject;
  readonly enabledModels = this.settings.enabledModels;
  readonly searchQuery = signal('');
  readonly searchInContent = signal(
    localStorage.getItem('chat.sidebar.searchInContent') === '1'
  );
  readonly contentHitIds = signal<Set<string>>(new Set());
  private contentSearchTimer: ReturnType<typeof setTimeout> | null = null;
  readonly currentPersona = this.personaService.currentPersona;
  readonly topics = this.projectService.topics;

  readonly expanded = signal<Record<string, boolean>>({});
  readonly editingProjectId = signal<string | null>(null);
  readonly editName = signal('');
  readonly editSystemPrompt = signal('');
  readonly editDefaultModelId = signal<string | null>(null);
  // Project list sorting (harmonized with the Topics / Projects pages and
  // persisted per page via SortPreferencesService; defaults to newest first).
  readonly sortMode = this.sortPrefs.modeFor(SORT_PAGE);
  /** true: A→Z, false: Z→A */
  readonly alphaAsc = this.sortPrefs.alphaAscFor(SORT_PAGE);
  /** true: most recent first, false: oldest first */
  readonly updatedDesc = this.sortPrefs.updatedDescFor(SORT_PAGE);
  /**
   * The project pinned to the top by the last sort-button press (the "current"
   * project at that moment). Pinning only happens on an explicit sort action,
   * not just because a chat got opened.
   */
  readonly pinnedProjectId = signal<string | null>(null);
  readonly reassigningChatId = signal<string | null>(null);
  readonly editingChatId = signal<string | null>(null);
  readonly titleDraft = signal('');
  readonly selectedTopicId = this.topicSelection.selectedTopicId;

  selectTopicFilter(id: string) {
    this.topicSelection.selectTopic(id || 'all');
  }

  setSearchQuery(q: string) {
    this.searchQuery.set(q);
    this.scheduleContentSearch();
  }

  setSearchInContent(on: boolean) {
    this.searchInContent.set(on);
    localStorage.setItem('chat.sidebar.searchInContent', on ? '1' : '0');
    this.scheduleContentSearch(true);
  }

  private scheduleContentSearch(immediate = false) {
    if (this.contentSearchTimer) clearTimeout(this.contentSearchTimer);
    const run = async () => {
      const q = this.searchQuery().trim();
      if (!this.searchInContent() || !q) {
        this.contentHitIds.set(new Set());
        return;
      }
      try {
        const ids = await this.api.searchChatIds(q);
        this.contentHitIds.set(new Set(ids));
      } catch {
        this.contentHitIds.set(new Set());
      }
    };
    if (immediate) void run();
    else this.contentSearchTimer = setTimeout(() => void run(), 280);
  }

  private chatMatchesQuery(chat: Chat, q: string): boolean {
    if (!q) return true;
    if ((chat.title || '').toLowerCase().includes(q)) return true;
    return this.searchInContent() && this.contentHitIds().has(chat.id);
  }

  filteredProjects = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const topicId = this.selectedTopicId();
    let list = this.projects();

    if (topicId && topicId !== 'all') {
      const topic = this.topics().find(t => t.id === topicId);
      if (topic) {
        const idSet = new Set(topic.projectIds);
        list = list.filter(p => idSet.has(p.id));
      }
    }

    if (q) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        this.getChatsForProject(p.id).length > 0
      );
    }

    // Apply the selected sort mode (same as Topics / Projects pages).
    list = [...list];
    if (this.sortMode() === 'alpha') {
      list.sort((a, b) => {
        const cmp = a.name.localeCompare(b.name, this.i18n.localeId());
        return this.alphaAsc() ? cmp : -cmp;
      });
    } else {
      list.sort((a, b) => this.projectTime(b) - this.projectTime(a));
      if (!this.updatedDesc()) list.reverse();
    }

    // A project that was pinned by pressing a sort button stays on top.
    const pinnedId = this.pinnedProjectId();
    if (pinnedId) {
      const pinned = list.find(p => p.id === pinnedId);
      if (pinned) {
        return [pinned, ...list.filter(p => p.id !== pinnedId)];
      }
    }
    return list;
  });

  /** The project that owns the currently open chat, or null. */
  readonly currentProjectId = computed<string | null>(() => {
    const chatId = this.chatService.currentChatId();
    if (!chatId) return null;
    const chat = this.chatService.chats().find(c => c.id === chatId);
    return chat?.projectId || null;
  });

  async ngOnInit() {
    await Promise.all([
      this.projectService.loadProjects(),
      this.chatService.loadChats(),
      this.personaService.loadPersonas(),
      this.projectService.loadTopics(),
      this.settings.loadAll()
    ]);
    this.loadExpandedState();
    this.scrollToActiveChat();
  }

  private loadExpandedState() {
    try {
      const raw = localStorage.getItem(LS_EXPANDED_KEY);
      if (raw) this.expanded.set(JSON.parse(raw));
    } catch { /* ignore */ }
  }

  private persistExpanded() {
    try {
      localStorage.setItem(LS_EXPANDED_KEY, JSON.stringify(this.expanded()));
    } catch { /* ignore */ }
  }

  isExpanded(projectId: string): boolean {
    return this.expanded()[projectId];
  }

  toggleExpanded(projectId: string, event?: Event) {
    event?.stopPropagation();
    this.expanded.update(m => ({
      ...m,
      [projectId]: !this.isExpanded(projectId)
    }));
    this.persistExpanded();
  }

  toggleSort(mode: SortMode): void {
    // An explicit sort press pins the current (last opened) project to the top.
    this.pinnedProjectId.set(this.currentProjectId());

    if (this.sortMode() === mode) {
      if (mode === 'alpha') this.sortPrefs.setAlphaAsc(SORT_PAGE, !this.alphaAsc());
      else this.sortPrefs.setUpdatedDesc(SORT_PAGE, !this.updatedDesc());
    } else {
      // First click always starts with the primary direction.
      this.sortPrefs.setMode(SORT_PAGE, mode);
      if (mode === 'alpha') this.sortPrefs.setAlphaAsc(SORT_PAGE, true);
      else this.sortPrefs.setUpdatedDesc(SORT_PAGE, true);
    }
  }

  alphaLabel(): string {
    return this.sortMode() === 'alpha' && !this.alphaAsc() ? 'Z–A' : 'A–Z';
  }

  alphaSortTitleKey(): string {
    if (this.sortMode() !== 'alpha') return 'sort.alpha';
    return this.alphaAsc() ? 'sort.alphaAZ' : 'sort.alphaZA';
  }

  updatedSortTitleKey(): string {
    if (this.sortMode() !== 'updated') return 'sort.updated';
    return this.updatedDesc() ? 'sort.updatedNew' : 'sort.updatedOld';
  }

  /**
   * Effective age key for an environment in the "by age" sort mode.
   *
   * Environments are ordered by the age of their stories: when sorting by
   * newest first we use the environment's youngest chat, when sorting by
   * oldest first we use its oldest chat. That way an environment rises / falls
   * with the activity of its chats (the project row itself keeps its own
   * updatedAt, which the backend does not touch when a chat changes).
   * Environments without chats fall back to their own updated/created stamp.
   */
  private projectTime(p: Project): number {
    const fallback = new Date(p.updatedAt || p.createdAt).getTime() || 0;
    const times = (this.chatsByProject().get(p.id) || [])
      .map(c => new Date(c.updated_at || c.created_at).getTime())
      .filter(t => t > 0);
    if (!times.length) return fallback;
    // Use the youngest chat when ordering newest-first, the oldest chat when
    // ordering oldest-first (the caller sorts descending and reverses for the
    // oldest-first direction, so both directions come out correct).
    return this.updatedDesc()
      ? times.reduce((a, b) => Math.max(a, b))
      : times.reduce((a, b) => Math.min(a, b));
  }

  editProject(project: Project, event?: Event) {
    event?.stopPropagation();
    void this.router.navigate(['/projects'], { queryParams: { editProject: project.id } });
  }

  editCurrentTopic(event?: Event) {
    event?.stopPropagation();
    const topicId = this.selectedTopicId();
    if (!topicId || topicId === 'all') return;
    void this.router.navigate(['/projects'], { queryParams: { editTopic: topicId } });
  }

  startEditChatTitle(chat: Chat, event?: Event) {
    event?.stopPropagation();
    this.reassigningChatId.set(null);
    this.editingChatId.set(chat.id);
    this.titleDraft.set(chat.title || '');
  }

  cancelEditChatTitle() {
    this.editingChatId.set(null);
  }

  async saveChatTitle(chat: Chat) {
    if (this.editingChatId() !== chat.id) return;
    const title = this.titleDraft().trim();
    this.editingChatId.set(null);
    if (!title || title === chat.title) return;
    await this.chatService.updateChatTitle(chat.id, title);
  }

  startEditProject(project: Project, event?: Event) {
    event?.stopPropagation();
    this.editingProjectId.set(project.id);
    this.editName.set(project.name);
    this.editSystemPrompt.set(project.systemPrompt || '');
    this.editDefaultModelId.set(project.defaultModelId);
  }

  async deleteProject(project: Project, event: Event) {
    event.stopPropagation();

    const chatCount = this.getChatsForProject(project.id).length;
    const message = chatCount === 0
      ? this.i18n.t('sidebar.deleteEnvEmpty', { name: project.name })
      : this.i18n.t('sidebar.deleteEnvWithStories', {
        name: project.name,
        count: chatCount,
        stories: this.i18n.t(chatCount === 1 ? 'sidebar.storyWord' : 'sidebar.storiesWord')
      });

    const ok = await this.confirm.ask({
      title: this.i18n.t('sidebar.deleteEnvTitle'),
      message,
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;

    const deleteChats = chatCount > 0;
    await this.projectService.deleteProject(project.id, deleteChats);

    this.expanded.update(m => {
      const next = { ...m };
      delete next[project.id];
      return next;
    });
    this.persistExpanded();
  }

  toggleReassign(chatId: string, event: Event) {
    event.stopPropagation();
    this.reassigningChatId.update(id => (id === chatId ? null : chatId));
  }

  async onReassign(chat: Chat, newProjectId: string | null) {
    await this.chatService.reassignChat(chat.id, newProjectId);
    this.reassigningChatId.set(null);
  }

  async unassignChat(chat: Chat, event: Event) {
    event.stopPropagation();
    if (chat.projectId == null) return;
    await this.chatService.reassignChat(chat.id, null);
  }

  otherProjects(currentProjectId: string | null): Project[] {
    return this.filteredProjects().filter(p => p.id !== currentProjectId);
  }

  async createChatForProject(project: Project, event?: Event) {
    event?.stopPropagation();

    const title = this.i18n.t('sidebar.newChatTitle', { name: project.name });
    const chat = await this.chatService.createChat(title, project.id);

    const drafts = buildSeedNodeDrafts({
      project,
      topics: this.topics(),
      getPersona: id => this.personaService.getPersona(id),
      currentUserPersona: this.currentPersona()
    });

    let currentParentNodeId: string | null = null;
    for (const draft of drafts) {
      const created = await this.chatService.addNode(chat.id, {
        parentId: currentParentNodeId,
        role: draft.role,
        content: draft.content
      });
      currentParentNodeId = created.id;
    }

    if (project.defaultModelId) {
      this.lastModelService.setSelectedModel(project.defaultModelId);
      this.lastModelService.saveLastUsedModel(project.defaultModelId);
    } else if (this.lastModelService.lastUsedModelId()) {
      this.lastModelService.setLastModel(this.lastModelService.lastUsedModelId());
    } else {
      this.lastModelService.setSelectedModel('');
    }

    if (!this.isExpanded(project.id)) {
      this.toggleExpanded(project.id);
    }
    await this.chatService.selectChat(chat.id);
  }

  async selectChat(chat: Chat) {
    await this.chatService.selectChat(chat.id);
    this.lastModelService.setLastUsedModel();

    const projectKey = chat.projectId ?? '__unassigned__';
    if (!this.isExpanded(projectKey)) {
      this.expanded.update(m => ({ ...m, [projectKey]: true }));
      this.persistExpanded();
    }
    this.scrollToActiveChat();
  }

  private scrollToActiveChat() {
    setTimeout(() => {
      const active = document.querySelector('.chat-item.active');
      active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 50);
  }

  async cloneChat(chat: Chat, event: Event) {
    event.stopPropagation();
    try {
      const copy = await this.chatService.cloneChat(chat.id);
      const projectKey = copy.projectId ?? '__unassigned__';
      if (!this.isExpanded(projectKey)) {
        this.expanded.update(m => ({ ...m, [projectKey]: true }));
        this.persistExpanded();
      }
      await this.selectChat(copy);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('sidebar.cloneFailed', { error: err?.message || err }));
    }
  }

  async deleteChat(chat: Chat, event: Event) {
    event.stopPropagation();
    const ok = await this.confirm.ask({
      title: this.i18n.t('sidebar.deleteStoryTitle'),
      message: this.i18n.t('sidebar.deleteStoryMsg', { title: chat.title }),
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;
    await this.chatService.deleteChat(chat.id);
  }

  collapseAll(event?: Event) {
    event?.stopPropagation();
    const next: Record<string, boolean> = {};
    for (const p of this.projects()) {
      next[p.id] = false;
    }
    this.expanded.set(next);
    this.persistExpanded();
  }

  getChatsForProject(projectId: string | null): Chat[] {
    const q = this.searchQuery().trim().toLowerCase();
    let chats = this.chatsByProject().get(projectId) || [];
    if (q) chats = chats.filter(c => this.chatMatchesQuery(c, q));
    return [...chats].sort((a, b) => {
      const ta = new Date(a.updated_at || a.created_at).getTime();
      const tb = new Date(b.updated_at || b.created_at).getTime();
      return tb - ta;
    });
  }

  getChatCount(projectId: string | null): number {
    return this.getChatsForProject(projectId).length;
  }

  formatWhen(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return this.i18n.formatDate(date, { dateStyle: 'short', timeStyle: 'short' });
  }

  modelLabel(id: string | null | undefined): string {
    if (!id) return this.i18n.t('common.none');
    const model = this.enabledModels().find(m => m.id === id || m.modelId === id);
    return model?.displayName || id;
  }

  projectTooltip(project: Project): string {
    const chats = this.getChatCount(project.id);
    return [
      project.name,
      this.i18n.t(chats === 1 ? 'sidebar.storiesCountOne' : 'sidebar.storiesCountMany', { count: chats }),
      this.i18n.t('sidebar.created', { when: this.formatWhen(project.createdAt) }),
      this.i18n.t('sidebar.updated', { when: this.formatWhen(project.updatedAt) }),
      this.i18n.t('sidebar.defaultModel', { model: this.modelLabel(project.defaultModelId) })
    ].join('\n');
  }

  chatTooltip(chat: Chat): string {
    const beats = chat.node_number ?? 0;
    return [
      chat.title || this.i18n.t('sidebar.untitledStory'),
      this.i18n.t(beats === 1 ? 'sidebar.beatsOne' : 'sidebar.beatsMany', { count: beats }),
      this.i18n.t('sidebar.created', { when: this.formatWhen(chat.created_at) }),
      this.i18n.t('sidebar.updated', { when: this.formatWhen(chat.updated_at) })
    ].join('\n');
  }

  isCurrentProject(projectId: string | null): boolean {
    return this.currentProjectId() === (projectId || null);
  }

  getAnswerCount(_chat: Chat): number {
    return 2;
  }

  async goToPersonas() {
    await this.router.navigate(['/personas']);
  }
}
