import {Component, inject, signal, OnInit, computed} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { Router } from '@angular/router';
import { LastModelService } from '../../core/last-model.service';
import { SettingsService } from '../../core/settings.service';
import { Chat, Project } from '../../models/chat';
import {CHAT_API} from '../../api/chat-api.token';

const LS_EXPANDED_KEY = 'chat-client.projects.expanded';
const LS_TOPIC = 'chat.selectedTopicId';

@Component({
  selector: 'side-bar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './side-bar.component.html',
  styleUrls: ['./side-bar.component.css']
})
export class SideBarComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly router = inject(Router);
  private readonly api = inject(CHAT_API);

  readonly projects = this.chatService.projects;
  readonly currentChatId = this.chatService.currentChatId;
  readonly chatsByProject = this.chatService.chatsByProject;
  readonly enabledModels = this.settings.enabledModels;
  readonly searchQuery = signal('');
  readonly currentPersona = this.chatService.currentPersona;
  // ---------- Topic filter ----------
  readonly topics = this.chatService.topics;

  /** projectId → expanded (persisted in localStorage) */
  readonly expanded = signal<Record<string, boolean>>({});

  // --- Inline edit project ---
  readonly editingProjectId = signal<string | null>(null);
  readonly editName = signal('');
  readonly editSystemPrompt = signal('');
  readonly editDefaultModelId = signal<string | null>(null);
  /** true = youngest (most recently updated) on top */
  readonly sortByNewest = signal(true);

  /** which chat is currently showing the reassign dropdown */
  readonly reassigningChatId = signal<string | null>(null);

  /** 'all' | topic-id */
  readonly selectedTopicId = signal<string>(
    localStorage.getItem(LS_TOPIC) || 'all'
  );

  selectTopicFilter(id: string) {
    const value = id || 'all';
    this.selectedTopicId.set(value);
    localStorage.setItem(LS_TOPIC, value);
  }

// replace the existing filteredProjects computed with this version
  filteredProjects = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const topicId = this.selectedTopicId();
    let list = this.projects();

    // 1. Topic filter
    if (topicId && topicId !== 'all') {
      const topic = this.topics().find(t => t.id === topicId);
      if (topic) {
        const idSet = new Set(topic.projectIds);
        list = list.filter(p => idSet.has(p.id));
      }
    }

    // 2. Text filter
    if (q) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        this.getChatsForProject(p.id).some(c => c.title.toLowerCase().includes(q))
      );
    }

    // 3. Sort
    if (this.sortByNewest()) {
      list = [...list].sort((a, b) => {
        const ta = new Date(a.updatedAt || a.createdAt).getTime();
        const tb = new Date(b.updatedAt || b.createdAt).getTime();
        return tb - ta;
      });
    } else {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    }

    return list;
  });

  async ngOnInit() {
    await Promise.all([
      this.chatService.loadProjects(),
      this.chatService.loadChats(),
      this.chatService.loadPersonas(),
      this.chatService.loadTopics(),
      this.settings.loadAll()
    ]);
    this.loadExpandedState();
    this.scrollToActiveChat();
  }

  // ---------- Expand / collapse (localStorage) ----------

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
    // default = true (expanded) unless explicitly set to false
    return this.expanded()[projectId] !== false;
  }

  toggleExpanded(projectId: string, event?: Event) {
    event?.stopPropagation();
    this.expanded.update(m => ({
      ...m,
      [projectId]: !this.isExpanded(projectId)
    }));
    this.persistExpanded();
  }

  toggleSortByNewest(event?: Event) {
    event?.stopPropagation();
    this.sortByNewest.update(v => !v);
  }

  // ---------- Project CRUD ----------

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

  startEditProject(project: Project, event?: Event) {
    event?.stopPropagation();
    this.editingProjectId.set(project.id);
    this.editName.set(project.name);
    this.editSystemPrompt.set(project.systemPrompt || '');
    this.editDefaultModelId.set(project.defaultModelId);
  }

  cancelEditProject() {
    this.editingProjectId.set(null);
  }

  async saveProject() {
    const id = this.editingProjectId();
    if (!id) return;
    const name = this.editName().trim();
    if (!name) return;

    await this.chatService.updateProject(id, {
      name,
      systemPrompt: this.editSystemPrompt(),
      defaultModelId: this.editDefaultModelId()
    });
    this.editingProjectId.set(null);
  }

  async deleteProject(project: Project, event: Event) {
    event.stopPropagation();

    const chatCount = this.getChatsForProject(project.id).length;

    const msg = chatCount === 0
      ? `Delete project “${project.name}”?`
      : `Project “${project.name}” contains ${chatCount} chat(s).\n\n` +
      `OK = delete project AND all its chats\n` +
      `Cancel = abort`;

    if (!confirm(msg)) return;

    // if there are chats we treat “OK” as cascade-delete
    const deleteChats = chatCount > 0;
    await this.chatService.deleteProject(project.id, deleteChats);

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
    if (chat.projectId == null) return;           // already unassigned
    await this.chatService.reassignChat(chat.id, null);
  }

  /** projects for the dropdown (current project excluded) */
  otherProjects(currentProjectId: string | null): Project[] {
    return this.filteredProjects().filter(p => p.id !== currentProjectId);
    // return this.projects().filter(p => p.id !== currentProjectId);
  }



  // ---------- Chats under a project ----------

  async createChatForProject(project: Project, event?: Event) {
    event?.stopPropagation();

    // Title is initialized (user can change it later via the title editor)
    const title = `${project.name} – New Chat`;
    const chat = await this.chatService.createChat(title, project.id);
    // await this.chatService.selectChat(chat.id);

    // ---------- 1. Build System-node content ----------
    const parts: string[] = [];

    this.topics()
      .filter(t => t.defaultSystemPrompt?.trim() && t.projectIds.find(id => id == project.id) )
      .every(t => parts.push(t.defaultSystemPrompt.trim()));

    // Project system prompt
    if (project.systemPrompt?.trim()) {
      parts.push(project.systemPrompt.trim());
    }

    // Every persona that belongs to the project → NPC
    for (const personaId of project.personaIds ?? []) {
      const persona = this.chatService.getPersona(personaId);
      if (persona) {
        parts.push(`npc is ${persona.name}`);
        if (persona.description?.trim()) {
          parts.push(persona.description.trim());
        }
      }
    }

    // Currently selected persona → {{user}}
    const userPersona = this.currentPersona();
    if (userPersona) {
      parts.push(`{{user}} is ${userPersona.name}`);
      if (userPersona.description?.trim()) {
        parts.push(userPersona.description.trim());
      }
    }

    const systemContent = parts.join('\n\n').trim();

    // ---------- 2. Create the System node (root question) ----------
    let systemNodeId: string | null = null;

    if (systemContent) {
      const systemNode = await this.chatService.addNode(chat.id, {
        parentId: null,
        type: 'question',
        content: systemContent
      });
      systemNodeId = systemNode.id;
    }

    // ---------- 3. Optional greeting → first answer node ----------
    if (project.greeting?.trim()) {
      const greetingContent = `Situation:\n${project.greeting.trim()}`;

      await this.chatService.addNode(chat.id, {
        parentId: systemNodeId,          // child of System node when present
        type: 'answer',
        content: greetingContent
      });
    }

    // ---------- 4. Apply project's default model (unchanged) ----------
    if (project.defaultModelId) {
      this.lastModelService.setSelectedModel(project.defaultModelId);
      this.lastModelService.saveLastUsedModel(project.defaultModelId);
    } else if (this.lastModelService.lastUsedModelId()) {
      this.lastModelService.setLastModel(this.lastModelService.lastUsedModelId());
    } else {
      this.lastModelService.setSelectedModel('');
    }

    // Make sure the project is visible
    if (!this.isExpanded(project.id)) {
      this.toggleExpanded(project.id);
    }
    await this.chatService.selectChat(chat.id);
  }

  async selectChat(chat: Chat) {
    await this.chatService.selectChat(chat.id);
    this.lastModelService.setLastUsedModel();

    // Auto-expand the project so the active chat is visible
    const projectKey = chat.projectId ?? '__unassigned__';
    if (!this.isExpanded(projectKey)) {
      this.expanded.update(m => ({ ...m, [projectKey]: true }));
      this.persistExpanded();
    }
    // this.chatService.currentChatId.(chat.id)
    this.scrollToActiveChat();
  }

  // Add this method
  private scrollToActiveChat() {
    setTimeout(() => {
      const active = document.querySelector('.chat-item.active');
      active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 50);
  }


  async deleteChat(chat: Chat, event: Event) {
    event.stopPropagation();
    if (confirm(`Delete chat "${chat.title}"?`)) {
      await this.chatService.deleteChat(chat.id);
    }
  }

  collapseAll(event?: Event) {
    event?.stopPropagation();

    const next: Record<string, boolean> = {};
    for (const p of this.projects()) {
      next[p.id] = false;          // false = collapsed
    }
    this.expanded.set(next);
    this.persistExpanded();
  }

  /** Chats of a project, optionally sorted by age */
  getChatsForProject(projectId: string | null): Chat[] {
    const chats = this.chatsByProject().get(projectId) || [];

    if (!this.sortByNewest()) {
      return chats;
    }

    return [...chats].sort((a, b) => {
      const ta = new Date(a.updated_at || a.created_at).getTime();
      const tb = new Date(b.updated_at || b.created_at).getTime();
      return tb - ta;          // youngest first
    });
  }

  getChatCount(projectId: string | null): number {
    return this.getChatsForProject(projectId).length;
  }

  isCurrentProject(projectId: string | null): boolean {
    const chatId = this.currentChatId();
    if (!chatId) return false;
    const chat = this.chatService.chats().find(c => c.id === chatId);
    if (!chat) return false;
    return (chat.projectId || null) === (projectId || null);
  }

  getAnswerCount(chat: Chat): number {
    // let nodes = await this.api.getNodes(chat.id);
    return 2; // nodes.filter(n => n.type == "answer").length;
  }


  async goToPersonas() {
    this.router.navigate(['/personas']);
  }

}
